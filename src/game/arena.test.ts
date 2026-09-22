import assert from 'node:assert/strict';
import test from 'node:test';

import { Arena, CELL, DEFAULT_LAYOUT, GRID_H, GRID_W, SPAWNS } from './arena.ts';

const SEEDS = Array.from({ length: 64 }, (_, i) => (Math.imul(i + 1, 2654435761) >>> 0) || 1);

test('the layout is point-symmetric for every seed', () => {
  // This is the invariant the per-seat view rotation relies on: rotate the
  // arena 180 degrees and it must land on itself, or the two players see
  // different cover and the match is unfair.
  for (const seed of SEEDS) {
    const a = new Arena(seed);
    for (let gy = 0; gy < GRID_H; gy++) {
      for (let gx = 0; gx < GRID_W; gx++) {
        assert.equal(
          a.hpAt(gx, gy),
          a.hpAt(GRID_W - 1 - gx, GRID_H - 1 - gy),
          `seed ${seed} @ ${gx},${gy}`,
        );
      }
    }
  }
});

test('both spawns have a clear approach', () => {
  for (const seed of SEEDS) {
    const a = new Arena(seed);
    for (const spawn of SPAWNS) {
      for (let gy = 0; gy < GRID_H; gy++) {
        for (let gx = 0; gx < GRID_W; gx++) {
          if (a.hpAt(gx, gy) === 0) continue;
          const d = Math.hypot((gx + 0.5) * CELL - spawn.x, (gy + 0.5) * CELL - spawn.y);
          assert.ok(d >= CELL * 2.6, `seed ${seed}: block at ${gx},${gy} crowds a spawn`);
        }
      }
    }
  }
});

test('every seed lands on the target density', () => {
  // Density is the knob that decides how the match plays, so it must not be
  // left to the seed. Tolerance is one mirrored cell pair, which is all the
  // rounding of an odd target can cost.
  const want = DEFAULT_LAYOUT.targetDensity;
  const slack = 2 / (GRID_W * GRID_H);
  for (const seed of SEEDS) {
    const d = new Arena(seed).density();
    assert.ok(Math.abs(d - want) <= slack, `seed ${seed} gave ${(d * 100).toFixed(2)}%`);
  }
});

test('the target density knob is honoured across its range', () => {
  for (const targetDensity of [0.05, 0.125, 0.2, 0.3]) {
    for (const seed of SEEDS.slice(0, 16)) {
      const d = new Arena(seed, { ...DEFAULT_LAYOUT, targetDensity }).density();
      assert.ok(
        Math.abs(d - targetDensity) <= 2 / (GRID_W * GRID_H),
        `target ${targetDensity} seed ${seed} gave ${(d * 100).toFixed(2)}%`,
      );
    }
  }
});

test('cover is clumped, not scattered single cells', () => {
  // The whole reason for cluster growth: most blocks should touch another
  // block, so they read as walls rather than as noise.
  let touching = 0;
  let total = 0;
  for (const seed of SEEDS) {
    const a = new Arena(seed);
    for (let gy = 0; gy < GRID_H; gy++) {
      for (let gx = 0; gx < GRID_W; gx++) {
        if (a.hpAt(gx, gy) === 0) continue;
        total++;
        const n =
          a.hpAt(gx + 1, gy) + a.hpAt(gx - 1, gy) + a.hpAt(gx, gy + 1) + a.hpAt(gx, gy - 1);
        if (n > 0) touching++;
      }
    }
  }
  assert.ok(touching / total > 0.6, `only ${((touching / total) * 100).toFixed(0)}% clumped`);
});

test('generation terminates even when the field cannot be filled', () => {
  // The fill loop is bounded; an impossible target must return a full-ish
  // field instead of hanging the tab.
  const a = new Arena(99, { ...DEFAULT_LAYOUT, targetDensity: 0.95 });
  assert.ok(a.count() > 0);
  assert.ok(a.count() <= GRID_W * GRID_H);
});
