import { clamp } from '../core/math.ts';
import { Rng } from '../core/rng.ts';
import { CELL, GRID_H, GRID_W } from '../game/arena.ts';
import { PathFinder, cellCenter, cellOf, cellX, cellY, lineIsClear } from '../game/pathfind.ts';
import { IDLE_INPUT, TUNING, type PlayerInput, type PlayerState, type Sim } from '../game/sim.ts';
import { WEAPONS } from '../game/weapons.ts';

/**
 * The CPU opponent.
 *
 * It is an input source and nothing more: it reads the sim and returns the
 * same PlayerInput a human would produce, so it drops into the exact slot the
 * network fills in multiplayer. It is also deterministic -- seeded rng, no
 * wall-clock reads -- so a match against the CPU replays identically, which is
 * what makes the behaviour testable at all.
 */

export type Difficulty = 'easy' | 'normal' | 'hard';

interface AiProfile {
  /** Seconds of perception lag. Modelled by reading a delayed snapshot. */
  reaction: number;
  /** Amplitude of the steady aim wobble, radians. */
  aimError: number;
  /** Turn rate toward the intended angle, radians/sec. */
  aimSpeed: number;
  /** Seconds between goal decisions. */
  replan: number;
  /** 0..1 willingness to detour for loot. */
  greed: number;
  /** Backs off at or below this hp -- but only while actually behind. */
  retreatHp: number;
  /** Seconds a single retreat lasts before it must commit again. */
  retreatFor: number;
  /** Seconds before it is allowed to retreat again. */
  retreatEvery: number;
  /** 0..1 how much it circles instead of charging. */
  strafe: number;
  /** 0..1 chance per threat of sidestepping an incoming projectile. */
  dodge: number;
}

const PROFILES: Record<Difficulty, AiProfile> = {
  easy: {
    reaction: 0.42,
    aimError: 0.3,
    aimSpeed: 4.5,
    replan: 0.4,
    greed: 0.35,
    retreatHp: 1,
    retreatFor: 1.6,
    retreatEvery: 3.0,
    strafe: 0.15,
    dodge: 0.1,
  },
  normal: {
    reaction: 0.2,
    aimError: 0.13,
    aimSpeed: 9,
    replan: 0.25,
    greed: 0.7,
    retreatHp: 2,
    retreatFor: 1.2,
    retreatEvery: 4.0,
    strafe: 0.5,
    dodge: 0.5,
  },
  hard: {
    reaction: 0.08,
    aimError: 0.045,
    aimSpeed: 16,
    replan: 0.15,
    greed: 1,
    retreatHp: 2,
    retreatFor: 0.9,
    retreatEvery: 5.0,
    strafe: 0.85,
    dodge: 0.9,
  },
};

const HISTORY = 48;

export class Ai {
  readonly seat: 0 | 1;
  readonly difficulty: Difficulty;

  private profile: AiProfile;
  private rng: Rng;
  private finder = new PathFinder();

  private path: number[] = [];
  private replanT = 0;
  private aim = 0;
  private wobblePhase: number;
  private strafeDir: 1 | -1 = 1;
  private strafeT = 0;
  private elapsed = 0;
  private retreatT = 0;
  private retreatCooldown = 0;

  /** Ring buffer of where the opponent has been, for the reaction delay. */
  private histX = new Float64Array(HISTORY);
  private histY = new Float64Array(HISTORY);
  private histHead = 0;
  private histFilled = false;

  constructor(seat: 0 | 1, difficulty: Difficulty = 'normal', seed = 0x5eed) {
    this.seat = seat;
    this.difficulty = difficulty;
    this.profile = PROFILES[difficulty];
    this.rng = new Rng((seed ^ (seat + 1) * 0x9e37) >>> 0);
    this.wobblePhase = this.rng.range(0, Math.PI * 2);
    this.aim = seat === 0 ? 0 : Math.PI;
  }

  sample(sim: Sim, dt: number): PlayerInput {
    const me = sim.players[this.seat];
    const foe = sim.players[this.seat === 0 ? 1 : 0];
    if (!me.alive || sim.phase !== 'playing') return { ...IDLE_INPUT, aim: this.aim };

    this.elapsed += dt;
    this.retreatT = Math.max(0, this.retreatT - dt);
    this.retreatCooldown = Math.max(0, this.retreatCooldown - dt);
    this.observe(foe);

    const seen = this.delayedFoe(dt);
    const def = WEAPONS[me.weapon];
    const dist = Math.hypot(seen.x - me.x, seen.y - me.y);

    this.replanT -= dt;
    if (this.replanT <= 0) {
      this.replanT = this.profile.replan;
      this.plan(sim, me, foe, seen, dist);
    }

    let [mx, my] = this.steer(sim, me, seen, dist, dt);
    [mx, my] = this.avoidProjectiles(sim, me, mx, my);
    [mx, my] = this.stayInZone(sim, me, mx, my);

    const len = Math.hypot(mx, my);
    if (len > 1) {
      mx /= len;
      my /= len;
    }

    const target = this.aimTarget(sim, me, seen, def.id);
    this.turnToward(target, dt);

    return { moveX: mx, moveY: my, aim: this.aim, attack: this.wantsAttack(sim, me, seen, dist) };
  }

