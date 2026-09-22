import { clamp, lerp, smoothstep, type Rect } from '../core/math.ts';
import { Rng } from '../core/rng.ts';
import { Arena, BLOCK_MAX_HP, CELL, GRID_H, GRID_W, SPAWNS, type LayoutTuning } from './arena.ts';
import { WEAPONS, rollWeapon, type WeaponId } from './weapons.ts';
import { WORLD_H, WORLD_W } from '../view/viewport.ts';

/**
 * The simulation is headless and deterministic: same seed plus same inputs
 * gives the same result on any machine. Nothing in here may touch Math.random,
 * performance.now, or the DOM, because in multiplayer the host runs this and
 * ships the result to the guest, and in single player the exact same class
 * runs with an AI filling the second input slot.
 */

export const TUNING = {
  playerRadius: 15,
  playerSpeed: 260,
  playerMaxHp: 5,

  hitFlash: 0.22,
  /** Brief window after being hit where you cannot be hit again. */
  invulnerable: 0.25,
  knockbackDecay: 9,

  /** Odds a broken block coughs up a weapon, at full health. */
  dropChance: 0.28,
  /** Added per point of health the breaker is missing: a gentle comeback. */
  dropChancePerMissingHp: 0.03,
  pickupRadius: 13,

  zoneMin: 0.3,
  zoneSeconds: 45,
  /** Beats playerSpeed on purpose: the closing edge cannot be outrun. */
  zonePull: 380,
} as const;

export interface PlayerInput {
  /** Movement in WORLD space, already un-rotated by the view. Length <= 1. */
  moveX: number;
  moveY: number;
  /** Aim angle in world space, radians. */
  aim: number;
  attack: boolean;
}

/** Drop odds for a block broken by someone on `hp` health. */
export function dropChanceAt(hp: number): number {
  const missing = Math.max(0, TUNING.playerMaxHp - hp);
  return TUNING.dropChance + missing * TUNING.dropChancePerMissingHp;
}

export const IDLE_INPUT: PlayerInput = { moveX: 0, moveY: 0, aim: 0, attack: false };

export interface PlayerState {
  seat: 0 | 1;
  x: number;
  y: number;
  aim: number;
  hp: number;
  alive: boolean;
  /** Knockback velocity; movement input is added on top. */
  vx: number;
  vy: number;
  weapon: WeaponId;
  /** Attacks left on the current weapon. -1 while bare-handed. */
  uses: number;
  cooldown: number;
  /** Seconds since the current swing started, or -1 when idle. */
  swingT: number;
  swingAim: number;
  swingHit: boolean;
  /** Locked at swing start so a weapon breaking mid-swing still resolves. */
  swingWeapon: WeaponId;
  hitFlash: number;
  invuln: number;
}

export interface Pickup {
  id: number;
  weapon: WeaponId;
  x: number;
  y: number;
}

export interface Projectile {
  id: number;
  owner: 0 | 1;
  weapon: WeaponId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

export type SimEvent =
  | { type: 'swing'; seat: 0 | 1; x: number; y: number; aim: number; weapon: WeaponId }
  | { type: 'blockHit'; gx: number; gy: number; hp: number; aim: number }
  | { type: 'blockBreak'; gx: number; gy: number; aim: number }
  | { type: 'playerHit'; seat: 0 | 1; x: number; y: number; aim: number; hp: number }
  | { type: 'death'; seat: 0 | 1; x: number; y: number }
  | { type: 'drop'; x: number; y: number; weapon: WeaponId }
  | { type: 'pickup'; seat: 0 | 1; x: number; y: number; weapon: WeaponId }
  | { type: 'pickupLost'; x: number; y: number; weapon: WeaponId }
  | { type: 'shot'; seat: 0 | 1; x: number; y: number; aim: number; weapon: WeaponId }
  | { type: 'blast'; x: number; y: number; radius: number; weapon: WeaponId };

export type MatchPhase = 'playing' | 'over';

function makePlayer(seat: 0 | 1): PlayerState {
  return {
    seat,
    x: SPAWNS[seat].x,
    y: SPAWNS[seat].y,
    // Both players start facing their opponent, which is "screen forward" on
    // either client thanks to the per-seat view rotation.
    aim: seat === 0 ? 0 : Math.PI,
    hp: TUNING.playerMaxHp,
    alive: true,
    vx: 0,
    vy: 0,
    weapon: 'fist',
    uses: -1,
    cooldown: 0,
    swingT: -1,
    swingAim: 0,
    swingHit: false,
    swingWeapon: 'fist',
    hitFlash: 0,
    invuln: 0,
  };
}

export class Sim {
  readonly arena: Arena;
  readonly players: [PlayerState, PlayerState];
  pickups: Pickup[] = [];
  projectiles: Projectile[] = [];

