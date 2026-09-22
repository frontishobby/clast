import assert from 'node:assert/strict';
import test from 'node:test';

import { Rng } from '../core/rng.ts';
import { CELL } from '../game/arena.ts';
import { IDLE_INPUT, type PlayerInput } from '../game/sim.ts';
import { Loopback, type LoopbackOptions } from './protocol.ts';
import { GuestSession, HostSession } from './session.ts';

const DT = 1 / 60;
const MS = DT * 1000;

function script(seed: number, n: number): PlayerInput[] {
  const rng = new Rng(seed);
  const out: PlayerInput[] = [];
  let aim = 0;
  for (let i = 0; i < n; i++) {
    aim += rng.range(-0.25, 0.25);
    out.push({
      moveX: Math.sin(i * 0.037 + seed),
      moveY: Math.cos(i * 0.051 + seed),
      aim,
      attack: rng.chance(0.25),
    });
  }
  return out;
}

/** Plays a full match with both sides on a simulated wire. */
function connect(opts: LoopbackOptions = {}) {
  const wire = new Loopback(opts);
  const host = new HostSession(wire.a, 0xfeed1);
  const guest = new GuestSession(wire.b);
  // Let the start message cross before anyone steps.
  wire.advance((opts.latency ?? 0) + (opts.jitter ?? 0) + 1);
  return { wire, host, guest };
}

function play(
  ctx: ReturnType<typeof connect>,
  ticks: number,
  hostScript: PlayerInput[],
  guestScript: PlayerInput[],
): void {
  for (let i = 0; i < ticks; i++) {
    ctx.host.step(DT, hostScript[i % hostScript.length]!);
    ctx.guest.step(DT, guestScript[i % guestScript.length]!);
    ctx.wire.advance(MS);
  }
}

test('the guest receives the world and starts playing', () => {
  const { host, guest } = connect({ latency: 30 });
  assert.equal(guest.phase, 'live');
  assert.equal(guest.seat, 1);
  assert.ok(guest.sim, 'guest built a world');
  // Same seed means the same arena without ever sending the layout.
  assert.deepEqual(Array.from(guest.sim!.arena.hp), Array.from(host.sim.arena.hp));
});

test('a version mismatch closes the link instead of playing on', () => {
  const wire = new Loopback();
  const guest = new GuestSession(wire.b);
  // Something from a future build.
  wire.a.send({ t: 'hello', v: 999 });
  wire.advance(1);
  assert.equal(guest.phase, 'closed');
});

test('the guest converges on the host state across a realistic link', () => {
  for (const opts of [
    { latency: 0 },
    { latency: 25 },
    { latency: 60, jitter: 20, random: new Rng(7).next.bind(new Rng(7)) },
  ] as LoopbackOptions[]) {
    const ctx = connect(opts);
    play(ctx, 900, script(1, 300), script(2, 300));
    // Flush anything still on the wire.
    ctx.wire.advance(500);

    const h = ctx.host.sim;
    const g = ctx.guest.sim!;
    const label = `latency ${opts.latency ?? 0}`;

    assert.deepEqual(Array.from(g.arena.hp), Array.from(h.arena.hp), `${label}: arena`);
    assert.equal(g.players[0].hp, h.players[0].hp, `${label}: host hp`);
    assert.equal(g.players[1].hp, h.players[1].hp, `${label}: guest hp`);
    assert.equal(g.players[1].weapon, h.players[1].weapon, `${label}: guest weapon`);
    assert.equal(g.phase, h.phase, `${label}: phase`);
    assert.equal(g.winner, h.winner, `${label}: winner`);
  }
});

test('the guest predicts its own movement ahead of the host', () => {
  // The point of prediction: your own character must not wait a round trip.
  const ctx = connect({ latency: 80 });
  const push: PlayerInput = { ...IDLE_INPUT, moveX: 1, moveY: 0 };
  const startX = ctx.guest.sim!.players[1].x;

  // Four ticks is 67ms of game time, inside the 80ms one-way delay, so the
  // guest's first input provably cannot have reached the host yet.
  for (let i = 0; i < 4; i++) {
    ctx.host.step(DT, IDLE_INPUT);
    ctx.guest.step(DT, push);
    ctx.wire.advance(MS);
  }

  const predicted = ctx.guest.sim!.players[1].x;
  assert.ok(predicted > startX + 5, 'guest moved immediately');
  assert.equal(ctx.host.sim.players[1].x, startX, 'host has not seen the input yet');
});

