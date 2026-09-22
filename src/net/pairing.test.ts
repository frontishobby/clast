import assert from 'node:assert/strict';
import test from 'node:test';

import { Rng } from '../core/rng.ts';
import { PAIR_TIMEOUT_MS, Pairing, WAIT_TIMEOUT_MS, type PairTag } from './pairing.ts';

/** A room of peers that can all see each other, with a controllable wire. */
class Queue {
  readonly members = new Map<string, Pairing>();
  readonly matches = new Map<string, string>();
  private inflight: Array<{ tag: PairTag; from: string; to: string; at: number }> = [];
  private now = 0;
  private delay: number;
  private random: () => number;

  constructor(delay = 0, seed = 1) {
    this.delay = delay;
    this.random = new Rng(seed).next.bind(new Rng(seed));
  }

  join(id: string): void {
    const p = new Pairing(
      id,
      (tag, to) => {
        this.inflight.push({ tag, from: id, to, at: this.now + this.delay * this.random() });
      },
      (peer) => this.matches.set(id, peer),
    );
    // Everyone already here learns about the newcomer and vice versa.
    for (const [otherId, other] of this.members) {
      other.addPeer(id, this.now);
      p.addPeer(otherId, this.now);
    }
    this.members.set(id, p);
  }

  leave(id: string): void {
    this.members.delete(id);
    this.matches.delete(id);
    for (const other of this.members.values()) other.removePeer(id);
  }

  advance(ms: number): void {
    this.now += ms;
    const due = this.inflight.filter((m) => m.at <= this.now).sort((a, b) => a.at - b.at);
    this.inflight = this.inflight.filter((m) => m.at > this.now);
    for (const m of due) this.members.get(m.to)?.receive(m.tag, m.from, this.now);
  }

  tickAll(): void {
    for (const p of this.members.values()) p.tick(this.now);
  }

  settle(rounds = 40): void {
    for (let i = 0; i < rounds; i++) {
      this.advance(50);
      this.tickAll();
    }
  }

  /** Nobody may think they are playing someone who disagrees. */
  assertConsistent(): void {
    for (const [id, partner] of this.matches) {
      assert.equal(
        this.matches.get(partner),
        id,
        `${id} thinks it is paired with ${partner}, who thinks it is paired with ${this.matches.get(partner) ?? 'nobody'}`,
      );
    }
  }

  /** Exactly one of a pair must host. */
  assertOneHost(): void {
    const seen = new Set<string>();
    for (const [id, partner] of this.matches) {
      const key = [id, partner].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const a = this.members.get(id)!;
      const b = this.members.get(partner)!;
      assert.notEqual(a.isHost, b.isHost, `${id}/${partner} disagree about who hosts`);
    }
  }
}

test('two peers pair up and agree on who hosts', () => {
  const q = new Queue();
  q.join('bbb');
  q.join('aaa');
  q.settle();

  assert.equal(q.matches.get('aaa'), 'bbb');
  assert.equal(q.matches.get('bbb'), 'aaa');
  q.assertOneHost();
  assert.equal(q.members.get('aaa')!.isHost, true, 'the lower id hosts');
  assert.equal(q.members.get('bbb')!.isHost, false);
});

test('three peers arriving at once leave exactly one waiting', () => {
  // The case a plain offer/accept gets wrong: two peers can both believe they
  // accepted the same partner and one is left talking to nobody.
  const q = new Queue();
  q.join('a');
  q.join('b');
  q.join('c');
  q.settle();

  q.assertConsistent();
  q.assertOneHost();
  assert.equal(q.matches.size, 2, 'exactly one pair formed');
});

test('a crowd pairs off without anyone ending up stranded', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const q = new Queue(30, seed);
    for (const id of ['p3', 'p1', 'p7', 'p2', 'p9', 'p5', 'p4', 'p8']) q.join(id);
    q.settle(80);

    q.assertConsistent();
    q.assertOneHost();
    assert.equal(q.matches.size % 2, 0, `seed ${seed}: an odd number of matched peers`);
    assert.ok(q.matches.size >= 6, `seed ${seed}: only ${q.matches.size / 2} pairs from 8 peers`);
  }
});

