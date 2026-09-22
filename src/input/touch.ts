import type { Viewport } from '../view/viewport.ts';

/**
 * Left half is a floating move stick; right half is one big attack button.
 *
 * Floating rather than fixed, because a fixed stick means looking down to find
 * it. Wherever a thumb lands becomes the centre, so you can play without
 * taking your eyes off the arena.
 *
 * There is deliberately no aim stick. Steering two sticks at once is the hard
 * part of twin-stick on glass, so you swing where you last walked and the
 * right thumb only has to tap.
 *
 * Everything here is in letterbox screen space and produces screen-relative
 * directions, exactly like WASD. The viewport turns those into world space, so
 * portrait, landscape and either seat all behave identically.
 */

export const STICK_RADIUS = 92;
const MOVE_DEADZONE = 0.16;

export interface StickReading {
  /** Unit-ish direction in screen space; zero inside the deadzone. */
  x: number;
  y: number;
  /** 0..1 past the deadzone. */
  mag: number;
}

/**
 * Offset from the stick's origin to a normalised direction.
 * Rescaled past the deadzone so the first usable input is not a jump to 0.16.
 */
export function stickVector(
  ox: number,
  oy: number,
  px: number,
  py: number,
  deadzone: number,
  radius = STICK_RADIUS,
): StickReading {
  const dx = px - ox;
  const dy = py - oy;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return { x: 0, y: 0, mag: 0 };

  const raw = Math.min(1, dist / radius);
  if (raw < deadzone) return { x: 0, y: 0, mag: 0 };

  const mag = (raw - deadzone) / (1 - deadzone);
  return { x: (dx / dist) * mag, y: (dy / dist) * mag, mag };
}

export interface Stick {
  pointerId: number;
  /** Where the thumb first landed, in screen space. */
  ox: number;
  oy: number;
  /** Current thumb position, clamped to the ring for drawing. */
  kx: number;
  ky: number;
  reading: StickReading;
  /** Milliseconds since it went down, for tap detection. */
  downAt: number;
  moved: boolean;
}

/** A finger held on the attack side. Position is only kept for drawing. */
export interface Press {
  pointerId: number;
  x: number;
  y: number;
}

export class TouchSticks {
  move: Stick | null = null;
  attack: Press | null = null;
  /** Flips on the first touch, so the sticks never show on a mouse-only run. */
  engaged = false;

  private vp: Viewport;

  constructor(vp: Viewport, canvas: HTMLCanvasElement) {
    this.vp = vp;

    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      this.engaged = true;
      const p = this.vp.screenFromClient(e.clientX, e.clientY);
      const rightHalf = p.x > this.vp.layout.logicalW / 2;
      if (rightHalf) {
        if (this.attack) return; // one thumb per side
        this.attack = { pointerId: e.pointerId, x: p.x, y: p.y };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (this.move) return;
      this.move = {
        pointerId: e.pointerId,
        ox: p.x,
        oy: p.y,
        kx: p.x,
        ky: p.y,
        reading: { x: 0, y: 0, mag: 0 },
        downAt: e.timeStamp,
        moved: false,
      };
      canvas.setPointerCapture(e.pointerId);
    };

    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      const p = this.vp.screenFromClient(e.clientX, e.clientY);
      if (this.attack?.pointerId === e.pointerId) {
        this.attack.x = p.x;
        this.attack.y = p.y;
        return;
      }
      const stick = this.move;
      if (stick?.pointerId !== e.pointerId) return;
      stick.reading = stickVector(stick.ox, stick.oy, p.x, p.y, MOVE_DEADZONE);
      if (stick.reading.mag > 0) stick.moved = true;

      // Let the origin trail a thumb that has run past the ring, so a long
      // drag does not saturate and become undraggable.
      const dx = p.x - stick.ox;
      const dy = p.y - stick.oy;
      const dist = Math.hypot(dx, dy);
      if (dist > STICK_RADIUS) {
        stick.ox = p.x - (dx / dist) * STICK_RADIUS;
        stick.oy = p.y - (dy / dist) * STICK_RADIUS;
      }
      stick.kx = p.x;
      stick.ky = p.y;
    };

    const up = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      if (this.move?.pointerId === e.pointerId) this.move = null;
      if (this.attack?.pointerId === e.pointerId) this.attack = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  }

  /** Screen-space movement direction. */
  moveDir(): StickReading {
    return this.move?.reading ?? { x: 0, y: 0, mag: 0 };
  }

  /**
   * Touching the right side at all swings, toward wherever you are facing.
   * Holding keeps swinging on the weapon's cooldown.
   */
  get attacking(): boolean {
    return this.attack !== null;
  }

  reset(): void {
    this.move = null;
    this.attack = null;
  }
}