test('a correction is absorbed rather than snapped', () => {
  const ctx = connect({ latency: 50 });
  const push: PlayerInput = { ...IDLE_INPUT, moveX: 1 };
  play(ctx, 200, [IDLE_INPUT], [push]);

  const g = ctx.guest.sim!.players[1];
  const h = ctx.host.sim.players[1];
  // Steady-state drift should be sub-pixel-ish, not a visible rubber band.
  assert.ok(
    Math.hypot(g.x - h.x, g.y - h.y) < 12,
    `drifted ${Math.hypot(g.x - h.x, g.y - h.y).toFixed(1)} units from authority`,
  );
});

test('out-of-order input is ignored rather than rewinding the host', () => {
  // Jitter genuinely reorders messages; an older input overwriting a newer one
  // would make the host stutter backwards.
  const wire = new Loopback();
  const host = new HostSession(wire.a, 5);
  wire.advance(1);

  wire.b.send({ t: 'input', tick: 10, i: { ...IDLE_INPUT, moveX: 1 } });
  wire.advance(1);
  host.step(DT, IDLE_INPUT);
  const afterNew = host.sim.players[1].x;

  wire.b.send({ t: 'input', tick: 4, i: { ...IDLE_INPUT, moveX: -1 } });
  wire.advance(1);
  host.step(DT, IDLE_INPUT);

  assert.ok(host.sim.players[1].x > afterNew, 'still moving on the newer input');
});

test('a dropped block delta is repaired by the next keyframe', () => {
  // The arena is sent as deltas; a keyframe every two seconds is what stops a
  // single lost message leaving a phantom wall on one screen forever.
  const ctx = connect({ latency: 10 });
  const g = ctx.guest.sim!;

  play(ctx, 120, [IDLE_INPUT], [IDLE_INPUT]);
  // Corrupt the guest's arena behind the netcode's back.
  const victim = g.arena.hp.findIndex((v) => v === 0);
  g.arena.hp[victim] = 3;
  assert.notDeepEqual(Array.from(g.arena.hp), Array.from(ctx.host.sim.arena.hp));

  play(ctx, 180, [IDLE_INPUT], [IDLE_INPUT]); // past the next keyframe
  ctx.wire.advance(200);

  assert.deepEqual(
    Array.from(g.arena.hp),
    Array.from(ctx.host.sim.arena.hp),
    'keyframe did not heal the arena',
  );
});

test('combat resolved by the host reaches the guest', () => {
  const ctx = connect({ latency: 40 });
  const h = ctx.host.sim;
  // Put them toe to toe so the host lands hits.
  h.players[1].x = h.players[0].x + CELL;
  h.players[1].y = h.players[0].y;

  const swing: PlayerInput = { ...IDLE_INPUT, aim: 0, attack: true };
  for (let i = 0; i < 200; i++) {
    ctx.host.step(DT, swing);
    ctx.guest.step(DT, IDLE_INPUT);
    h.players[1].x = h.players[0].x + CELL;
    h.players[1].y = h.players[0].y;
    ctx.wire.advance(MS);
  }
  ctx.wire.advance(200);

  assert.ok(h.players[1].hp < 5, 'the host actually landed hits');
  assert.equal(ctx.guest.sim!.players[1].hp, h.players[1].hp, 'guest agrees on health');
});

test('effects reach the guest exactly once', () => {
  const ctx = connect({ latency: 20 });
  let hostEvents = 0;
  let guestEvents = 0;
  ctx.host.onEvents = (e) => {
    hostEvents += e.length;
  };
  ctx.guest.onEvents = (e) => {
    guestEvents += e.length;
  };

  play(ctx, 600, script(3, 200), script(4, 200));
  ctx.wire.advance(300);

  assert.ok(hostEvents > 0, 'something happened');
  assert.equal(guestEvents, hostEvents, 'guest replayed every effect, no more');
});

test('either side can hang up and both notice', () => {
  const ctx = connect({ latency: 10 });
  ctx.host.close('host left');
  ctx.wire.advance(50);
  assert.equal(ctx.host.phase, 'closed');
  assert.equal(ctx.guest.phase, 'closed');
  assert.match(ctx.guest.closedReason ?? '', /host left/);
});