  // --- perception -----------------------------------------------------------

  private observe(foe: PlayerState): void {
    this.histX[this.histHead] = foe.x;
    this.histY[this.histHead] = foe.y;
    this.histHead = (this.histHead + 1) % HISTORY;
    if (this.histHead === 0) this.histFilled = true;
  }

  /** Where the opponent was `reaction` seconds ago, plus their apparent drift. */
  private delayedFoe(dt: number): { x: number; y: number; vx: number; vy: number } {
    const back = Math.min(
      this.histFilled ? HISTORY - 1 : this.histHead,
      Math.max(1, Math.round(this.profile.reaction / Math.max(dt, 1e-4))),
    );
    const at = (n: number) => {
      const i = (this.histHead - 1 - n + HISTORY * 2) % HISTORY;
      return { x: this.histX[i]!, y: this.histY[i]! };
    };
    const now = at(back);
    const then = at(Math.min(back + 6, HISTORY - 1));
    const span = Math.max(dt * 6, 1e-4);
    return { x: now.x, y: now.y, vx: (now.x - then.x) / span, vy: (now.y - then.y) / span };
  }

  // --- planning -------------------------------------------------------------

  private plan(
    sim: Sim,
    me: PlayerState,
    foe: PlayerState,
    seen: { x: number; y: number },
    dist: number,
  ): void {
    let goalX = seen.x;
    let goalY = seen.y;

    const loot = this.bestPickup(sim, me);

    // Retreating is a timed burst, and only while genuinely behind.
    //
    // An unconditional "back off when hurt" rule deadlocks: health never comes
    // back, so once both sides drop to the threshold neither will ever close
    // again and the match runs to the clock with nobody landing a hit.
    // Requiring that the opponent be ahead means an even fight at 1hp each is
    // still a fight, and the timer stops any single retreat lasting forever.
    if (this.retreatT <= 0 && this.retreatCooldown <= 0 && dist < 190) {
      if (me.hp <= this.profile.retreatHp && foe.hp > me.hp) {
        this.retreatT = this.profile.retreatFor;
        this.retreatCooldown = this.profile.retreatFor + this.profile.retreatEvery;
      }
    }

    if (loot) {
      goalX = loot.x;
      goalY = loot.y;
    } else if (this.retreatT > 0) {
      const away = Math.atan2(me.y - seen.y, me.x - seen.x);
      goalX = me.x + Math.cos(away) * 260;
      goalY = me.y + Math.sin(away) * 260;
    } else if (dist > 260) {
      // Nobody in reach: go mine cover for weapons rather than jogging at the
      // opponent across an open field. Without this the CPU breaks about one
      // block a match and the whole drop system never appears in single player.
      //
      // Deliberately not gated on how well armed it already is. The closing
      // zone is the stopping condition -- "the opponent is far" cannot stay
      // true -- and cutting farming short collapses the match into an early
      // scrap where difficulty barely separates.
      const block = this.nearestBlock(sim, me);
      if (block) {
        goalX = block[0];
        goalY = block[1];
      }
    }

    const z = sim.zone();
    goalX = clamp(goalX, z.cx - z.w / 2 + CELL, z.cx + z.w / 2 - CELL);
    goalY = clamp(goalY, z.cy - z.h / 2 + CELL, z.cy + z.h / 2 - CELL);

    const [sx, sy] = cellOf(me.x, me.y);
    const [gx, gy] = cellOf(goalX, goalY);
    if (!this.finder.find(sim.arena, sx, sy, gx, gy, this.path)) this.path.length = 0;
  }

  /** The nearest drop that beats what we are holding, discounted by distance. */
  private bestPickup(sim: Sim, me: PlayerState): { x: number; y: number } | null {
    const mine = WEAPONS[me.weapon].aiValue;
    let best: { x: number; y: number } | null = null;
    let bestScore = 0;

    for (const drop of sim.pickups) {
      const gain = WEAPONS[drop.weapon].aiValue - mine;
      if (gain <= 0) continue;
      const d = Math.hypot(drop.x - me.x, drop.y - me.y);
      // Worth roughly one point of value per 12 units of detour.
      const score = gain * this.profile.greed - d / 12;
      if (score <= bestScore) continue;
      bestScore = score;
      best = drop;
    }
    return best;
  }