  /** Ticks elapsed. The network protocol indexes inputs by this. */
  tick = 0;
  elapsed = 0;
  zoneT = 0;
  zoneRunning = true;
  phase: MatchPhase = 'playing';
  winner: 0 | 1 | null = null;

  /** Render-only feed. Drained every frame; never read back by the sim. */
  events: SimEvent[] = [];

  /**
   * Drives loot only. Blocks break in a fixed order for a given set of inputs,
   * so both peers draw the same weapons from the same stream.
   */
  private rng: Rng;
  private nextId = 1;
  /** Cell bounds already ground away by the closing edge. */
  private ground = { gx0: 0, gy0: 0, gx1: GRID_W - 1, gy1: GRID_H - 1 };

  constructor(seed: number, layout?: LayoutTuning) {
    this.arena = layout ? new Arena(seed, layout) : new Arena(seed);
    this.players = [makePlayer(0), makePlayer(1)];
    this.rng = new Rng((seed ^ 0x10ad) >>> 0);
  }

  /** The zone scales about the arena centre so both seats stay equidistant. */
  zone(): Rect {
    const k = lerp(1, TUNING.zoneMin, smoothstep(this.zoneT));
    return { cx: WORLD_W / 2, cy: WORLD_H / 2, w: WORLD_W * k, h: WORLD_H * k };
  }

  step(dt: number, inputs: readonly [PlayerInput, PlayerInput]): void {
    this.tick++;
    this.elapsed += dt;

    this.advanceZone(dt);

    for (let i = 0; i < 2; i++) {
      const p = this.players[i]!;
      if (!p.alive) continue;
      this.stepPlayer(p, inputs[i]!, dt);
    }

    // Attacks resolve after every player has moved, so a trade lands for both
    // sides instead of depending on array order.
    for (let i = 0; i < 2; i++) {
      const p = this.players[i]!;
      if (p.alive && p.swingT >= 0 && !p.swingHit && p.swingT >= WEAPONS[p.swingWeapon].windup) {
        p.swingHit = true;
        const def = WEAPONS[p.swingWeapon];
        if (def.kind === 'throw') this.launch(p, def.id);
        else this.resolveSwing(p, def.id);
      }
    }

    this.stepProjectiles(dt);
    this.collectPickups();
    this.grindBlocks();
    this.cullOutsideZone();

    for (const p of this.players) {
      if (p.alive && p.hp <= 0) {
        p.alive = false;
        this.events.push({ type: 'death', seat: p.seat, x: p.x, y: p.y });
      }
    }

    if (this.phase === 'playing') {
      const dead = this.players.filter((p) => !p.alive);
      if (dead.length > 0) {
        this.phase = 'over';
        this.winner = dead.length === 2 ? null : dead[0]!.seat === 0 ? 1 : 0;
      }
    }
  }

  private stepPlayer(p: PlayerState, input: PlayerInput, dt: number): void {
    p.cooldown = Math.max(0, p.cooldown - dt);
    p.hitFlash = Math.max(0, p.hitFlash - dt);
    p.invuln = Math.max(0, p.invuln - dt);
    if (p.swingT >= 0) {
      p.swingT += dt;
      if (p.swingT > WEAPONS[p.swingWeapon].swing) p.swingT = -1;
    }

    p.aim = input.aim;

    if (input.attack && p.cooldown <= 0 && this.phase === 'playing') {
      const def = WEAPONS[p.weapon];
      p.cooldown = def.cooldown;
      p.swingT = 0;
      p.swingAim = p.aim;
      p.swingHit = false;
      p.swingWeapon = p.weapon;
      this.events.push({
        type: 'swing',
        seat: p.seat,
        x: p.x,
        y: p.y,
        aim: p.aim,
        weapon: def.id,
      });
      // Spend the charge now, but keep swingWeapon so the attack already in
      // flight still lands with the stats it was started with.
      if (p.uses > 0) {
        p.uses--;
        if (p.uses === 0) {
          p.weapon = 'fist';
          p.uses = -1;
        }
      }
    }

    this.movePlayer(p, input, dt);
  }

