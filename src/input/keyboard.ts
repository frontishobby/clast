export class Keyboard {
  private down = new Set<string>();
  private pressedThisFrame = new Set<string>();

  constructor(target: Window | HTMLElement = window) {
    target.addEventListener('keydown', (e) => {
      const ev = e as KeyboardEvent;
      if (ev.repeat) return;
      this.down.add(ev.code);
      this.pressedThisFrame.add(ev.code);
    });
    target.addEventListener('keyup', (e) => {
      this.down.delete((e as KeyboardEvent).code);
    });
    window.addEventListener('blur', () => this.down.clear());
  }

  held(code: string): boolean {
    return this.down.has(code);
  }

  /** True only on the frame the key went down. Call endFrame() once per frame. */
  pressed(code: string): boolean {
    return this.pressedThisFrame.has(code);
  }

  endFrame(): void {
    this.pressedThisFrame.clear();
  }

  /** WASD/arrows as a normalized direction in SCREEN space (y-down). */
  moveAxis(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    if (this.held('KeyA') || this.held('ArrowLeft')) x -= 1;
    if (this.held('KeyD') || this.held('ArrowRight')) x += 1;
    if (this.held('KeyW') || this.held('ArrowUp')) y -= 1;
    if (this.held('KeyS') || this.held('ArrowDown')) y += 1;
    const len = Math.hypot(x, y);
    return len > 0 ? { x: x / len, y: y / len } : { x: 0, y: 0 };
  }
}
