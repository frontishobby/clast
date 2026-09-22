import assert from 'node:assert/strict';
import test from 'node:test';

import { CELL } from './arena.ts';
import { IDLE_INPUT, Sim, TUNING, type PlayerInput } from './sim.ts';
import { DROPPABLE, WEAPONS, rollWeapon, type WeaponId } from './weapons.ts';

const DT = 1 / 60;

function input(p: Partial<PlayerInput> = {}): PlayerInput {
  return { ...IDLE_INPUT, ...p };
}

function emptySim(seed = 1): Sim {
  const sim = new Sim(seed);
  sim.arena.hp.fill(0);
  sim.zoneRunning = false;
  return sim;
}

/** Break `count` blocks in front of the player and return the sim. */
function farmBlocks(sim: Sim, count: number): void {
  const p = sim.players[0];
  const swing = input({ aim: 0, attack: true });
  for (let n = 0; n < count; n++) {
    const gx = Math.floor((p.x + 40) / CELL);
    const gy = Math.floor(p.y / CELL);
    sim.arena.hp[sim.arena.idx(gx, gy)] = 1; // one hit from breaking
    for (let i = 0; i < 40 && sim.arena.hpAt(gx, gy) > 0; i++) {
      sim.step(DT, [swing, IDLE_INPUT]);
    }
    // Clear loot between blocks so the player does not auto-collect it.
    sim.pickups.length = 0;
  }
}

test('the weapon table is internally consistent', () => {
  for (const id of Object.keys(WEAPONS) as WeaponId[]) {
    const w = WEAPONS[id];
    assert.equal(w.id, id, 'key matches id');
    assert.ok(w.cooldown > 0, `${id} needs a cooldown`);
    assert.ok(w.windup < w.cooldown, `${id} windup must fit inside its cooldown`);
    assert.ok(w.uses === -1 || w.uses > 0, `${id} has a nonsense use count`);
    if (w.kind === 'throw') assert.ok(w.projectile, `${id} throws but has no projectile`);
    else assert.ok(w.range > 0 && w.arc > 0, `${id} is melee but has no reach`);
  }
  assert.equal(WEAPONS.fist.uses, -1, 'fists never run out');
  assert.ok(!DROPPABLE.includes('fist'), 'fists are not loot');
});

test('every droppable weapon is reachable from the roll', () => {
  const seen = new Set<WeaponId>();
  for (let i = 0; i < 2000; i++) seen.add(rollWeapon(i / 2000));
  assert.equal(seen.size, DROPPABLE.length, `only saw ${[...seen].join(',')}`);
});

test('drops land near the advertised rate', () => {
  const sim = emptySim(0xfeed);
  let breaks = 0;
  let drops = 0;
  const p = sim.players[0];
  const swing = input({ aim: 0, attack: true });

  for (let n = 0; n < 400; n++) {
    const gx = Math.floor((p.x + 40) / CELL);
    const gy = Math.floor(p.y / CELL);
    sim.arena.hp[sim.arena.idx(gx, gy)] = 1;
    for (let i = 0; i < 40 && sim.arena.hpAt(gx, gy) > 0; i++) {
      sim.step(DT, [swing, IDLE_INPUT]);
    }
    breaks++;
    drops += sim.pickups.length;
    sim.pickups.length = 0;
  }

  const rate = drops / breaks;
  assert.ok(
    Math.abs(rate - TUNING.dropChance) < 0.06,
    `dropped ${(rate * 100).toFixed(1)}% over ${breaks} breaks, want ${TUNING.dropChance * 100}%`,
  );
});

test('walking over a drop equips it with full charges', () => {
  const sim = emptySim();
  const p = sim.players[0];
  sim.pickups.push({ id: 1, weapon: 'hammer', x: p.x + 10, y: p.y });

  sim.step(DT, [IDLE_INPUT, IDLE_INPUT]);

  assert.equal(p.weapon, 'hammer');
  assert.equal(p.uses, WEAPONS.hammer.uses);
  assert.equal(sim.pickups.length, 0, 'the drop is consumed');
});

test('a weapon runs out and falls back to fists', () => {
  const sim = emptySim();
  const p = sim.players[0];
  p.weapon = 'dagger';
  p.uses = 2;

  const swing = input({ aim: 0, attack: true });
  const ticks = Math.ceil(WEAPONS.dagger.cooldown / DT) + 2;
  for (let i = 0; i < 3; i++) {
    for (let t = 0; t < ticks; t++) sim.step(DT, [swing, IDLE_INPUT]);
  }

  assert.equal(p.weapon, 'fist');
  assert.equal(p.uses, -1);
});

test('a weapon breaking mid-swing still lands with its own stats', () => {
  // swingWeapon is latched at the start for exactly this case: the hammer's
  // last charge must still one-shot the block it was aimed at.
  const sim = emptySim();
  const p = sim.players[0];
  p.weapon = 'hammer';
  p.uses = 1;
  const gx = Math.floor((p.x + 40) / CELL);
  const gy = Math.floor(p.y / CELL);
  sim.arena.hp[sim.arena.idx(gx, gy)] = 3;

  const swing = input({ aim: 0, attack: true });
  sim.step(DT, [swing, IDLE_INPUT]); // charge is spent here
  assert.equal(p.weapon, 'fist', 'already out of charges');
  for (let i = 0; i < 20; i++) sim.step(DT, [input({ aim: 0 }), IDLE_INPUT]);

  assert.equal(sim.arena.hpAt(gx, gy), 0, 'the hammer blow still broke the block');
});

