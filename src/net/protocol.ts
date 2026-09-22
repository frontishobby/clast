import type { LayoutTuning } from '../game/arena.ts';
import type { PlayerInput, Pickup, Projectile, SimEvent, MatchPhase } from '../game/sim.ts';
import type { WeaponId } from '../game/weapons.ts';

export const PROTOCOL_VERSION = 1;

/** Authoritative state of one player, as the host sees it. */
export interface NetPlayer {
  x: number;
  y: number;
  aim: number;
  hp: number;
  alive: boolean;
  vx: number;
  vy: number;
  weapon: WeaponId;
  uses: number;
  cooldown: number;
  swingT: number;
  swingAim: number;
  swingWeapon: WeaponId;
  invuln: number;
  hitFlash: number;
}

export interface Snapshot {
  tick: number;
  players: [NetPlayer, NetPlayer];
  pickups: Pickup[];
  projectiles: Projectile[];
  zoneT: number;
  phase: MatchPhase;
  winner: 0 | 1 | null;
  /**
   * Cells that changed since the previous snapshot, as [index, hp] pairs.
   * Blocks change a few times a second at most, so a delta is a fraction of
   * the 576-cell grid and the whole arena never has to be resent.
   */
  blocks: number[];
  /** Cosmetic only; replayed into the guest's effects. */
  events: SimEvent[];
}

export type NetMessage =
  /** First thing both sides send, so a version mismatch fails loudly. */
  | { t: 'hello'; v: number }
  /** Host only. Everything needed to build an identical world. */
  | { t: 'start'; seed: number; layout: LayoutTuning; guestSeat: 0 | 1 }
  /** Guest only, every tick. */
  | { t: 'input'; tick: number; i: PlayerInput }
  /** Host only, at the snapshot rate. */
  | { t: 'snap'; s: Snapshot }
  | { t: 'rematch' }
  | { t: 'bye'; reason: string };

/**
 * The only thing the session layer knows about the network.
 *
 * Keeping it this narrow is what makes the netcode testable: the real
 * implementation wraps a WebRTC data channel, and the tests run host against
 * guest in one process over a loopback with simulated latency and loss.
 */
export interface Link {
  send(msg: NetMessage): void;
  onMessage(cb: (msg: NetMessage) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(reason: string): void;
}

export interface LoopbackOptions {
  /** One-way delay in milliseconds. */
  latency?: number;
  /** Random extra delay on top, 0..jitter ms. */
  jitter?: number;
  /** 0..1 chance a message is dropped outright. */
  loss?: number;
  random?: () => number;
}

/**
 * A pair of Links wired to each other, driven by an explicit clock.
 *
 * Tests advance time themselves rather than waiting on timers, so a match can
 * be played out over simulated seconds of network conditions in milliseconds.
 */
export class Loopback {
  readonly a: Link;
  readonly b: Link;

  private queue: Array<{ at: number; to: 'a' | 'b'; msg: NetMessage }> = [];
  private handlers: { a?: (m: NetMessage) => void; b?: (m: NetMessage) => void } = {};
  private closers: { a?: (r: string) => void; b?: (r: string) => void } = {};
  private now = 0;
  private opts: Required<LoopbackOptions>;

  constructor(opts: LoopbackOptions = {}) {
    this.opts = {
      latency: opts.latency ?? 0,
      jitter: opts.jitter ?? 0,
      loss: opts.loss ?? 0,
      random: opts.random ?? Math.random,
    };
    this.a = this.makeSide('a', 'b');
    this.b = this.makeSide('b', 'a');
  }

  private makeSide(self: 'a' | 'b', other: 'a' | 'b'): Link {
    return {
      send: (msg) => {
        if (this.opts.loss > 0 && this.opts.random() < this.opts.loss) return;
        const delay = this.opts.latency + this.opts.random() * this.opts.jitter;
        this.queue.push({ at: this.now + delay, to: other, msg });
      },
      onMessage: (cb) => {
        this.handlers[self] = cb;
      },
      onClose: (cb) => {
        this.closers[self] = cb;
      },
      close: (reason) => {
        this.closers[other]?.(reason);
      },
    };
  }

  /** Advance the wire by `ms`, delivering anything that has arrived. */
  advance(ms: number): void {
    this.now += ms;
    // Deliver in arrival order; jitter can legitimately reorder messages.
    const due = this.queue.filter((m) => m.at <= this.now).sort((x, y) => x.at - y.at);
    this.queue = this.queue.filter((m) => m.at > this.now);
    for (const item of due) this.handlers[item.to]?.(item.msg);
  }
}
