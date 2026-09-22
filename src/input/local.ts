import type { PlayerInput } from '../game/sim.ts';
import type { Viewport } from '../view/viewport.ts';
import { GamepadSource } from './gamepad.ts';
import type { Keyboard } from './keyboard.ts';
import { TouchSticks } from './touch.ts';

/**
 * Merges every way a person can drive their character into one PlayerInput.
 *
 * Everything the player expresses is screen-relative -- W is up on *their*
 * display, a thumb push is toward the top of *their* phone -- so this is the
 * single place the view rotation is undone. The sim never learns that portrait
 * or a second seat exist.
 */
export class LocalInput {
  readonly touch: TouchSticks;
  readonly pad = new GamepadSource();

  private vp: Viewport;
  private keys: Keyboard;
  private pointerWorld = { x: 0, y: 0 };
  private pointerActive = false;
  private pointerDown = false;
  private lastAim = 0;

  constructor(vp: Viewport, keys: Keyboard, canvas: HTMLCanvasElement) {
    this.vp = vp;
    this.keys = keys;
    this.touch = new TouchSticks(vp, canvas);

    const track = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const w = this.vp.worldFromClient(e.clientX, e.clientY);
      this.pointerWorld.x = w.x;
      this.pointerWorld.y = w.y;
      this.pointerActive = true;
    };

    canvas.addEventListener('pointermove', track);
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      track(e);
      this.pointerDown = true;
    });
    const up = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      this.pointerDown = false;
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', () => {
      this.pointerDown = false;
      this.touch.reset();
    });
  }

  /** Poll the gamepad once per frame, before sampling. */
  poll(): void {
    this.pad.poll();
  }

  sample(fromX: number, fromY: number): PlayerInput {
    // Movement: whichever source is actually being pushed wins, checked in
    // order of how deliberate it is.
    const thumb = this.touch.moveDir();
    const keyAxis = this.keys.moveAxis();
    const screenMove =
      thumb.mag > 0
        ? thumb
        : this.pad.move.mag > 0
          ? this.pad.move
          : { x: keyAxis.x, y: keyAxis.y };
    const move = this.vp.worldDirFromScreenDir(screenMove.x, screenMove.y);

    const thumbAim = this.touch.aimDir();
    const padAim = this.pad.aim.mag > 0 ? this.pad.aim : null;
    if (thumbAim || padAim) {
      const a = (thumbAim ?? padAim)!;
      const w = this.vp.worldDirFromScreenDir(a.x, a.y);
      this.lastAim = Math.atan2(w.y, w.x);
    } else if (this.pointerActive && !this.touch.engaged) {
      const dx = this.pointerWorld.x - fromX;
      const dy = this.pointerWorld.y - fromY;
      // Ignore a pointer sitting on top of the player, it produces jitter.
      if (dx * dx + dy * dy > 16) this.lastAim = Math.atan2(dy, dx);
    } else if (move.x !== 0 || move.y !== 0) {
      // No aiming device in use: you face where you walk.
      this.lastAim = Math.atan2(move.y, move.x);
    }

    return {
      moveX: move.x,
      moveY: move.y,
      aim: this.lastAim,
      attack:
        this.touch.attacking ||
        this.pad.attack ||
        this.pointerDown ||
        this.keys.held('Space'),
    };
  }
}
