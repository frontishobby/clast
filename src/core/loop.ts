/**
 * Fixed-timestep simulation with an interpolated render pass.
 *
 * The sim must never observe a variable dt: the netcode (host-authoritative,
 * with the guest predicting its own movement) and the seeded world generation
 * both assume every tick advances by exactly `stepMs`.
 */
export interface LoopOptions {
  stepMs: number;
  /** Ticks to run in one frame before we give up and drop time. */
  maxCatchUp?: number;
  update: (stepSeconds: number) => void;
  /** alpha is 0..1 between the previous and current sim state. */
  render: (alpha: number, frameSeconds: number) => void;
}

export function startLoop(opts: LoopOptions): () => void {
  const { stepMs, update, render } = opts;
  const maxCatchUp = opts.maxCatchUp ?? 5;
  const stepSeconds = stepMs / 1000;

  let acc = 0;
  let last = performance.now();
  let raf = 0;
  let running = true;

  const frame = (now: number) => {
    if (!running) return;
    raf = requestAnimationFrame(frame);

    const frameMs = Math.min(now - last, 250);
    last = now;
    acc += frameMs;

    let steps = 0;
    while (acc >= stepMs && steps < maxCatchUp) {
      update(stepSeconds);
      acc -= stepMs;
      steps++;
    }
    // Tab was backgrounded or the machine stalled: drop the backlog rather
    // than fast-forwarding, which would teleport everything.
    if (acc >= stepMs) acc = 0;

    render(acc / stepMs, frameMs / 1000);
  };

  raf = requestAnimationFrame(frame);

  return () => {
    running = false;
    cancelAnimationFrame(raf);
  };
}
