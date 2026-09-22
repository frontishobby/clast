import assert from 'node:assert/strict';
import test from 'node:test';

import { CELL, GRID_H } from '../game/arena.ts';
import { IDLE_INPUT, Sim, TUNING, type PlayerInput } from '../game/sim.ts';
import { WEAPONS } from '../game/weapons.ts';
import { Ai, type Difficulty } from './ai.ts';

const DT = 1 / 60;
const seedAt = (i: number) => (Math.imul(i + 1, 2654435761) >>> 0) || 1;

/** Runs a full CPU-vs-CPU match and reports how it ended. */
function duel(seed: number, a: Difficulty, b: Difficulty, maxSeconds = 90) {
  const sim = new Sim(seed);
  const ai0 = new Ai(0, a, seed ^ 0x11);
  const ai1 = new Ai(1, b, seed ^ 0x22);
  const limit = maxSeconds * 60;
  let ticks = 0;
  while (sim.phase === 'playing' && ticks < limit) {
    sim.step(DT, [ai0.sample(sim, DT), ai1.sample(sim, DT)]);
    sim.events.length = 0;
    ticks++;
  }
  return { winner: sim.winner, ticks, timedOut: ticks >= limit, sim };
}

/** One AI against a completely passive opponent. */
function soloRun(sim: Sim, seconds: number, difficulty: Difficulty = 'normal'): Ai {
  const ai = new Ai(1, difficulty, 0xc0ffee);
  for (let i = 0; i < seconds * 60 && sim.phase === 'playing'; i++) {
    sim.step(DT, [IDLE_INPUT, ai.sample(sim, DT)] as [PlayerInput, PlayerInput]);
    sim.events.length = 0;
  }
  return ai;
}

test('the CPU replays identically from the same seed', () => {
  // The AI is an input source like any other, so a desync here would be
  // indistinguishable from a netcode bug later.
  const fingerprint = () => {
    const r = duel(0xa11ce, 'normal', 'hard');
    return JSON.stringify([
      r.winner,
      r.ticks,
      r.sim.players.map((p) => [p.x, p.y, p.hp, p.weapon]),
      Array.from(r.sim.arena.hp),
    ]);
  };
  assert.equal(fingerprint(), fingerprint());
});

test('every match reaches a conclusion', () => {
  // Regression: an unconditional "retreat when hurt" rule used to deadlock
  // once both sides fell to the threshold, because health never recovers, so
  // neither would ever close again and the match ran to the clock.
  for (const [a, b] of [
    ['normal', 'normal'],
    ['hard', 'hard'],
    ['easy', 'easy'],
    ['hard', 'easy'],
  ] as Array<[Difficulty, Difficulty]>) {
    for (let i = 0; i < 6; i++) {
      const r = duel(seedAt(i), a, b);
      assert.ok(!r.timedOut, `${a} vs ${b} seed ${i} ran out the clock`);
    }
  }
});

test('two evenly matched bots at low health still commit', () => {
  // The exact shape of the old deadlock, pinned directly.
  const sim = new Sim(0xdead);
  sim.players[0].hp = 1;
  sim.players[1].hp = 1;
  const ai0 = new Ai(0, 'normal', 1);
  const ai1 = new Ai(1, 'normal', 2);
  let ticks = 0;
  while (sim.phase === 'playing' && ticks < 60 * 60) {
    sim.step(DT, [ai0.sample(sim, DT), ai1.sample(sim, DT)]);
    sim.events.length = 0;
    ticks++;
  }
  assert.equal(sim.phase, 'over', 'a 1hp mirror match must resolve');
});

test('difficulty is ordered', () => {
  const score = (a: Difficulty, b: Difficulty) => {
    let wins = 0;
    for (let i = 0; i < 12; i++) if (duel(seedAt(i), a, b).winner === 0) wins++;
    return wins;
  };
  assert.ok(score('hard', 'easy') >= 9, 'hard should dominate easy');
  assert.ok(score('normal', 'easy') >= 8, 'normal should beat easy');
  assert.ok(score('hard', 'normal') >= 8, 'hard should beat normal');
});

test('the CPU beats a target that never fights back', () => {
  for (let i = 0; i < 4; i++) {
    const sim = new Sim(seedAt(i));
    soloRun(sim, 60);
    assert.equal(sim.phase, 'over', `seed ${i}: could not finish a sitting duck`);
    assert.equal(sim.winner, 1);
  }
});