  /** Nearest standing block inside the zone, as a farming target. */
  private nearestBlock(sim: Sim, me: PlayerState): [number, number] | null {
    const z = sim.zone();
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (let gy = 0; gy < GRID_H; gy++) {
      for (let gx = 0; gx < GRID_W; gx++) {
        if (sim.arena.hpAt(gx, gy) <= 0) continue;
        const cx = (gx + 0.5) * CELL;
        const cy = (gy + 0.5) * CELL;
        if (Math.abs(cx - z.cx) > z.w / 2 || Math.abs(cy - z.cy) > z.h / 2) continue;
        const d = Math.hypot(cx - me.x, cy - me.y);
        if (d >= bestD) continue;
        bestD = d;
        best = [cx, cy];
      }
    }
    return best;
  }

  // --- movement -------------------------------------------------------------

  private steer(
    sim: Sim,
    me: PlayerState,
    seen: { x: number; y: number },
    dist: number,
    dt: number,
  ): [number, number] {
    // Standing off only makes sense with a clear shot.
    //
    // A ranged weapon parked at its preferred distance behind cover will never
    // fire, so it never spends ammo, never falls back to fists, and never
    // closes: the match stalls with both sides idling out of each other's
    // sight. No line of sight means close the distance, whatever is held.
    const hasShot = lineIsClear(sim.arena, me.x, me.y, seen.x, seen.y);
    const standoff = hasShot ? WEAPONS[me.weapon].aiStandoff : 0;

    // Hold the range band when the opponent is the thing we are heading for.
    const chasingFoe = this.path.length === 0 || this.pathEndsNear(seen);
    let mx = 0;
    let my = 0;

    const waypoint = this.nextWaypoint(sim, me);
    if (waypoint) {
      mx = waypoint[0] - me.x;
      my = waypoint[1] - me.y;
      const len = Math.hypot(mx, my) || 1;
      mx /= len;
      my /= len;
    }

    if (chasingFoe) {
      const toFoeX = (seen.x - me.x) / (dist || 1);
      const toFoeY = (seen.y - me.y) / (dist || 1);

      if (dist > standoff * 1.2) {
        mx = mx || toFoeX;
        my = my || toFoeY;
      } else if (dist < standoff * 0.7) {
        mx = -toFoeX;
        my = -toFoeY;
      } else {
        mx = 0;
        my = 0;
      }

      this.strafeT -= dt;
      if (this.strafeT <= 0) {
        this.strafeT = this.rng.range(0.6, 1.6);
        if (this.rng.chance(0.5)) this.strafeDir = this.strafeDir === 1 ? -1 : 1;
      }
      // Circling makes it much harder to lead, and keeps it off the walls.
      mx += -toFoeY * this.strafeDir * this.profile.strafe;
      my += toFoeX * this.strafeDir * this.profile.strafe;
    }

    return [mx, my];
  }

  private pathEndsNear(seen: { x: number; y: number }): boolean {
    const last = this.path[this.path.length - 1];
    if (last === undefined) return true;
    const [cx, cy] = cellCenter(last);
    return Math.hypot(cx - seen.x, cy - seen.y) < CELL * 2;
  }

  /**
   * Walk the path forward while the line of sight stays clear, so the CPU cuts
   * diagonally instead of tracing every cell centre like a Pac-Man ghost.
   */
  private nextWaypoint(sim: Sim, me: PlayerState): [number, number] | null {
    while (this.path.length > 0) {
      const [cx, cy] = cellCenter(this.path[0]!);
      const cell = this.path[0]!;
      const solid = sim.arena.hpAt(cellX(cell), cellY(cell)) > 0;
      if (!solid && Math.hypot(cx - me.x, cy - me.y) < CELL * 0.6) {
        this.path.shift();
        continue;
      }
      break;
    }
    if (this.path.length === 0) return null;

    let chosen = cellCenter(this.path[0]!);
    for (let i = 1; i < Math.min(this.path.length, 5); i++) {
      const cell = this.path[i]!;
      if (sim.arena.hpAt(cellX(cell), cellY(cell)) > 0) break;
      const [cx, cy] = cellCenter(cell);
      if (!lineIsClear(sim.arena, me.x, me.y, cx, cy)) break;
      chosen = [cx, cy];
    }
    return chosen;
  }

