import { rotQuarter, type Rect, type Vec2 } from '../core/math.ts';

/**
 * The world is ALWAYS this canonical landscape rectangle, on every client,
 * in every orientation. Nothing below the renderer knows that portrait exists.
 */
export const WORLD_W = 1280;
export const WORLD_H = 720;
export const WORLD_ASPECT = WORLD_W / WORLD_H;

export type Orientation = 'landscape' | 'portrait';

/** Which side of the canonical arena you spawn on. */
export type Seat = 0 | 1;

/**
 * Quarter turns (clockwise, screen space) applied between world and screen.
 *
 *            landscape   portrait
 *   seat 0        0           3
 *   seat 1        2           1
 *
 * Seat 0 spawns at world-left and seat 1 at world-right, so this table puts
 * your own spawn at screen-left in landscape and screen-bottom in portrait,
 * with the opponent opposite you, on every client.
 *
 * An odd turn count swaps the axes, so the same 16:9 world fills a 9:16
 * letterbox exactly: a portrait player and a landscape player see an identical
 * arena differing only by rotation.
 */
export function quarterTurnsFor(seat: Seat, orientation: Orientation): 0 | 1 | 2 | 3 {
  return ((seat * 2 + (orientation === 'portrait' ? 3 : 0)) % 4) as 0 | 1 | 2 | 3;
}

export interface ViewportLayout {
  /** CSS pixels of the whole window. */
  cssW: number;
  cssH: number;
  dpr: number;
  orientation: Orientation;
  quarterTurns: 0 | 1 | 2 | 3;
  /** Letterbox content box, in CSS pixels. Everything outside is a black bar. */
  boxX: number;
  boxY: number;
  boxW: number;
  boxH: number;
  /** CSS pixels per logical pixel inside the letterbox. */
  boxScale: number;
  /** Logical letterbox size: 1280x720 landscape, 720x1280 portrait. */
  logicalW: number;
  logicalH: number;
}

export class Viewport {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;

  seat: Seat = 0;
  /** Set to force an orientation for testing; null follows the window. */
  orientationOverride: Orientation | null = null;

  /** The slice of the world currently shown. Aspect must match WORLD_ASPECT. */
  camera: Rect = { cx: WORLD_W / 2, cy: WORLD_H / 2, w: WORLD_W, h: WORLD_H };

  layout: ViewportLayout;

  /** Logical letterbox pixels per world unit. 1 when fully zoomed out. */
  zoom = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.layout = this.measure();
  }

  private measure(): ViewportLayout {
    const cssW = Math.max(1, window.innerWidth);
    const cssH = Math.max(1, window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const orientation: Orientation =
      this.orientationOverride ?? (cssW >= cssH ? 'landscape' : 'portrait');
    const quarterTurns = quarterTurnsFor(this.seat, orientation);

    const logicalW = orientation === 'landscape' ? WORLD_W : WORLD_H;
    const logicalH = orientation === 'landscape' ? WORLD_H : WORLD_W;

    const boxScale = Math.min(cssW / logicalW, cssH / logicalH);
    const boxW = logicalW * boxScale;
    const boxH = logicalH * boxScale;

    return {
      cssW,
      cssH,
      dpr,
      orientation,
      quarterTurns,
      boxX: (cssW - boxW) / 2,
      boxY: (cssH - boxH) / 2,
      boxW,
      boxH,
      boxScale,
      logicalW,
      logicalH,
    };
  }

  /** Re-read the window and resize the backing store. Call on resize + seat change. */
  resize(): void {
    this.layout = this.measure();
    const { cssW, cssH, dpr } = this.layout;
    const bw = Math.round(cssW * dpr);
    const bh = Math.round(cssH * dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
  }

  private computeZoom(): number {
    const { quarterTurns, logicalW } = this.layout;
    const odd = quarterTurns % 2 === 1;
    return logicalW / (odd ? this.camera.h : this.camera.w);
  }

  /** Clear the whole surface, including the letterbox bars. */
  clear(bars = '#05060a'): void {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = bars;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  /**
   * Screen space: origin at the letterbox top-left, sized logicalW x logicalH.
   * HUD, joysticks and text live here so they never end up rotated.
   */
  beginScreen(): void {
    const { ctx } = this;
    const { dpr, boxX, boxY, boxScale } = this.layout;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(boxX, boxY);
    ctx.scale(boxScale, boxScale);
  }

  /**
   * World space. Composed as:
   *   screen <- letterbox(fit+center) <- rotate(q) <- zoom <- camera pan <- world
   */
  beginWorld(): void {
    this.beginScreen();
    const { ctx } = this;
    const { quarterTurns, logicalW, logicalH } = this.layout;
    const z = (this.zoom = this.computeZoom());

    ctx.translate(logicalW / 2, logicalH / 2);
    ctx.scale(z, z);
    ctx.rotate((quarterTurns * Math.PI) / 2);
    ctx.translate(-this.camera.cx, -this.camera.cy);
  }

  /** Clip drawing to the letterbox so nothing bleeds into the bars. */
  clipToBox(): void {
    const { ctx } = this;
    const { dpr, boxX, boxY, boxW, boxH } = this.layout;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    ctx.rect(boxX, boxY, boxW, boxH);
    ctx.clip();
  }

  /** World units per logical letterbox pixel — for constant-thickness strokes. */
  get worldPerPx(): number {
    return 1 / this.computeZoom();
  }

  // --- inverse transforms: screen -> world -------------------------------

  /** A CSS-pixel point (pointer event) to world coordinates. */
  worldFromClient(clientX: number, clientY: number): Vec2 {
    const { boxX, boxY, boxScale, logicalW, logicalH, quarterTurns } = this.layout;
    const z = this.computeZoom();

    const lx = (clientX - boxX) / boxScale - logicalW / 2;
    const ly = (clientY - boxY) / boxScale - logicalH / 2;

    const un = rotQuarter(lx / z, ly / z, -quarterTurns);
    return { x: un.x + this.camera.cx, y: un.y + this.camera.cy };
  }

  /**
   * A *direction* the player expressed on their own screen (WASD, a joystick
   * push, a swipe) to a world-space direction. Translation-free, so this is
   * what makes "up is up on my screen" true in every orientation and seat.
   */
  worldDirFromScreenDir(dx: number, dy: number): Vec2 {
    return rotQuarter(dx, dy, -this.layout.quarterTurns);
  }

  /** The reverse: a world direction as it appears on this client's screen. */
  screenDirFromWorldDir(dx: number, dy: number): Vec2 {
    return rotQuarter(dx, dy, this.layout.quarterTurns);
  }

  /** A CSS-pixel point to letterbox-logical screen space (for HUD hit-testing). */
  screenFromClient(clientX: number, clientY: number): Vec2 {
    const { boxX, boxY, boxScale } = this.layout;
    return { x: (clientX - boxX) / boxScale, y: (clientY - boxY) / boxScale };
  }
}