  /**
   * Position integration, collision and the zone pull -- everything that is a
   * pure function of one player's own input.
   *
   * Split out because the guest replays exactly this, and only this, to
   * predict its own movement between snapshots. Anything with a side effect on
   * the other player or the world stays in stepPlayer, where only the host
   * runs it.
   */
  private movePlayer(p: PlayerState, input: PlayerInput, dt: number): void {
    const len = Math.hypot(input.moveX, input.moveY);
    const nx = len > 1 ? input.moveX / len : input.moveX;
    const ny = len > 1 ? input.moveY / len : input.moveY;
    p.x += (nx * TUNING.playerSpeed + p.vx) * dt;
    p.y += (ny * TUNING.playerSpeed + p.vy) * dt;

    const decay = Math.exp(-TUNING.knockbackDecay * dt);
    p.vx *= decay;
    p.vy *= decay;

    this.collideWithBlocks(p);
    this.pullIntoZone(p, dt);

    p.x = clamp(p.x, TUNING.playerRadius, WORLD_W - TUNING.playerRadius);
    p.y = clamp(p.y, TUNING.playerRadius, WORLD_H - TUNING.playerRadius);
  }

  /** Client-side prediction of your own movement. No combat, no events. */
  predictMovement(seat: 0 | 1, input: PlayerInput, dt: number): void {
    const p = this.players[seat];
    if (!p.alive) return;
    p.aim = input.aim;
    this.movePlayer(p, input, dt);
  }

  /** Keeps the guest's camera moving smoothly between 20Hz snapshots. */
  advanceZone(dt: number): void {
    if (this.phase !== 'playing' || !this.zoneRunning) return;
    this.zoneT = Math.min(1, this.zoneT + dt / TUNING.zoneSeconds);
    this.grindBlocks();
  }

  /**
   * Circle against solid grid cells.
   *
   * Each cell only pushes along faces that are actually exposed. Without that
   * check a circle sliding along a wall snags on the seams between cells,
   * because an interior corner shared by two blocks would shove it outward
   * diagonally.
   */
  private collideWithBlocks(p: PlayerState): void {
    const r = TUNING.playerRadius;
    const arena = this.arena;

    for (let iter = 0; iter < 3; iter++) {
      let corrected = false;

      const gx0 = Math.max(0, Math.floor((p.x - r) / CELL));
      const gx1 = Math.min(GRID_W - 1, Math.floor((p.x + r) / CELL));
      const gy0 = Math.max(0, Math.floor((p.y - r) / CELL));
      const gy1 = Math.min(GRID_H - 1, Math.floor((p.y + r) / CELL));

      for (let gy = gy0; gy <= gy1; gy++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          if (arena.hpAt(gx, gy) <= 0) continue;

          const minX = gx * CELL;
          const minY = gy * CELL;
          const maxX = minX + CELL;
          const maxY = minY + CELL;

          // Inclusive on purpose. A player sitting exactly on the seam between
          // two stacked cells is touching a face, not a corner -- with strict
          // bounds both cells classify it as a corner contact, each defers to
          // the other as the occluding neighbour, and nobody pushes back, so
          // the player strolls through solid wall.
          const insideX = p.x >= minX && p.x <= maxX;
          const insideY = p.y >= minY && p.y <= maxY;

          if (insideX && insideY) {
            // Centre is buried in the cell: eject through the nearest exposed face.
            const outs: Array<[number, number, number, number]> = [
              [p.x - minX, -1, 0, minX - r],
              [maxX - p.x, 1, 0, maxX + r],
              [p.y - minY, 0, -1, minY - r],
              [maxY - p.y, 0, 1, maxY + r],
            ];
            outs.sort((a, b) => a[0] - b[0]);
            for (const [, sx, sy, target] of outs) {
              if (arena.hpAt(gx + sx, gy + sy) > 0) continue;
              if (sx !== 0) p.x = target;
              else p.y = target;
              corrected = true;
              break;
            }
            continue;
          }

          const closestX = clamp(p.x, minX, maxX);
          const closestY = clamp(p.y, minY, maxY);
          const dx = p.x - closestX;
          const dy = p.y - closestY;
          const d2 = dx * dx + dy * dy;
          if (d2 >= r * r) continue;

          if (insideX) {
            const sy = dy < 0 ? -1 : 1;
            if (arena.hpAt(gx, gy + sy) > 0) continue;
            p.y = sy < 0 ? minY - r : maxY + r;
          } else if (insideY) {
            const sx = dx < 0 ? -1 : 1;
            if (arena.hpAt(gx + sx, gy) > 0) continue;
            p.x = sx < 0 ? minX - r : maxX + r;
          } else {
            // Corner: skip if either neighbour is solid, its face handles it.
            const sx = dx < 0 ? -1 : 1;
            const sy = dy < 0 ? -1 : 1;
            if (arena.hpAt(gx + sx, gy) > 0 || arena.hpAt(gx, gy + sy) > 0) continue;
            const d = Math.sqrt(d2);
            if (d < 1e-6) continue;
            const push = r - d;
            p.x += (dx / d) * push;
            p.y += (dy / d) * push;
          }
          corrected = true;
        }
      }

      if (!corrected) break;
    }
  }