test('a peer already in a match turns down newcomers', () => {
  const q = new Queue();
  q.join('a');
  q.join('b');
  q.settle();
  assert.equal(q.matches.size, 2);

  q.join('c');
  q.settle();

  q.assertConsistent();
  assert.equal(q.matches.get('a'), 'b', 'the existing pair is undisturbed');
  assert.equal(q.matches.has('c'), false, 'the newcomer waits');
});

test('two waiting peers find each other after the busy ones are skipped', () => {
  const q = new Queue();
  q.join('a');
  q.join('b');
  q.settle();

  q.join('c');
  q.join('d');
  q.settle(80);

  q.assertConsistent();
  assert.equal(q.matches.get('c'), 'd');
  assert.equal(q.matches.get('d'), 'c');
});

test('a partner vanishing mid-handshake frees the other side', () => {
  const q = new Queue(200);
  q.join('a');
  q.join('b');
  q.advance(10); // offer in flight
  q.leave('b');

  q.join('c');
  q.settle(80);

  q.assertConsistent();
  assert.equal(q.matches.get('a'), 'c', 'a moved on to the next arrival');
});

test('a silent peer is given up on rather than blocking the queue', () => {
  // A peer that answers an offer and then goes quiet must not hold the
  // proposer hostage.
  const sent: Array<[PairTag, string]> = [];
  const p = new Pairing('aaa', (tag, to) => sent.push([tag, to]), () => {});
  p.addPeer('zzz', 0);
  assert.deepEqual(sent, [['offer', 'zzz']], 'lower id proposes');

  p.tick(PAIR_TIMEOUT_MS + 1);
  assert.equal(p.state.s, 'free', 'the stalled handshake was abandoned');
  assert.equal(p.matchedWith, null);
});

test('the higher id waits to be asked, then gives up on a silent partner', () => {
  const sent: Array<[PairTag, string]> = [];
  const p = new Pairing('zzz', (tag, to) => sent.push([tag, to]), () => {});
  p.addPeer('aaa', 0);
  p.tick(0);
  assert.deepEqual(sent, [], 'it waits to be asked');

  // 'aaa' is already playing someone else and will never propose to us, so
  // after the wait times out we offer to them anyway and find out.
  p.tick(WAIT_TIMEOUT_MS + 1);
  assert.deepEqual(sent, [['offer', 'aaa']], 'it stopped waiting and asked');

  p.receive('reject', 'aaa', WAIT_TIMEOUT_MS + 2);
  p.addPeer('zzzz', WAIT_TIMEOUT_MS + 3);
  assert.deepEqual(sent.at(-1), ['offer', 'zzzz'], 'then moved on to a reachable peer');
});

test('a busy queue with staggered arrivals never strands or double-books', () => {
  // The property that actually matters in the lobby: whatever the timing,
  // every match is mutual, nobody hosts against a host, and people do not
  // pile up unmatched while a partner is available.
  for (let seed = 1; seed <= 12; seed++) {
    const rng = new Rng(seed * 7919);
    const q = new Queue(40, seed);
    const waiting = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7'];
    let joined = 0;

    for (let step = 0; step < 200; step++) {
      if (joined < waiting.length && rng.chance(0.08)) q.join(waiting[joined++]!);
      q.advance(50);
      q.tickAll();
    }
    // Let the stragglers settle.
    q.settle(200);

    q.assertConsistent();
    q.assertOneHost();
    const unmatched = [...q.members.keys()].filter((id) => !q.matches.has(id));
    assert.ok(
      unmatched.length <= 1,
      `seed ${seed}: ${unmatched.length} peers left over (${unmatched.join(',')}) from ${joined} joined`,
    );
  }
});
