import { STICK_RADIUS, type TouchSticks } from '../input/touch.ts';
import { PALETTE, circlePath, neonStroke } from '../view/neon.ts';
import type { Viewport } from '../view/viewport.ts';

/**
 * The on-screen sticks. Drawn in screen space, so they stay upright and
 * thumb-sized whatever the world is doing.
 */
export function drawSticks(vp: Viewport, sticks: TouchSticks): void {
  const ctx = vp.ctx;
  if (!sticks.engaged) return;

  for (const [stick, color] of [
    [sticks.move, PALETTE.seat0],
    [sticks.aim, PALETTE.hammer],
  ] as const) {
    if (!stick) continue;
    const r = stick.reading;
    const kx = stick.ox + r.x * STICK_RADIUS;
    const ky = stick.oy + r.y * STICK_RADIUS;

    neonStroke(ctx, circlePath(stick.ox, stick.oy, STICK_RADIUS), color, 1.6, 0.35);
    neonStroke(ctx, circlePath(kx, ky, 30), color, 2.2, 0.85);
    if (r.mag > 0) {
      neonStroke(ctx, circlePath(kx, ky, 9), color, 2, 1);
    }
  }
}
