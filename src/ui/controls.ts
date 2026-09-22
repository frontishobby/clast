import { STICK_RADIUS, type TouchSticks } from '../input/touch.ts';
import { PALETTE, circlePath, neonStroke, polyPath } from '../view/neon.ts';
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

/**
 * Shown when a touch device is held landscape.
 *
 * Mobile is locked to portrait, so a sideways phone would otherwise get a
 * letterboxed sliver of a playfield with no explanation.
 */
export function drawRotateHint(vp: Viewport, time: number): void {
  const ctx = vp.ctx;
  const { logicalW, logicalH } = vp.layout;

  ctx.save();
  ctx.fillStyle = 'rgba(5,6,10,0.88)';
  ctx.fillRect(0, 0, logicalW, logicalH);
  ctx.restore();

  const cx = logicalW / 2;
  const cy = logicalH / 2 - 40;
  const wobble = Math.sin(time * 2) * 0.22;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(wobble);
  // A phone outline, rocking toward upright.
  neonStroke(
    ctx,
    (c) => {
      c.rect(-42, -70, 84, 140);
    },
    PALETTE.seat0,
    2.4,
  );
  neonStroke(ctx, circlePath(0, 52, 5), PALETTE.seat0, 2, 0.7);
  ctx.restore();

  neonStroke(ctx, polyPath(cx, cy + 118, 13, 3, -Math.PI / 2), PALETTE.dim, 1.6, 0.5);

  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = '700 26px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = PALETTE.text;
  ctx.fillText('HOLD IT UPRIGHT', cx, cy + 160);
  ctx.font = '15px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = PALETTE.dim;
  ctx.fillText('shard is played in portrait', cx, cy + 190);
  ctx.restore();
}