test('a wall between the CPU and its target does not stop it', () => {
  // Going round through the gap and mining straight through are both fine
  // answers -- A* prices blocks rather than forbidding them. What must not
  // happen is the CPU grinding into the wall and staying there.
  const sim = new Sim(3);
  sim.arena.hp.fill(0);
  sim.zoneRunning = false;
  const target = sim.players[0];
  const cpu = sim.players[1];
  // Close enough that the CPU is committed to the fight rather than off
  // mining, so this isolates navigation.
  target.x = 400;
  target.y = 360;
  cpu.x = 620;
  cpu.y = 360;
  const wallGx = 12;
  for (let gy = 0; gy < GRID_H; gy++) {
    if (gy === 2) continue; // the gap
    sim.arena.hp[sim.arena.idx(wallGx, gy)] = 3;
  }

  soloRun(sim, 25);

  const dist = Math.hypot(cpu.x - target.x, cpu.y - target.y);
  assert.ok(dist < 90, `CPU stalled ${dist.toFixed(0)} units away at x=${cpu.x.toFixed(0)}`);
});

test('the CPU mines cover when there is nobody to fight', () => {
  // Without this the drop system is invisible in single player: the CPU broke
  // about one block a match and never saw a weapon.
  const sim = new Sim(seedAt(9));
  sim.zoneRunning = false;
  const before = sim.arena.count();
  soloRun(sim, 20);
  const broken = before - sim.arena.count();
  assert.ok(broken >= 5, `only broke ${broken} blocks in 20s`);
});

test('the CPU picks up a weapon it walks past', () => {
  const sim = new Sim(4);
  sim.arena.hp.fill(0);
  sim.zoneRunning = false;
  const cpu = sim.players[1];
  sim.pickups.push({ id: 1, weapon: 'spear', x: cpu.x - 90, y: cpu.y });

  soloRun(sim, 5);

  assert.equal(cpu.weapon, 'spear');
  // Charges are already being spent on cover by now, so only the floor matters.
  assert.ok(cpu.uses > 0 && cpu.uses <= WEAPONS.spear.uses);
});

test('a ranged weapon does not park the CPU behind cover', () => {
  // Standoff used to ignore line of sight: a bot holding a thrown weapon sat
  // at its preferred range behind a block, never got a shot, never spent
  // ammo, never reverted to fists, and never closed.
  const sim = new Sim(8);
  sim.arena.hp.fill(0);
  sim.zoneRunning = false;
  const [target, cpu] = sim.players;
  cpu.x = target.x + 260;
  cpu.y = target.y;
  cpu.weapon = 'shard';
  cpu.uses = WEAPONS.shard.uses;
  // A screen of cover right on the sightline.
  const gx = Math.floor((target.x + 130) / CELL);
  for (let gy = 0; gy < GRID_H; gy++) sim.arena.hp[sim.arena.idx(gx, gy)] = 3;

  soloRun(sim, 25);

  assert.ok(target.hp < TUNING.playerMaxHp, 'the CPU never made anything happen');
});

test('the CPU keeps itself inside the closing zone', () => {
  const sim = new Sim(seedAt(2));
  const cpu = sim.players[1];
  let worstOverrun = 0;
  const ai = new Ai(1, 'normal', 7);

  for (let i = 0; i < 70 * 60 && sim.phase === 'playing'; i++) {
    sim.step(DT, [IDLE_INPUT, ai.sample(sim, DT)] as [PlayerInput, PlayerInput]);
    sim.events.length = 0;
    const z = sim.zone();
    const overX = Math.max(0, Math.abs(cpu.x - z.cx) - (z.w / 2 - TUNING.playerRadius));
    const overY = Math.max(0, Math.abs(cpu.y - z.cy) - (z.h / 2 - TUNING.playerRadius));
    worstOverrun = Math.max(worstOverrun, Math.hypot(overX, overY));
  }

  // The zone pull will always win eventually; this checks the CPU is not
  // fighting it, which would mean it spends the endgame being shoved around.
  assert.ok(worstOverrun < 2, `drifted ${worstOverrun.toFixed(1)} units outside`);
});

test('the CPU does not swing at a wall between it and its target', () => {
  const sim = new Sim(6);
  sim.arena.hp.fill(0);
  sim.zoneRunning = false;
  const [target, cpu] = sim.players;
  cpu.x = target.x + 70;
  cpu.y = target.y;
  const gx = Math.floor((target.x + 35) / CELL);
  sim.arena.hp[sim.arena.idx(gx, Math.floor(target.y / CELL))] = 3;

  const ai = new Ai(1, 'hard', 3);
  for (let i = 0; i < 30; i++) {
    sim.step(DT, [IDLE_INPUT, ai.sample(sim, DT)] as [PlayerInput, PlayerInput]);
    sim.events.length = 0;
  }

  assert.equal(target.hp, TUNING.playerMaxHp, 'the wall should have absorbed everything');
});
