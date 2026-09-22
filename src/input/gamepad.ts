/**
 * Gamepad support via the standard mapping.
 *
 * Sticks produce screen-relative directions like every other input source, so
 * the viewport rotation handles seat and orientation without this file knowing
 * either exists.
 */

const STICK_DEADZONE = 0.22;
const TRIGGER_THRESHOLD = 0.3;
/** Repeat rate when a menu direction is held, in milliseconds. */
const REPEAT_MS = 220;
const REPEAT_DELAY_MS = 420;

export const BUTTON = {
  confirm: 0, // A / cross
  back: 1, // B / circle
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
  rightTrigger: 7,
  rightBumper: 5,
} as const;

export interface PadVector {
  x: number;
  y: number;
  mag: number;
}

const ZERO: PadVector = { x: 0, y: 0, mag: 0 };

/** Radial deadzone, rescaled so the first usable input is not a jump. */
export function padVector(ax: number, ay: number, deadzone = STICK_DEADZONE): PadVector {
  const dist = Math.hypot(ax, ay);
  if (dist < deadzone) return ZERO;
  const mag = Math.min(1, (dist - deadzone) / (1 - deadzone));
  return { x: (ax / dist) * mag, y: (ay / dist) * mag, mag };
}

export type PadReader = () => readonly (Gamepad | null)[];

const browserPads: PadReader = () =>
  typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];

export class GamepadSource {
  connected = false;
  move: PadVector = ZERO;
  aim: PadVector = ZERO;
  attack = false;

  private held = new Set<number>();
  private justPressed = new Set<number>();
  /** Menu direction with auto-repeat: -1 up, 1 down, 0 none. */
  menuStep = 0;
  private menuDir = 0;
  private menuSince = 0;
  private menuRepeats = 0;

  /**
   * Injectable so tests can drive a fake pad. Reaching for the global
   * navigator instead is not an option -- it is a getter-only property, so a
   * test cannot stand in for it without reconfiguring the global object.
   */
  private readPads: PadReader;

  constructor(readPads: PadReader = browserPads) {
    this.readPads = readPads;
  }

  /** Call once per frame before reading anything. */
  poll(now = performance.now()): void {
    this.justPressed.clear();
    this.menuStep = 0;

    const pad = Array.from(this.readPads()).find((p): p is Gamepad => !!p && p.connected);

    if (!pad) {
      if (this.connected) this.clear();
      this.connected = false;
      return;
    }
    this.connected = true;

    this.move = padVector(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
    this.aim = padVector(pad.axes[2] ?? 0, pad.axes[3] ?? 0);

    const pressed = new Set<number>();
    pad.buttons.forEach((b, i) => {
      if (b.pressed || b.value > TRIGGER_THRESHOLD) pressed.add(i);
    });
    for (const i of pressed) if (!this.held.has(i)) this.justPressed.add(i);
    this.held = pressed;

    this.attack =
      pressed.has(BUTTON.confirm) ||
      pressed.has(BUTTON.rightTrigger) ||
      pressed.has(BUTTON.rightBumper) ||
      this.aim.mag > 0.65;

    this.updateMenuRepeat(pad, now);
  }

  /**
   * Menus need a discrete step per press, but holding a direction should still
   * scroll -- so the first press fires immediately, then repeats after a
   * delay.
   */
  private updateMenuRepeat(pad: Gamepad, now: number): void {
    const stickY = padVector(0, pad.axes[1] ?? 0, 0.5).y;
    const dir =
      this.held.has(BUTTON.dpadUp) || stickY < -0.5
        ? -1
        : this.held.has(BUTTON.dpadDown) || stickY > 0.5
          ? 1
          : 0;

    if (dir === 0) {
      this.menuDir = 0;
      this.menuRepeats = 0;
      return;
    }
    if (dir !== this.menuDir) {
      this.menuDir = dir;
      this.menuSince = now;
      this.menuRepeats = 0;
      this.menuStep = dir;
      return;
    }
    const due = REPEAT_DELAY_MS + this.menuRepeats * REPEAT_MS;
    if (now - this.menuSince >= due) {
      this.menuRepeats++;
      this.menuStep = dir;
    }
  }

  /** True only on the frame a button went down. */
  pressed(button: number): boolean {
    return this.justPressed.has(button);
  }

  private clear(): void {
    this.move = ZERO;
    this.aim = ZERO;
    this.attack = false;
    this.held.clear();
    this.justPressed.clear();
    this.menuDir = 0;
  }
}
