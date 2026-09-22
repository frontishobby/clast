/**
 * Neon look on plain Canvas2D.
 *
 * `ctx.shadowBlur` is the obvious way to glow and it is far too slow to use
 * per-entity, so instead every shape is stroked three times with additive
 * blending: a wide dim halo, a mid bloom, and a tight bright core.
 */

export type PathFn = (ctx: CanvasRenderingContext2D) => void;

export const PALETTE = {
  bg: '#05060a',
  field: '#0a0d18',
  grid: '#16203a',
  wall: '#33406b',
  seat0: '#3df2ff',
  seat1: '#ff3ddc',
  block: '#6a7cff',
  blockHurt: '#ffb03d',
  zone: '#ff5470',
  pickup: '#7dff8a',
  text: '#cfd8ff',
  dim: '#5a6690',

  dagger: '#7dff8a',
  spear: '#63d7ff',
  hammer: '#ffb03d',
  shard: '#c08bff',
  bomb: '#ff6a4d',
} as const;

const LAYERS: ReadonlyArray<{ mul: number; alpha: number }> = [
  { mul: 7, alpha: 0.1 },
  { mul: 3, alpha: 0.22 },
  { mul: 1, alpha: 1 },
];

export function neonStroke(
  ctx: CanvasRenderingContext2D,
  path: PathFn,
  color: string,
  width: number,
  intensity = 1,
): void {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const layer of LAYERS) {
    ctx.globalAlpha = layer.alpha * intensity;
    ctx.lineWidth = width * layer.mul;
    ctx.beginPath();
    path(ctx);
    ctx.stroke();
  }
  ctx.restore();
}

/** Filled shape with a soft additive rim. */
export function neonFill(
  ctx: CanvasRenderingContext2D,
  path: PathFn,
  color: string,
  fill: string,
  width: number,
  intensity = 1,
): void {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.beginPath();
  path(ctx);
  ctx.fill();
  ctx.restore();
  neonStroke(ctx, path, color, width, intensity);
}

export const rectPath =
  (x: number, y: number, w: number, h: number): PathFn =>
  (ctx) =>
    ctx.rect(x, y, w, h);

export const circlePath =
  (x: number, y: number, r: number): PathFn =>
  (ctx) =>
    ctx.arc(x, y, r, 0, Math.PI * 2);

export const linePath =
  (x0: number, y0: number, x1: number, y1: number): PathFn =>
  (ctx) => {
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
  };

/** Regular n-gon, used for the shard motif. */
export const polyPath =
  (x: number, y: number, r: number, sides: number, rot = 0): PathFn =>
  (ctx) => {
    for (let i = 0; i < sides; i++) {
      const a = rot + (i / sides) * Math.PI * 2;
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  };
