import assert from 'node:assert/strict';
import test from 'node:test';

import { CELL, GRID_H, GRID_W, SPAWNS } from './arena.ts';
import { IDLE_INPUT, Sim, TUNING, type PlayerInput } from './sim.ts';
import { WEAPONS } from './weapons.ts';

const DT = 1 / 60;

function input(p: Partial<PlayerInput> = {}): PlayerInput {
  return { ...IDLE_INPUT, ...p };
}

/** Run the sim with player 0 driven and player 1 idle. */
function run(sim: Sim, ticks: number, p0: PlayerInput, p1: PlayerInput = IDLE_INPUT): void {
  for (let i = 0; i < ticks; i++) sim.step(DT, [p0, p1]);
}

/** A sim with an empty arena, so movement tests are not blocked by cover. */
function emptySim(): Sim {
  const sim = new Sim(1);
  sim.arena.hp.fill(0);
  sim.zoneRunning = false;
  return sim;
}

test('a block takes three hits and drops a break event', () => {
  const sim = emptySim();
  const p = sim.players[0];
  // Put one block directly in front of the player.
  const gx = Math.floor((p.x + 40) / CELL);
  const gy = Math.floor(p.y / CELL);
  sim.arena.hp[sim.arena.idx(gx, gy)] = 3;

  const swing = input({ aim: 0, attack: true });
  const hps: number[] = [];
  for (let i = 0; i < 3; i++) {
    run(sim, Math.ceil(WEAPONS.fist.cooldown / DT) + 2, swing);
    hps.push(sim.arena.hpAt(gx, gy));
  }

  assert.deepEqual(hps, [2, 1, 0], 'one damage per swing');
  const breaks = sim.events.filter((e) => e.type === 'blockBreak');
  assert.equal(breaks.length, 1);
});

test('a swing only reaches what is in front of you', () => {
  const sim = emptySim();
  const p = sim.players[0];
  const gy = Math.floor(p.y / CELL);
  const ahead = Math.floor((p.x + 40) / CELL);
  const behind = Math.floor((p.x - 40) / CELL);
  sim.arena.hp[sim.arena.idx(ahead, gy)] = 3;
  sim.arena.hp[sim.arena.idx(behind, gy)] = 3;

  run(sim, 10, input({ aim: 0, attack: true }));

  assert.equal(sim.arena.hpAt(ahead, gy), 2, 'block in front was hit');
  assert.equal(sim.arena.hpAt(behind, gy), 3, 'block behind was not');
});

test('the melee cooldown caps the swing rate', () => {
  const sim = emptySim();
  const swing = input({ aim: 0, attack: true });
  run(sim, 60, swing); // one second of holding attack
  const swings = sim.events.filter((e) => e.type === 'swing').length;
  const expected = Math.floor(1 / WEAPONS.fist.cooldown) + 1;
  assert.ok(swings <= expected, `${swings} swings in one second, cap ${expected}`);
  assert.ok(swings >= 2, 'attack is repeatable while held');
});

test('players cannot walk through blocks', () => {
  // Both offsets matter: a player centred on the seam between two stacked
  // cells hits a different branch of the resolver than one mid-cell, and the
  // seam case is the one that used to let you walk straight through.
  for (const yOffset of [0, CELL / 2, 1, CELL - 1]) {
    const sim = emptySim();
    const p = sim.players[0];
    p.y = Math.floor(p.y / CELL) * CELL + yOffset;
    const gy = Math.floor(p.y / CELL);
    const wall = Math.floor((p.x + 80) / CELL);
    for (let y = gy - 2; y <= gy + 2; y++) sim.arena.hp[sim.arena.idx(wall, y)] = 3;

    run(sim, 180, input({ moveX: 1, aim: 0 }));

    const face = wall * CELL;
    assert.ok(p.x < face, `offset ${yOffset}: walked to ${p.x.toFixed(1)}, wall at ${face}`);
    assert.ok(
      p.x > face - TUNING.playerRadius - 2,
      `offset ${yOffset}: stopped short at ${p.x.toFixed(1)}`,
    );
  }
});

test('a player boxed in on all four sides stays boxed in', () => {
  const sim = emptySim();
  const p = sim.players[0];
  p.x = 5.5 * CELL;
  p.y = 9.5 * CELL;
  const gx = 5;
  const gy = 9;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    sim.arena.hp[sim.arena.idx(gx + dx, gy + dy)] = 3;
  }

  for (const [mx, my] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [0.7, 0.7],
    [-0.7, -0.7],
  ] as const) {
    run(sim, 60, input({ moveX: mx, moveY: my, aim: 0 }));
    assert.ok(
      Math.floor(p.x / CELL) === gx && Math.floor(p.y / CELL) === gy,
      `escaped to ${p.x.toFixed(1)},${p.y.toFixed(1)} pushing ${mx},${my}`,
    );
  }
});

test('sliding along a wall does not snag on the seams between cells', () => {
  // The collision resolver skips occluded faces specifically for this.
  const sim = emptySim();
  const p = sim.players[0];
  const wallGx = Math.floor((p.x + 60) / CELL);
  for (let y = 0; y < GRID_H; y++) sim.arena.hp[sim.arena.idx(wallGx, y)] = 3;

  // Push into the wall and downward at the same time.
  const startY = p.y;
  run(sim, 120, input({ moveX: 0.7, moveY: 0.7, aim: 0 }));

  const travelled = p.y - startY;
  const ideal = TUNING.playerSpeed * 0.7 * 2;
  assert.ok(travelled > ideal * 0.9, `slid ${travelled.toFixed(0)} of an ideal ${ideal.toFixed(0)}`);
});