  /** Sidestep anything flying at us. */
  private avoidProjectiles(
    sim: Sim,
    me: PlayerState,
    mx: number,
    my: number,
  ): [number, number] {
    if (this.profile.dodge <= 0) return [mx, my];

    for (const pr of sim.projectiles) {
      if (pr.owner === this.seat) continue;
      const dx = me.x - pr.x;
      const dy = me.y - pr.y;
      const speed = Math.hypot(pr.vx, pr.vy) || 1;
      const ahead = (dx * pr.vx + dy * pr.vy) / speed;
      if (ahead <= 0 || ahead > 320) continue;
      // Perpendicular distance from the flight line: how close it will pass.
      const miss = Math.abs(dx * pr.vy - dy * pr.vx) / speed;
      if (miss > TUNING.playerRadius * 3) continue;

      const side = dx * pr.vy - dy * pr.vx >= 0 ? 1 : -1;
      const urgency = this.profile.dodge * (1 - ahead / 320) * 2.2;
      mx += (-pr.vy / speed) * side * urgency;
      my += (pr.vx / speed) * side * urgency;
    }
    return [mx, my];
  }

  private stayInZone(sim: Sim, me: PlayerState, mx: number, my: number): [number, number] {
    const z = sim.zone();
    const margin = TUNING.playerRadius + CELL * 0.8;
    const inX = clamp(me.x, z.cx - z.w / 2 + margin, z.cx + z.w / 2 - margin);
    const inY = clamp(me.y, z.cy - z.h / 2 + margin, z.cy + z.h / 2 - margin);
    const offX = inX - me.x;
    const offY = inY - me.y;
    const off = Math.hypot(offX, offY);
    if (off < 1) return [mx, my];
    // Beyond the margin this overrides everything: being shoved by the edge
    // while trying to fight is how a bot loses to the map instead of a player.
    const urgency = Math.min(2.5, off / 40);
    return [mx + (offX / off) * urgency, my + (offY / off) * urgency];
  }

  // --- aiming and attacking -------------------------------------------------

  private aimTarget(
    sim: Sim,
    me: PlayerState,
    seen: { x: number; y: number; vx: number; vy: number },
    weapon: keyof typeof WEAPONS,
  ): number {
    // Digging through a wall takes priority: aim at the block, not past it.
    const dig = this.digCell(sim, me);
    if (dig) return Math.atan2(dig[1] - me.y, dig[0] - me.x);

    const def = WEAPONS[weapon];
    const proj = def.projectile;
    if (!proj) return Math.atan2(seen.y - me.y, seen.x - me.x);

    // Lead the shot. Two iterations is plenty at these speeds.
    let t = Math.hypot(seen.x - me.x, seen.y - me.y) / proj.speed;
    for (let i = 0; i < 2; i++) {
      const px = seen.x + seen.vx * t;
      const py = seen.y + seen.vy * t;
      t = Math.hypot(px - me.x, py - me.y) / proj.speed;
    }
    return Math.atan2(seen.y + seen.vy * t - me.y, seen.x + seen.vx * t - me.x);
  }

  /** The next block on our path, if it is close enough to hit. */
  private digCell(sim: Sim, me: PlayerState): [number, number] | null {
    const cell = this.path[0];
    if (cell === undefined) return null;
    const gx = cellX(cell);
    const gy = cellY(cell);
    if (sim.arena.hpAt(gx, gy) <= 0) return null;
    const cx = clamp(me.x, gx * CELL, gx * CELL + CELL);
    const cy = clamp(me.y, gy * CELL, gy * CELL + CELL);
    const def = WEAPONS[me.weapon];
    const reach = def.kind === 'melee' ? def.range : CELL * 1.2;
    if (Math.hypot(cx - me.x, cy - me.y) > reach) return null;
    return [cx, cy];
  }

  private turnToward(target: number, dt: number): void {
    const wobble = Math.sin(this.elapsed * 3.1 + this.wobblePhase) * this.profile.aimError;
    let delta = target + wobble - this.aim;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const step = this.profile.aimSpeed * dt;
    this.aim += clamp(delta, -step, step);
  }

  private wantsAttack(
    sim: Sim,
    me: PlayerState,
    seen: { x: number; y: number },
    dist: number,
  ): boolean {
    if (me.cooldown > 0) return false;

    if (this.digCell(sim, me)) return true;

    const def = WEAPONS[me.weapon];
    if (def.kind === 'melee') {
      if (dist > def.range + TUNING.playerRadius) return false;
      // Do not swing at a wall between us.
      if (!lineIsClear(sim.arena, me.x, me.y, seen.x, seen.y)) return false;
      const toFoe = Math.atan2(seen.y - me.y, seen.x - me.x);
      let delta = toFoe - this.aim;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      return Math.abs(delta) <= def.arc * 0.7;
    }

    const proj = def.projectile!;
    if (dist > proj.speed * proj.life * 0.85) return false;
    if (!lineIsClear(sim.arena, me.x, me.y, seen.x, seen.y)) return false;
    // A bomb thrown into someone's face is a wasted charge when a swing would
    // do; hold it until there is room for the blast to matter.
    if (proj.blast > 0 && dist < proj.blast) return false;
    return true;
  }
}
