/**
 * Transform round-trip checks. The rotation chain is the one piece of this
 * codebase where a sign error produces a game that still *looks* fine on one
 * client and is unplayable on the other, so it gets asserted rather than
 * eyeballed. Run with `node --experimental-strip-types`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { rotQuarter } from '../core/math.ts';
import { SPAWNS } from '../game/arena.ts';
import {
  Viewport,
  WORLD_H,
  WORLD_W,
  quarterTurnsFor,
  type Orientation,
  type Seat,
} from './viewport.ts';

const SEATS: Seat[] = [0, 1];
const ORIENTATIONS: Orientation[] = ['landscape', 'portrait'];

/** Enough of a canvas + window for Viewport to measure itself. */
function fakeViewport(seat: Seat, orientation: Orientation, cssW: number, cssH: number) {
  const ctx = new Proxy({}, { get: () => () => {} }) as CanvasRenderingContext2D;
  const canvas = {
    width: 0,
    height: 0,
    style: {} as CSSStyleDeclaration,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;

  (globalThis as { window?: unknown }).window = {
    innerWidth: cssW,
    innerHeight: cssH,
    devicePixelRatio: 2,
  };

  const vp = new Viewport(canvas);
  vp.seat = seat;
  vp.orientationOverride = orientation;
  vp.resize();
  return vp;
}

function screenOf(vp: Viewport, wx: number, wy: number) {
  // Mirror of beginWorld(), in letterbox-logical space.
  const { logicalW, logicalH, quarterTurns } = vp.layout;
  const odd = quarterTurns % 2 === 1;
  const z = logicalW / (odd ? vp.camera.h : vp.camera.w);
  const r = rotQuarter(wx - vp.camera.cx, wy - vp.camera.cy, quarterTurns);
  return { x: r.x * z + logicalW / 2, y: r.y * z + logicalH / 2 };
}

test('the letterbox is 16:9 landscape and 9:16 portrait, centered', () => {
  for (const orientation of ORIENTATIONS) {
    const vp = fakeViewport(0, orientation, 1500, 820);
    const { boxW, boxH, boxX, boxY, cssW, cssH } = vp.layout;
    const want = orientation === 'landscape' ? WORLD_W / WORLD_H : WORLD_H / WORLD_W;
    assert.ok(Math.abs(boxW / boxH - want) < 1e-9, `${orientation} aspect`);
    assert.ok(boxW <= cssW + 1e-9 && boxH <= cssH + 1e-9, 'fits inside the window');
    assert.ok(Math.abs(boxX * 2 + boxW - cssW) < 1e-9, 'horizontally centered');
    assert.ok(Math.abs(boxY * 2 + boxH - cssH) < 1e-9, 'vertically centered');
  }
});

test('every seat sees its own spawn at screen-left / screen-bottom', () => {
  for (const seat of SEATS) {
    for (const orientation of ORIENTATIONS) {
      const vp = fakeViewport(seat, orientation, 1200, 800);
      const mine = screenOf(vp, SPAWNS[seat].x, SPAWNS[seat].y);
      const theirs = screenOf(vp, SPAWNS[seat === 0 ? 1 : 0].x, SPAWNS[seat === 0 ? 1 : 0].y);
      const { logicalW, logicalH } = vp.layout;

      if (orientation === 'landscape') {
        assert.ok(mine.x < logicalW / 2, `seat ${seat} landscape: me on the left`);
        assert.ok(theirs.x > logicalW / 2, `seat ${seat} landscape: them on the right`);
        assert.ok(Math.abs(mine.y - logicalH / 2) < 1e-6, 'vertically centered');
      } else {
        assert.ok(mine.y > logicalH / 2, `seat ${seat} portrait: me at the bottom`);
        assert.ok(theirs.y < logicalH / 2, `seat ${seat} portrait: them at the top`);
        assert.ok(Math.abs(mine.x - logicalW / 2) < 1e-6, 'horizontally centered');
      }
    }
  }
});

test('the two seats see the same picture, up to rotation', () => {
  // Point-symmetric arena: world P for seat 0 is world (W-P) for seat 1.
  for (const orientation of ORIENTATIONS) {
    const a = fakeViewport(0, orientation, 1200, 800);
    const b = fakeViewport(1, orientation, 1200, 800);
    for (const [wx, wy] of [
      [0, 0],
      [317, 88],
      [640, 360],
      [1201, 654],
    ] as const) {
      const sa = screenOf(a, wx, wy);
      const sb = screenOf(b, WORLD_W - wx, WORLD_H - wy);
      assert.ok(Math.abs(sa.x - sb.x) < 1e-6 && Math.abs(sa.y - sb.y) < 1e-6,
        `${orientation} @ ${wx},${wy}`);
    }
  }
});

test('pointer positions round-trip back to world coordinates', () => {
  for (const seat of SEATS) {
    for (const orientation of ORIENTATIONS) {
      const vp = fakeViewport(seat, orientation, 1367, 911);
      vp.camera = { cx: 420, cy: 300, w: 512, h: 288 }; // zoomed-in late-game zone
      const { boxX, boxY, boxScale } = vp.layout;
      for (const [wx, wy] of [
        [420, 300],
        [300, 240],
        [610, 401],
      ] as const) {
        const s = screenOf(vp, wx, wy);
        const back = vp.worldFromClient(s.x * boxScale + boxX, s.y * boxScale + boxY);
        assert.ok(Math.abs(back.x - wx) < 1e-6 && Math.abs(back.y - wy) < 1e-6,
          `seat ${seat} ${orientation} @ ${wx},${wy}`);
      }
    }
  }
});

test('screen-relative input maps to the world and back unchanged', () => {
  for (const seat of SEATS) {
    for (const orientation of ORIENTATIONS) {
      const vp = fakeViewport(seat, orientation, 900, 1600);
      for (const [dx, dy] of [
        [1, 0],
        [0, -1],
        [-0.6, 0.8],
      ] as const) {
        const w = vp.worldDirFromScreenDir(dx, dy);
        assert.ok(Math.abs(Math.hypot(w.x, w.y) - Math.hypot(dx, dy)) < 1e-9, 'length preserved');
        const s = vp.screenDirFromWorldDir(w.x, w.y);
        assert.ok(Math.abs(s.x - dx) < 1e-9 && Math.abs(s.y - dy) < 1e-9, 'round trip');
      }
    }
  }
});

test('pressing up always moves you toward the opponent', () => {
  // The whole point of the rotation: "forward" is the same gesture for everyone.
  for (const seat of SEATS) {
    for (const orientation of ORIENTATIONS) {
      const vp = fakeViewport(seat, orientation, 900, 1600);
      const forwardOnScreen = orientation === 'landscape' ? [1, 0] : [0, -1];
      const w = vp.worldDirFromScreenDir(forwardOnScreen[0]!, forwardOnScreen[1]!);
      const toOpponent = seat === 0 ? 1 : -1;
      assert.ok(Math.abs(w.x - toOpponent) < 1e-9 && Math.abs(w.y) < 1e-9,
        `seat ${seat} ${orientation}: forward is world x=${toOpponent}`);
    }
  }
});

test('quarter turns are distinct per seat and parity follows orientation', () => {
  assert.equal(quarterTurnsFor(0, 'landscape'), 0);
  assert.equal(quarterTurnsFor(1, 'landscape'), 2);
  assert.equal(quarterTurnsFor(0, 'portrait'), 3);
  assert.equal(quarterTurnsFor(1, 'portrait'), 1);
  for (const orientation of ORIENTATIONS) {
    for (const seat of SEATS) {
      const odd = quarterTurnsFor(seat, orientation) % 2 === 1;
      assert.equal(odd, orientation === 'portrait', 'odd turns swap the axes');
    }
  }
});