test('the zone drags a stranded player back inside', () => {
  const sim = new Sim(1);
  sim.arena.hp.fill(0);
  const p = sim.players[0];
  sim.zoneT = 1; // fully closed
  const z = sim.zone();

  run(sim, 240, IDLE_INPUT);

  assert.ok(p.x >= z.cx - z.w / 2 - 1 && p.x <= z.cx + z.w / 2 + 1, 'pulled inside horizontally');
  assert.ok(p.y >= z.cy - z.h / 2 - 1 && p.y <= z.cy + z.h / 2 + 1, 'pulled inside vertically');
});

test('the zone pull beats walking speed', () => {
  assert.ok(TUNING.zonePull > TUNING.playerSpeed, 'the closing edge must be inescapable');
});

test('hits take a player down and end the match', () => {
  const sim = emptySim();
  const [a, b] = sim.players;
  // Stand them toe to toe.
  b.x = a.x + WEAPONS.fist.range - 4;
  b.y = a.y;

  const swing = input({ aim: 0, attack: true });
  for (let i = 0; i < TUNING.playerMaxHp * 40 && sim.phase === 'playing'; i++) {
    sim.step(DT, [swing, IDLE_INPUT]);
    b.x = a.x + WEAPONS.fist.range - 4; // pin past the knockback
    b.y = a.y;
  }

  assert.equal(b.hp, 0);
  assert.equal(b.alive, false);
  assert.equal(sim.phase, 'over');
  assert.equal(sim.winner, 0);
});

test('invulnerability stops one swing counting twice', () => {
  const sim = emptySim();
  const [a, b] = sim.players;
  b.x = a.x + WEAPONS.fist.range - 4;
  b.y = a.y;
  const before = b.hp;

  // A single swing, held across many ticks.
  run(sim, 6, input({ aim: 0, attack: true }));

  assert.equal(b.hp, before - WEAPONS.fist.playerDamage, 'exactly one point of damage');
});

test('the same seed and inputs produce identical runs', () => {
  // Host-authoritative netcode still replays inputs on the guest for
  // prediction, so drift here would show up as rubber-banding.
  const script: PlayerInput[] = Array.from({ length: 300 }, (_, i) =>
    input({
      moveX: Math.sin(i * 0.11),
      moveY: Math.cos(i * 0.07),
      aim: i * 0.03,
      attack: i % 17 === 0,
    }),
  );

  const fingerprint = (sim: Sim) => {
    for (const cmd of script) sim.step(DT, [cmd, IDLE_INPUT]);
    return JSON.stringify([
      sim.players.map((p) => [p.x, p.y, p.hp, p.vx, p.vy]),
      Array.from(sim.arena.hp),
      sim.zoneT,
    ]);
  };

  assert.equal(fingerprint(new Sim(0xabc)), fingerprint(new Sim(0xabc)));
});

test('both seats start facing their opponent', () => {
  const sim = new Sim(7);
  const [a, b] = sim.players;
  assert.ok(Math.cos(a.aim) > 0.99, 'seat 0 faces world +x');
  assert.ok(Math.cos(b.aim) < -0.99, 'seat 1 faces world -x');
  assert.ok(a.x < b.x);
  assert.equal(a.x, SPAWNS[0].x);
});

test('a swing never reaches across the whole grid', () => {
  assert.ok(WEAPONS.fist.range < CELL * 2, 'melee must stay a melee');
  assert.ok(GRID_W === 32 && GRID_H === 18);
});

test('the closing zone grinds away the blocks it reaches', () => {
  const sim = new Sim(11);
  sim.zoneT = 1;
  sim.step(DT, [IDLE_INPUT, IDLE_INPUT]);

  const z = sim.zone();
  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      if (sim.arena.hpAt(gx, gy) <= 0) continue;
      const left = gx * CELL;
      const top = gy * CELL;
      assert.ok(
        left >= z.cx - z.w / 2 && left + CELL <= z.cx + z.w / 2 &&
          top >= z.cy - z.h / 2 && top + CELL <= z.cy + z.h / 2,
        `block ${gx},${gy} survived outside the zone`,
      );
    }
  }
});

test('a player cannot be pinned outside the zone by a block', () => {
  // The zone pull runs after block collision, so before the edge ground
  // blocks away a stationary player could be shoved back out every tick and
  // stall permanently off camera -- the zone rect is the camera.
  const sim = new Sim(12);
  const p = sim.players[0];
  for (let t = 0; t < 70 * 60; t++) {
    sim.step(DT, [IDLE_INPUT, IDLE_INPUT]);
    sim.events.length = 0;
  }
  const z = sim.zone();
  assert.ok(Math.abs(p.x - z.cx) <= z.w / 2, `stranded at x=${p.x.toFixed(0)}`);
  assert.ok(Math.abs(p.y - z.cy) <= z.h / 2, `stranded at y=${p.y.toFixed(0)}`);
});