test('the hammer clears a block in one swing and fists do not', () => {
  for (const [weapon, expected] of [
    ['hammer', 0],
    ['fist', 2],
  ] as const) {
    const sim = emptySim();
    const p = sim.players[0];
    p.weapon = weapon;
    p.uses = WEAPONS[weapon].uses;
    const gx = Math.floor((p.x + 40) / CELL);
    const gy = Math.floor(p.y / CELL);
    sim.arena.hp[sim.arena.idx(gx, gy)] = 3;

    for (let i = 0; i < 20; i++) sim.step(DT, [input({ aim: 0, attack: true }), IDLE_INPUT]);

    assert.equal(sim.arena.hpAt(gx, gy), expected, `${weapon} block damage`);
  }
});

test('the spear reaches past fist range', () => {
  const sim = emptySim();
  const [a, b] = sim.players;
  b.x = a.x + WEAPONS.fist.range + 20;
  b.y = a.y;
  assert.ok(b.x - a.x > WEAPONS.fist.range, 'target is out of fist range');

  a.weapon = 'spear';
  a.uses = WEAPONS.spear.uses;
  for (let i = 0; i < 20; i++) sim.step(DT, [input({ aim: 0, attack: true }), IDLE_INPUT]);

  assert.equal(b.hp, TUNING.playerMaxHp - WEAPONS.spear.playerDamage);
});

test('a thrown shard flies, hits, and disappears', () => {
  const sim = emptySim();
  const [a, b] = sim.players;
  b.x = a.x + 400;
  b.y = a.y;
  a.weapon = 'shard';
  a.uses = 4;

  sim.step(DT, [input({ aim: 0, attack: true }), IDLE_INPUT]);
  for (let i = 0; i < 6; i++) sim.step(DT, [input({ aim: 0 }), IDLE_INPUT]);
  assert.equal(sim.projectiles.length, 1, 'a shard is in the air');

  for (let i = 0; i < 90 && sim.projectiles.length > 0; i++) {
    sim.step(DT, [input({ aim: 0 }), IDLE_INPUT]);
  }

  assert.equal(sim.projectiles.length, 0, 'it stopped on impact');
  assert.equal(b.hp, TUNING.playerMaxHp - WEAPONS.shard.playerDamage);
});

test('a shard is stopped by cover', () => {
  const sim = emptySim();
  const [a, b] = sim.players;
  b.x = a.x + 400;
  b.y = a.y;
  const wall = Math.floor((a.x + 200) / CELL);
  sim.arena.hp[sim.arena.idx(wall, Math.floor(a.y / CELL))] = 3;
  a.weapon = 'shard';
  a.uses = 4;

  for (let i = 0; i < 120; i++) sim.step(DT, [input({ aim: 0, attack: i === 0 }), IDLE_INPUT]);

  assert.equal(b.hp, TUNING.playerMaxHp, 'the block took the hit');
  assert.equal(sim.arena.hpAt(wall, Math.floor(a.y / CELL)), 2);
});

test('a bomb blast clears cover and hurts the target but not the thrower', () => {
  const sim = emptySim();
  const [a, b] = sim.players;
  b.x = a.x + 180;
  b.y = a.y;
  a.weapon = 'bomb';
  a.uses = 3;

  const gy = Math.floor(a.y / CELL);
  const nearTarget = Math.floor((b.x - 30) / CELL);
  sim.arena.hp[sim.arena.idx(nearTarget, gy)] = 3;

  for (let i = 0; i < 150; i++) sim.step(DT, [input({ aim: 0, attack: i === 0 }), IDLE_INPUT]);

  assert.ok(b.hp < TUNING.playerMaxHp, 'the target was caught in the blast');
  assert.equal(a.hp, TUNING.playerMaxHp, 'the thrower is shoved, not hurt');
  assert.equal(sim.arena.hpAt(nearTarget, gy), 0, 'the blast cleared the cover');
});

test('the closing zone eats loot it passes over', () => {
  const sim = new Sim(5);
  sim.arena.hp.fill(0);
  sim.pickups.push({ id: 1, weapon: 'spear', x: 20, y: 20 });
  sim.zoneT = 1;

  sim.step(DT, [IDLE_INPUT, IDLE_INPUT]);

  assert.equal(sim.pickups.length, 0);
  assert.ok(sim.events.some((e) => e.type === 'pickupLost'));
});

test('loot is identical for the same seed and inputs', () => {
  // The drop stream is part of the shared state: if the peers disagree about
  // what fell out of a block, they are playing different games.
  const fingerprint = (seed: number) => {
    const sim = new Sim(seed);
    farmBlocks(sim, 25);
    return sim.events
      .filter((e) => e.type === 'drop')
      .map((e) => (e.type === 'drop' ? `${e.weapon}@${e.x},${e.y}` : ''))
      .join('|');
  };
  const a = fingerprint(0x5100);
  const b = fingerprint(0x5100);
  assert.equal(a, b);
  assert.ok(a.length > 0, 'the run produced at least one drop');
});

test('a heap of loot is collected nearest-first, one per tick', () => {
  // A bomb can drop several weapons onto the same few tiles; which one you
  // end up holding must not depend on array order.
  const sim = emptySim();
  const p = sim.players[0];
  sim.pickups.push({ id: 1, weapon: 'bomb', x: p.x + 20, y: p.y });
  sim.pickups.push({ id: 2, weapon: 'dagger', x: p.x + 4, y: p.y });
  sim.pickups.push({ id: 3, weapon: 'spear', x: p.x + 14, y: p.y });

  sim.step(DT, [IDLE_INPUT, IDLE_INPUT]);
  assert.equal(p.weapon, 'dagger', 'nearest drop wins');
  assert.equal(sim.pickups.length, 2, 'only one taken this tick');

  sim.step(DT, [IDLE_INPUT, IDLE_INPUT]);
  assert.equal(p.weapon, 'spear', 'then the next nearest');
  assert.equal(sim.pickups.length, 1);
});
