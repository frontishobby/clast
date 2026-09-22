import { DEFAULT_LAYOUT, GRID_H, GRID_W, type LayoutTuning } from '../game/arena.ts';
import { IDLE_INPUT, Sim, type PlayerInput, type PlayerState, type SimEvent } from '../game/sim.ts';
import { PROTOCOL_VERSION, type Link, type NetMessage, type NetPlayer, type Snapshot } from './protocol.ts';

/**
 * Host-authoritative session.
 *
 * The host runs the only real simulation and ships state. The guest predicts
 * its own movement, interpolates the opponent, and takes everything else on
 * faith. No rollback: a 1v1 game this small does not need it, and the failure
 * mode of a bad reconciliation is far worse than 50ms of input latency.
 */

export const SNAPSHOT_HZ = 20;
const SNAPSHOT_DT = 1 / SNAPSHOT_HZ;
/** Full arena resend interval, so any lost delta self-heals. */
const KEYFRAME_EVERY = 40;
/** How long the guest takes to absorb a prediction error, seconds. */
const RECONCILE_TIME = 0.12;
const INPUT_HISTORY = 240;

export type SessionPhase = 'handshake' | 'live' | 'closed';

function toNet(p: PlayerState): NetPlayer {
  return {
    x: p.x,
    y: p.y,
    aim: p.aim,
    hp: p.hp,
    alive: p.alive,
    vx: p.vx,
    vy: p.vy,
    weapon: p.weapon,
    uses: p.uses,
    cooldown: p.cooldown,
    swingT: p.swingT,
    swingAim: p.swingAim,
    swingWeapon: p.swingWeapon,
    invuln: p.invuln,
    hitFlash: p.hitFlash,
  };
}

function applyNet(p: PlayerState, n: NetPlayer): void {
  p.x = n.x;
  p.y = n.y;
  p.aim = n.aim;
  p.hp = n.hp;
  p.alive = n.alive;
  p.vx = n.vx;
  p.vy = n.vy;
  p.weapon = n.weapon;
  p.uses = n.uses;
  p.cooldown = n.cooldown;
  p.swingT = n.swingT;
  p.swingAim = n.swingAim;
  p.swingWeapon = n.swingWeapon;
  p.invuln = n.invuln;
  p.hitFlash = n.hitFlash;
}

export class HostSession {
  readonly isHost = true;
  readonly seat: 0 | 1 = 0;
  readonly sim: Sim;
  phase: SessionPhase = 'handshake';
  closedReason: string | null = null;

  onEvents: ((events: SimEvent[]) => void) | null = null;

  private link: Link;
  private remoteInput: PlayerInput = IDLE_INPUT;
  /** Highest guest tick consumed, echoed back so the guest can reconcile. */
  private ack = -1;
  private sinceSnapshot = 0;
  private snapshotCount = 0;
  /** Arena as of the last snapshot, for computing deltas. */
  private shadow: Uint8Array;
  private pending: SimEvent[] = [];

  constructor(link: Link, seed: number, layout: LayoutTuning = DEFAULT_LAYOUT) {
    this.link = link;
    this.sim = new Sim(seed, layout);
    this.shadow = new Uint8Array(this.sim.arena.hp);

    link.onMessage((msg) => this.receive(msg));
    link.onClose((reason) => {
      this.phase = 'closed';
      this.closedReason = reason;
    });

    link.send({ t: 'hello', v: PROTOCOL_VERSION });
    link.send({ t: 'start', seed, layout, guestSeat: 1 });
    this.phase = 'live';
  }

  private receive(msg: NetMessage): void {
    switch (msg.t) {
      case 'hello':
        // Close through the session, not the link: link.close only notifies
        // the far end, so going straight to it would leave us cheerfully
        // playing on against a peer that has already hung up.
        if (msg.v !== PROTOCOL_VERSION) {
          this.close(`version mismatch: peer is on ${msg.v}, we are on ${PROTOCOL_VERSION}`);
        }
        break;
      case 'input':
        // Jitter can reorder; an older input must never overwrite a newer one.
        if (msg.tick <= this.ack) break;
        this.ack = msg.tick;
        this.remoteInput = msg.i;
        break;
      case 'bye':
        this.phase = 'closed';
        this.closedReason = msg.reason;
        break;
      default:
        break;
    }
  }

