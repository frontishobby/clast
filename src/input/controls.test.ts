import assert from 'node:assert/strict';
import test from 'node:test';

import { STICK_RADIUS, stickVector } from './touch.ts';
import { BUTTON, GamepadSource, padVector } from './gamepad.ts';

test('a thumb resting inside the deadzone produces nothing', () => {
  // A stationary thumb drifts by a few pixels; that must not creep.
  const r = stickVector(100, 100, 104, 97, 0.16);
  assert.equal(r.mag, 0);
  assert.equal(r.x, 0);
  assert.equal(r.y, 0);
});

test('the deadzone is rescaled, not clipped', () => {
  // Clipping means the first usable push jumps straight to 0.16 speed.
  const deadzone = 0.2;
  const justOutside = stickVector(0, 0, STICK_RADIUS * (deadzone + 0.001), 0, deadzone);
  assert.ok(justOutside.mag > 0 && justOutside.mag < 0.02, `got ${justOutside.mag}`);

  const full = stickVector(0, 0, STICK_RADIUS, 0, deadzone);
  assert.ok(Math.abs(full.mag - 1) < 1e-6, 'a full push still reaches 1');
});

test('a push past the ring saturates instead of overshooting', () => {
  const r = stickVector(0, 0, STICK_RADIUS * 4, 0, 0.16);
  assert.ok(Math.abs(r.mag - 1) < 1e-6);
  assert.ok(Math.abs(Math.hypot(r.x, r.y) - 1) < 1e-6);
});

test('stick direction is preserved on every diagonal', () => {
  for (const [dx, dy] of [
    [1, 1],
    [-1, 2],
    [0, -1],
    [3, -4],
  ] as const) {
    const len = Math.hypot(dx, dy);
    const r = stickVector(50, 50, 50 + dx * STICK_RADIUS / len, 50 + dy * STICK_RADIUS / len, 0.15);
    assert.ok(Math.abs(r.x / r.mag - dx / len) < 1e-6, `x for ${dx},${dy}`);
    assert.ok(Math.abs(r.y / r.mag - dy / len) < 1e-6, `y for ${dx},${dy}`);
  }
});

test('gamepad sticks use a radial deadzone, not a square one', () => {
  // A square deadzone lets a diagonal through that an axis-aligned push of the
  // same magnitude would swallow, so slow diagonal walking gets jittery.
  const deadzone = 0.3;
  const diagonal = padVector(0.21, 0.21, deadzone); // length 0.297
  assert.equal(diagonal.mag, 0, 'inside the circle, so ignored');

  const straight = padVector(0.31, 0, deadzone);
  assert.ok(straight.mag > 0, 'outside the circle, so accepted');
});

test('a full gamepad push is a unit vector', () => {
  const r = padVector(0.7071, 0.7071);
  assert.ok(Math.abs(r.mag - 1) < 1e-3, `mag ${r.mag}`);
  assert.ok(Math.abs(Math.hypot(r.x, r.y) - 1) < 1e-3);
});

/** Minimal fake pad so the source can be driven without hardware. */
function fakePad(overrides: { axes?: number[]; buttons?: number[] } = {}): Gamepad {
  const axes = overrides.axes ?? [0, 0, 0, 0];
  const down = new Set(overrides.buttons ?? []);
  return {
    connected: true,
    axes,
    buttons: Array.from({ length: 16 }, (_, i) => ({
      pressed: down.has(i),
      touched: down.has(i),
      value: down.has(i) ? 1 : 0,
    })),
    id: 'fake',
    index: 0,
    mapping: 'standard',
    timestamp: 0,
    vibrationActuator: null,
  } as unknown as Gamepad;
}

function withPad(pad: Gamepad | null, fn: (src: GamepadSource) => void): void {
  fn(new GamepadSource(() => [pad]));
}

test('no gamepad means no phantom input', () => {
  withPad(null, (src) => {
    src.poll(0);
    assert.equal(src.connected, false);
    assert.equal(src.move.mag, 0);
    assert.equal(src.attack, false);
  });
});

test('buttons report a single press, not one per frame', () => {
  const pad = fakePad({ buttons: [BUTTON.confirm] });
  withPad(pad, (src) => {
    src.poll(0);
    assert.equal(src.pressed(BUTTON.confirm), true, 'fires on the frame it goes down');
    src.poll(16);
    assert.equal(src.pressed(BUTTON.confirm), false, 'not again while held');
    assert.equal(src.attack, true, 'but attack stays held');
  });
});

test('menu direction fires once, then auto-repeats', () => {
  // Holding down should scroll, but a tap must move exactly one row.
  const pad = fakePad({ buttons: [BUTTON.dpadDown] });
  withPad(pad, (src) => {
    src.poll(0);
    assert.equal(src.menuStep, 1, 'immediate first step');

    let steps = 0;
    for (let t = 16; t <= 400; t += 16) {
      src.poll(t);
      steps += Math.abs(src.menuStep);
    }
    assert.equal(steps, 0, 'silent through the repeat delay');

    for (let t = 416; t <= 1200; t += 16) {
      src.poll(t);
      steps += Math.abs(src.menuStep);
    }
    assert.ok(steps >= 2 && steps <= 6, `repeated ${steps} times over ~0.8s`);
  });
});

test('the right trigger attacks as well as the face button', () => {
  withPad(fakePad({ buttons: [BUTTON.rightTrigger] }), (src) => {
    src.poll(0);
    assert.equal(src.attack, true);
  });
});

test('shoving the aim stick attacks without a button', () => {
  // Twin-stick reflex: pushing the right stick should already be firing.
  withPad(fakePad({ axes: [0, 0, 0.9, 0] }), (src) => {
    src.poll(0);
    assert.ok(src.aim.mag > 0.65);
    assert.equal(src.attack, true);
  });
  withPad(fakePad({ axes: [0, 0, 0.4, 0] }), (src) => {
    src.poll(0);
    assert.equal(src.attack, false, 'a gentle aim adjustment does not swing');
  });
});
