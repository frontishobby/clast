/**
 * Who plays whom, decided with no server and no shared clock.
 *
 * Pairing is a three-step offer / accept / confirm. A plain offer-accept
 * races as soon as more than two people are queueing: two peers can each
 * believe they accepted the same partner, and somebody ends up talking to
 * nobody. Only the proposer's confirm commits the pair, so at most one side
 * can ever be holding a half-finished handshake.
 *
 * Deliberately free of any transport: the messages go out through a callback,
 * which is what lets a whole queue of peers be played out in one process.
 */

export type PairTag = 'offer' | 'accept' | 'confirm' | 'reject';

export type PairState =
  | { s: 'free' }
  | { s: 'offered'; to: string; at: number }
  | { s: 'answered'; to: string; at: number }
  | { s: 'matched'; to: string };

/** A stalled handshake is abandoned rather than blocking the queue forever. */
export const PAIR_TIMEOUT_MS = 6000;
/**
 * How long to wait for a lower-id peer to propose before writing them off.
 *
 * Only the lower id proposes, so a peer whose best candidate is below it just
 * waits -- and waits forever if that candidate is already in a match and will
 * never propose to anyone again. Matched peers do announce themselves, but
 * this covers anyone who joined after the announcement or missed it.
 */
export const WAIT_TIMEOUT_MS = 2000;

export class Pairing {
  state: PairState = { s: 'free' };

  private peers = new Set<string>();
  /** Peers that turned us down or are already playing. */
  private busy = new Set<string>();
  private waitingFor: string | null = null;
  private waitingSince = 0;
  private starvedSince = 0;
  /**
   * Set once a one-sided wait has timed out. From then on we will propose to
   * anyone, not just peers above us, because the ordering rule has clearly
   * failed to produce an offer. Safe because simultaneous offers are broken
   * by the tie-break in receive().
   */
  private fallback = false;

  readonly selfId: string;
  private readonly send: (tag: PairTag, to: string) => void;
  private readonly onMatched: (peerId: string) => void;

  // Written out rather than using constructor parameter properties, which
  // Node's type-stripping loader rejects -- and these tests run under it.
  constructor(
    selfId: string,
    send: (tag: PairTag, to: string) => void,
    onMatched: (peerId: string) => void,
  ) {
    this.selfId = selfId;
    this.send = send;
    this.onMatched = onMatched;
  }

  get matchedWith(): string | null {
    return this.state.s === 'matched' ? this.state.to : null;
  }

  /** True when this peer is the one that must run the host simulation. */
  get isHost(): boolean {
    return this.state.s === 'matched' && this.selfId < this.state.to;
  }

  addPeer(id: string, now = Date.now()): void {
    this.peers.add(id);
    this.propose(now);
  }

  removePeer(id: string): void {
    this.peers.delete(id);
    this.busy.delete(id);
    if (this.state.s !== 'free' && this.state.s !== 'matched' && this.state.to === id) {
      this.state = { s: 'free' };
    }
  }

  /** Smallest peer we have not already been turned down by. */
  private candidate(): string | null {
    let best: string | null = null;
    for (const id of this.peers) {
      if (this.busy.has(id)) continue;
      if (best === null || id < best) best = id;
    }
    return best;
  }

  private propose(now: number): void {
    if (this.state.s !== 'free') return;
    const candidate = this.candidate();
    if (candidate === null) return;
    // Normally only the lower id proposes and the higher id waits, which keeps
    // the common case to a single offer. Once a wait has timed out we stop
    // being polite and offer to anyone.
    if (this.selfId >= candidate && !this.fallback) return;
    this.state = { s: 'offered', to: candidate, at: now };
    this.send('offer', candidate);
  }

  receive(tag: PairTag, from: string, now = Date.now()): void {
    if (this.state.s === 'matched') {
      if (from !== this.state.to) this.send('reject', from);
      return;
    }

    switch (tag) {
      case 'offer':
        // Both of us offered at the same moment. Rather than each rejecting
        // the other and deadlocking, the lower id's offer is the one that
        // stands: they hold, we answer.
        if (this.state.s === 'offered' && this.state.to === from) {
          if (this.selfId < from) return;
          this.state = { s: 'answered', to: from, at: now };
          this.send('accept', from);
          return;
        }
        if (this.state.s !== 'free') {
          this.send('reject', from);
          return;
        }
        this.state = { s: 'answered', to: from, at: now };
        this.send('accept', from);
        break;

      case 'accept':
        if (this.state.s !== 'offered' || this.state.to !== from) {
          this.send('reject', from);
          return;
        }
        this.send('confirm', from);
        this.commit(from);
        break;

      case 'confirm':
        if (this.state.s !== 'answered' || this.state.to !== from) {
          this.send('reject', from);
          return;
        }
        this.commit(from);
        break;

      case 'reject':
        this.busy.add(from);
        if (this.state.s !== 'free' && this.state.to === from) this.state = { s: 'free' };
        this.propose(now);
        break;
    }
  }

  /** Call about once a second: expires stalled handshakes and retries. */
  tick(now = Date.now()): void {
    if (this.state.s === 'offered' || this.state.s === 'answered') {
      if (now - this.state.at > PAIR_TIMEOUT_MS) {
        this.busy.add(this.state.to);
        this.state = { s: 'free' };
        this.propose(now);
      }
      return;
    }
    if (this.state.s !== 'free') return;

    const candidate = this.candidate();
    if (candidate !== null && this.selfId >= candidate && !this.fallback) {
      // We are waiting on them to make the first move. Give up eventually and
      // start offering downward instead of stalling behind a peer that is
      // already in a match and will never propose again.
      if (this.waitingFor !== candidate) {
        this.waitingFor = candidate;
        this.waitingSince = now;
      } else if (now - this.waitingSince >= WAIT_TIMEOUT_MS) {
        this.fallback = true;
        this.waitingFor = null;
      }
    } else {
      this.waitingFor = null;
    }

    // Someone written off a minute ago may have finished their match, so a
    // queue that has genuinely run out of candidates eventually forgets. The
    // delay matters: clearing the moment we run dry would undo the write-off
    // we just made and put us straight back to waiting on the same peer.
    if (this.candidate() === null && this.peers.size > 0 && this.busy.size > 0) {
      if (this.starvedSince === 0) this.starvedSince = now;
      else if (now - this.starvedSince >= WAIT_TIMEOUT_MS * 2) {
        this.busy.clear();
        this.starvedSince = 0;
        this.waitingFor = null;
      }
    } else {
      this.starvedSince = 0;
    }

    this.propose(now);
  }

  private commit(peerId: string): void {
    this.state = { s: 'matched', to: peerId };
    this.waitingFor = null;
    this.fallback = false;
    // Tell everyone else we are taken. Without this, every peer still queueing
    // keeps us as their candidate and stalls until their own timer fires.
    for (const id of this.peers) {
      if (id !== peerId) this.send('reject', id);
    }
    this.onMatched(peerId);
  }
}