  step(dt: number, localInput: PlayerInput): void {
    if (this.phase !== 'live') return;

    const inputs: [PlayerInput, PlayerInput] =
      this.seat === 0 ? [localInput, this.remoteInput] : [this.remoteInput, localInput];
    this.sim.step(dt, inputs);

    const events = this.sim.drainEvents();
    if (events.length > 0) {
      this.pending.push(...events);
      this.onEvents?.(events);
    }

    this.sinceSnapshot += dt;
    if (this.sinceSnapshot >= SNAPSHOT_DT) {
      this.sinceSnapshot = 0;
      this.link.send({ t: 'snap', s: this.buildSnapshot() });
    }
  }

  private buildSnapshot(): Snapshot {
    const keyframe = this.snapshotCount++ % KEYFRAME_EVERY === 0;
    const hp = this.sim.arena.hp;

    const blocks: number[] = [];
    if (keyframe) {
      // Whole grid, so a dropped or mangled delta cannot desync the arena
      // permanently. 576 bytes every two seconds is cheaper than being wrong.
      for (let i = 0; i < hp.length; i++) blocks.push(hp[i]!);
    } else {
      for (let i = 0; i < hp.length; i++) {
        if (hp[i] !== this.shadow[i]) blocks.push(i, hp[i]!);
      }
    }
    this.shadow.set(hp);

    const snap: Snapshot = {
      tick: this.ack,
      players: [toNet(this.sim.players[0]), toNet(this.sim.players[1])],
      pickups: this.sim.pickups.map((d) => ({ ...d })),
      projectiles: this.sim.projectiles.map((p) => ({ ...p })),
      zoneT: this.sim.zoneT,
      phase: this.sim.phase,
      winner: this.sim.winner,
      blocks,
      events: this.pending,
    };
    if (keyframe) (snap as Snapshot & { keyframe: boolean }).keyframe = true;
    this.pending = [];
    return snap;
  }

  close(reason: string): void {
    if (this.phase === 'closed') return;
    this.link.send({ t: 'bye', reason });
    this.link.close(reason);
    this.phase = 'closed';
    this.closedReason = reason;
  }
}

export class GuestSession {
  readonly isHost = false;
  seat: 0 | 1 = 1;
  sim: Sim | null = null;
  phase: SessionPhase = 'handshake';
  closedReason: string | null = null;

  onEvents: ((events: SimEvent[]) => void) | null = null;
  onStart: ((sim: Sim, seat: 0 | 1) => void) | null = null;

  private link: Link;
  private tick = 0;
  private history: Array<{ tick: number; input: PlayerInput; dt: number }> = [];
  /** Residual prediction error, rendered away rather than snapped away. */
  private errX = 0;
  private errY = 0;
  private errT = 0;

  /** Two most recent authoritative opponent states, for interpolation. */
  private remotePrev: NetPlayer | null = null;
  private remoteCurr: NetPlayer | null = null;
  private remoteAge = 0;

  constructor(link: Link) {
    this.link = link;
    link.onMessage((msg) => this.receive(msg));
    link.onClose((reason) => {
      this.phase = 'closed';
      this.closedReason = reason;
    });
    link.send({ t: 'hello', v: PROTOCOL_VERSION });
  }

  private receive(msg: NetMessage): void {
    switch (msg.t) {
      case 'hello':
        // Close through the session, not the link: link.close only notifies
        // the far end, so going straight to it would leave us cheerfully
        // playing on against a peer that has already hung up.
        if (msg.v !== PROTOCOL_VERSION) {
          this.close(`version mismatch: peer is on ${msg.v}, we are on ${PROTOCOL_VERSION}`);
        }
        break;
      case 'start': {
        this.seat = msg.guestSeat;
        this.sim = new Sim(msg.seed, msg.layout);
        this.phase = 'live';
        this.onStart?.(this.sim, this.seat);
        break;
      }
      case 'snap':
        this.applySnapshot(msg.s);
        break;
      case 'bye':
        this.phase = 'closed';
        this.closedReason = msg.reason;
        break;
      default:
        break;
    }
  }

