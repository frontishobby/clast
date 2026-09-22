export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Smooth 0..1 ramp. */
export const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  /** center x */
  cx: number;
  /** center y */
  cy: number;
  w: number;
  h: number;
}

export const rectLeft = (r: Rect) => r.cx - r.w / 2;
export const rectTop = (r: Rect) => r.cy - r.h / 2;

/**
 * Rotate (x, y) by `q` quarter turns clockwise in screen space (y-down).
 * q is taken mod 4 and may be negative.
 */
export function rotQuarter(x: number, y: number, q: number): Vec2 {
  switch (((q % 4) + 4) % 4) {
    case 1:
      return { x: -y, y: x };
    case 2:
      return { x: -x, y: -y };
    case 3:
      return { x: y, y: -x };
    default:
      return { x, y };
  }
}