  private pullIntoZone(p: PlayerState, dt: number): void {
    const z = this.zone();
    const r = TUNING.playerRadius;
    const insideX = clamp(p.x, z.cx - z.w / 2 + r, z.cx + z.w / 2 - r);
    const insideY = clamp(p.y, z.cy - z.h / 2 + r, z.cy + z.h / 2 - r);
    const offX = insideX - p.x;
    const offY = insideY - p.y;
    const off = Math.hypot(offX, offY);
    if (off <= 0) return;
    const stepLen = Math.min(off, TUNING.zonePull * dt);
    p.x += (offX / off) * stepLen;
    p.y += (offY / off) * stepLen;
  }

  // --- melee ----------------------------------------------------------------

  /** True when `target` lies inside the swing wedge centred on `swingAim`. */
  private inArc(p: PlayerState, tx: number, ty: number, pad: number, id: WeaponId): boolean {
    const def = WEAPONS[id];
    const dx = tx - p.x;
    const dy = ty - p.y;
    const dist = Math.hypot(dx, dy);
    if (dist > def.range + pad) return false;
    if (dist < 1e-6) return true;
    let delta = Math.atan2(dy, dx) - p.swingAim;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    return Math.abs(delta) <= def.arc;
  }

  private resolveSwing(p: PlayerState, id: WeaponId): void {
    const def = WEAPONS[id];
    const reach = def.range;

    const gx0 = Math.max(0, Math.floor((p.x - reach) / CELL));
    const gx1 = Math.min(GRID_W - 1, Math.floor((p.x + reach) / CELL));
    const gy0 = Math.max(0, Math.floor((p.y - reach) / CELL));
    const gy1 = Math.min(GRID_H - 1, Math.floor((p.y + reach) / CELL));

    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        if (this.arena.hpAt(gx, gy) <= 0) continue;
        // Aim at the nearest point of the cell, not its centre, so a swing
        // grazing the edge of a block still connects.
        const cx = clamp(p.x, gx * CELL, gx * CELL + CELL);
        const cy = clamp(p.y, gy * CELL, gy * CELL + CELL);
        if (!this.inArc(p, cx, cy, 0, id)) continue;
        this.damageBlock(gx, gy, def.blockDamage, p.swingAim, p.seat);
      }
    }

    const other = this.players[p.seat === 0 ? 1 : 0];
    if (!other.alive || other.invuln > 0) return;
    if (!this.inArc(p, other.x, other.y, TUNING.playerRadius, id)) return;
    this.hurtPlayer(other, def.playerDamage, p.x, p.y, def.knockback);
  }

  // --- projectiles ----------------------------------------------------------

  private launch(p: PlayerState, id: WeaponId): void {
    const def = WEAPONS[id];
    const proj = def.projectile;
    if (!proj) return;
    // Start clear of the thrower so it cannot detonate inside their own hitbox.
    const off = TUNING.playerRadius + proj.radius + 2;
    this.projectiles.push({
      id: this.nextId++,
      owner: p.seat,
      weapon: id,
      x: p.x + Math.cos(p.swingAim) * off,
      y: p.y + Math.sin(p.swingAim) * off,
      vx: Math.cos(p.swingAim) * proj.speed,
      vy: Math.sin(p.swingAim) * proj.speed,
      life: proj.life,
    });
    this.events.push({
      type: 'shot',
      seat: p.seat,
      x: p.x,
      y: p.y,
      aim: p.swingAim,
      weapon: id,
    });
  }

  private stepProjectiles(dt: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i]!;
      const def = WEAPONS[pr.weapon];
      const shape = def.projectile!;

      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      pr.life -= dt;

      let hit = false;
      const target = this.players[pr.owner === 0 ? 1 : 0];

      if (
        target.alive &&
        target.invuln <= 0 &&
        Math.hypot(target.x - pr.x, target.y - pr.y) <= shape.radius + TUNING.playerRadius
      ) {
        if (shape.blast <= 0) {
          this.hurtPlayer(target, def.playerDamage, pr.x, pr.y, def.knockback);
        }
        hit = true;
      }

      if (!hit) {
        const gx = Math.floor(pr.x / CELL);
        const gy = Math.floor(pr.y / CELL);
        if (this.arena.hpAt(gx, gy) > 0) {
          if (shape.blast <= 0) {
            this.damageBlock(gx, gy, def.blockDamage, Math.atan2(pr.vy, pr.vx), pr.owner);
          }
          hit = true;
        }
      }

      const outOfBounds =
        pr.x < 0 || pr.y < 0 || pr.x > WORLD_W || pr.y > WORLD_H;

      if (hit || outOfBounds || pr.life <= 0) {
        if (shape.blast > 0) this.explode(pr.x, pr.y, pr.weapon, pr.owner);
        this.projectiles[i] = this.projectiles[this.projectiles.length - 1]!;
        this.projectiles.pop();
      }
    }
  }

  private explode(x: number, y: number, id: WeaponId, owner: 0 | 1): void {
    const def = WEAPONS[id];
    const radius = def.projectile!.blast;
    this.events.push({ type: 'blast', x, y, radius, weapon: id });

    const gx0 = Math.max(0, Math.floor((x - radius) / CELL));
    const gx1 = Math.min(GRID_W - 1, Math.floor((x + radius) / CELL));
    const gy0 = Math.max(0, Math.floor((y - radius) / CELL));
    const gy1 = Math.min(GRID_H - 1, Math.floor((y + radius) / CELL));

    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        if (this.arena.hpAt(gx, gy) <= 0) continue;
        const cx = clamp(x, gx * CELL, gx * CELL + CELL);
        const cy = clamp(y, gy * CELL, gy * CELL + CELL);
        if (Math.hypot(cx - x, cy - y) > radius) continue;
        this.damageBlock(gx, gy, def.blockDamage, Math.atan2(cy - y, cx - x), owner);
      }
    }

    for (const p of this.players) {
      if (!p.alive) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d > radius + TUNING.playerRadius) continue;
      // The thrower is shoved but not hurt. Self-damage would make bombs
      // unusable once the zone forces everyone into the same room, and the
      // knockback alone is enough of a cost (and a mobility trick).
      if (p.seat === owner) {
        const dx = p.x - x;
        const dy = p.y - y;
        const len = Math.hypot(dx, dy) || 1;
        p.vx += (dx / len) * def.knockback;
        p.vy += (dy / len) * def.knockback;
        continue;
      }
      if (p.invuln > 0) continue;
      this.hurtPlayer(p, def.playerDamage, x, y, def.knockback);
    }
  }

  // --- shared damage --------------------------------------------------------

  private damageBlock(
    gx: number,
    gy: number,
    amount: number,
    aim: number,
    by: 0 | 1,
  ): void {
    const i = this.arena.idx(gx, gy);
    const hp = Math.max(0, this.arena.hp[i]! - amount);
    this.arena.hp[i] = hp;
    if (hp > 0) {
      this.events.push({ type: 'blockHit', gx, gy, hp, aim });
      return;
    }
    this.events.push({ type: 'blockBreak', gx, gy, aim });
    this.rollDrop(gx, gy, this.players[by].hp);
  }

  private rollDrop(gx: number, gy: number, breakerHp: number): void {
    // Two draws every break, whether or not it pays out, so the stream stays
    // aligned between peers regardless of the outcome.
    const roll = this.rng.next();
    const which = this.rng.next();
    if (roll >= dropChanceAt(breakerHp)) return;
    const weapon = rollWeapon(which);
    const x = (gx + 0.5) * CELL;
    const y = (gy + 0.5) * CELL;
    this.pickups.push({ id: this.nextId++, weapon, x, y });
    this.events.push({ type: 'drop', x, y, weapon });
  }

  private hurtPlayer(
    target: PlayerState,
    amount: number,
    fromX: number,
    fromY: number,
    knockback: number,
  ): void {
    target.hp = Math.max(0, target.hp - amount);
    target.hitFlash = TUNING.hitFlash;
    target.invuln = TUNING.invulnerable;
    const dx = target.x - fromX;
    const dy = target.y - fromY;
    const d = Math.hypot(dx, dy) || 1;
    target.vx += (dx / d) * knockback;
    target.vy += (dy / d) * knockback;
    this.events.push({
      type: 'playerHit',
      seat: target.seat,
      x: target.x,
      y: target.y,
      aim: Math.atan2(dy, dx),
      hp: target.hp,
    });
  }

  // --- pickups --------------------------------------------------------------

  /**
   * One pickup per player per tick, always the nearest.
   *
   * A bomb can level a dozen blocks at once and leave a heap of loot on the
   * same few tiles. Sweeping the whole heap in a single tick would silently
   * discard everything but the last one the array happened to hold, so which
   * weapon you walked away with would depend on internal ordering.
   */
  private collectPickups(): void {
    const reach = TUNING.playerRadius + TUNING.pickupRadius;
    for (const p of this.players) {
      if (!p.alive) continue;

      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < this.pickups.length; i++) {
        const drop = this.pickups[i]!;
        const d = Math.hypot(p.x - drop.x, p.y - drop.y);
        if (d > reach || d >= bestDist) continue;
        best = i;
        bestDist = d;
      }
      if (best < 0) continue;

      const drop = this.pickups[best]!;
      p.weapon = drop.weapon;
      p.uses = WEAPONS[drop.weapon].uses;
      this.events.push({
        type: 'pickup',
        seat: p.seat,
        x: drop.x,
        y: drop.y,
        weapon: drop.weapon,
      });
      this.pickups[best] = this.pickups[this.pickups.length - 1]!;
      this.pickups.pop();
    }
  }

  /**
   * The closing edge grinds away every block it reaches.
   *
   * Without this a player can be pinned outside the zone forever: the pull
   * shoves them toward the middle, block collision shoves them straight back
   * out, and they stall in the gap -- off camera, since the zone *is* the
   * camera. Clearing the boundary guarantees the pull always has somewhere to
   * put them. Only the newly exposed ring is scanned, not the whole grid.
   */
  private grindBlocks(): void {
    const z = this.zone();
    const gx0 = Math.max(0, Math.ceil((z.cx - z.w / 2) / CELL));
    const gy0 = Math.max(0, Math.ceil((z.cy - z.h / 2) / CELL));
    const gx1 = Math.min(GRID_W - 1, Math.floor((z.cx + z.w / 2) / CELL) - 1);
    const gy1 = Math.min(GRID_H - 1, Math.floor((z.cy + z.h / 2) / CELL) - 1);

    const old = this.ground;
    if (gx0 <= old.gx0 && gy0 <= old.gy0 && gx1 >= old.gx1 && gy1 >= old.gy1) return;

    const wipe = (x0: number, x1: number, y0: number, y1: number) => {
      for (let gy = Math.max(0, y0); gy <= Math.min(GRID_H - 1, y1); gy++) {
        for (let gx = Math.max(0, x0); gx <= Math.min(GRID_W - 1, x1); gx++) {
          this.arena.hp[this.idxOf(gx, gy)] = 0;
        }
      }
    };

    wipe(old.gx0, gx0 - 1, old.gy0, old.gy1);
    wipe(gx1 + 1, old.gx1, old.gy0, old.gy1);
    wipe(gx0, gx1, old.gy0, gy0 - 1);
    wipe(gx0, gx1, gy1 + 1, old.gy1);

    this.ground = { gx0, gy0, gx1, gy1 };
  }

  private idxOf(gx: number, gy: number): number {
    return this.arena.idx(gx, gy);
  }

  /**
   * The closing edge eats whatever it passes over. Leaving loot stranded in
   * unreachable space would mean staring at a weapon you can never collect.
   */
  private cullOutsideZone(): void {
    const z = this.zone();
    const left = z.cx - z.w / 2;
    const right = z.cx + z.w / 2;
    const top = z.cy - z.h / 2;
    const bottom = z.cy + z.h / 2;

    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const d = this.pickups[i]!;
      if (d.x >= left && d.x <= right && d.y >= top && d.y <= bottom) continue;
      this.events.push({ type: 'pickupLost', x: d.x, y: d.y, weapon: d.weapon });
      this.pickups[i] = this.pickups[this.pickups.length - 1]!;
      this.pickups.pop();
    }
  }

  drainEvents(): SimEvent[] {
    if (this.events.length === 0) return [];
    const out = this.events;
    this.events = [];
    return out;
  }
}

export { BLOCK_MAX_HP, CELL, GRID_H, GRID_W, SPAWNS };