  private applySnapshot(s: Snapshot): void {
    const sim = this.sim;
    if (!sim) return;

    const keyframed = (s as Snapshot & { keyframe?: boolean }).keyframe === true;
    if (keyframed) {
      for (let i = 0; i < s.blocks.length && i < sim.arena.hp.length; i++) {
        sim.arena.hp[i] = s.blocks[i]!;
      }
    } else {
      for (let i = 0; i + 1 < s.blocks.length; i += 2) {
        sim.arena.hp[s.blocks[i]!] = s.blocks[i + 1]!;
      }
    }

    sim.pickups = s.pickups;
    sim.projectiles = s.projectiles;
    sim.zoneT = s.zoneT;
    sim.phase = s.phase;
    sim.winner = s.winner;

    const foeSeat = this.seat === 0 ? 1 : 0;
    this.remotePrev = this.remoteCurr ?? s.players[foeSeat];
    this.remoteCurr = s.players[foeSeat];
    this.remoteAge = 0;

    // Reconcile our own player: take the authoritative state, then replay the
    // inputs the host had not consumed yet. Without the replay we would snap
    // back by however much movement is in flight, every single snapshot.
    const me = sim.players[this.seat];
    const predictedX = me.x;
    const predictedY = me.y;
    applyNet(me, s.players[this.seat]);

    this.history = this.history.filter((h) => h.tick > s.tick);
    for (const h of this.history) sim.predictMovement(this.seat, h.input, h.dt);

    // Any leftover difference is bled off over a few frames instead of
    // teleporting, which is what makes a correction invisible.
    this.errX += predictedX - me.x;
    this.errY += predictedY - me.y;
    this.errT = RECONCILE_TIME;

    if (s.events.length > 0) this.onEvents?.(s.events);
  }

  step(dt: number, localInput: PlayerInput): void {
    const sim = this.sim;
    if (this.phase !== 'live' || !sim) return;

    this.tick++;
    this.link.send({ t: 'input', tick: this.tick, i: localInput });
    this.history.push({ tick: this.tick, input: localInput, dt });
    if (this.history.length > INPUT_HISTORY) this.history.shift();

    sim.predictMovement(this.seat, localInput, dt);
    sim.advanceZone(dt);

    if (this.errT > 0) {
      const decay = Math.max(0, 1 - dt / RECONCILE_TIME);
      this.errX *= decay;
      this.errY *= decay;
      this.errT -= dt;
    }

    this.interpolateOpponent(dt, sim);
  }

  /**
   * The opponent is rendered one snapshot behind, blended between the two most
   * recent authoritative states. Extrapolating instead would look sharper
   * right up until someone changes direction and visibly snaps.
   */
  private interpolateOpponent(dt: number, sim: Sim): void {
    if (!this.remotePrev || !this.remoteCurr) return;
    this.remoteAge += dt;
    const t = Math.min(1, this.remoteAge / SNAPSHOT_DT);
    const foe = sim.players[this.seat === 0 ? 1 : 0];
    const a = this.remotePrev;
    const b = this.remoteCurr;

    applyNet(foe, b);
    foe.x = a.x + (b.x - a.x) * t;
    foe.y = a.y + (b.y - a.y) * t;
    let da = b.aim - a.aim;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    foe.aim = a.aim + da * t;
  }

  /** Render-space offset that hides the last correction. */
  get renderOffset(): { x: number; y: number } {
    return { x: this.errX, y: this.errY };
  }

  close(reason: string): void {
    if (this.phase === 'closed') return;
    this.link.send({ t: 'bye', reason });
    this.link.close(reason);
    this.phase = 'closed';
    this.closedReason = reason;
  }
}

export { GRID_H, GRID_W };
