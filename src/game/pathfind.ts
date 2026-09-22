import type { Arena } from './arena.ts';
import { CELL, GRID_H, GRID_W } from './arena.ts';

/**
 * A* over the 32x18 arena grid.
 *
 * Blocks are expensive rather than impassable, because they are destructible:
 * costing a wall at roughly what it takes to smash through lets one search
 * answer both "walk around" and "dig through", and the caller just attacks
 * whenever the next step of the path is still solid.
 */

const CELL_COUNT = GRID_W * GRID_H;

const STEP_COST = 10;
/** Flat toll for entering a block at all, on top of its remaining hp. */
const SOLID_BASE = 30;
const SOLID_PER_HP = 22;

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

export class PathFinder {
  private gScore = new Int32Array(CELL_COUNT);
  private fScore = new Int32Array(CELL_COUNT);
  private cameFrom = new Int32Array(CELL_COUNT);
  private closed = new Uint8Array(CELL_COUNT);
  /** Marks which generation last touched a cell, so nothing needs clearing. */
  private seen = new Int32Array(CELL_COUNT);
  private generation = 0;

  private heap = new Int32Array(CELL_COUNT + 1);
  private heapSize = 0;

  private push(cell: number): void {
    let i = ++this.heapSize;
    this.heap[i] = cell;
    while (i > 1) {
      const parent = i >> 1;
      if (this.fScore[this.heap[parent]!]! <= this.fScore[this.heap[i]!]!) break;
      const tmp = this.heap[parent]!;
      this.heap[parent] = this.heap[i]!;
      this.heap[i] = tmp;
      i = parent;
    }
  }

  private pop(): number {
    const top = this.heap[1]!;
    this.heap[1] = this.heap[this.heapSize--]!;
    let i = 1;
    for (;;) {
      const l = i << 1;
      const r = l + 1;
      let best = i;
      if (l <= this.heapSize && this.fScore[this.heap[l]!]! < this.fScore[this.heap[best]!]!) {
        best = l;
      }
      if (r <= this.heapSize && this.fScore[this.heap[r]!]! < this.fScore[this.heap[best]!]!) {
        best = r;
      }
      if (best === i) break;
      const tmp = this.heap[best]!;
      this.heap[best] = this.heap[i]!;
      this.heap[i] = tmp;
      i = best;
    }
    return top;
  }

  /**
   * Fills `out` with cell indices from start to goal, start excluded.
   * Returns false when the goal is off-grid or unreachable.
   */
  find(arena: Arena, sx: number, sy: number, gx: number, gy: number, out: number[]): boolean {
    out.length = 0;
    if (sx < 0 || sy < 0 || sx >= GRID_W || sy >= GRID_H) return false;
    if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return false;

    const start = sy * GRID_W + sx;
    const goal = gy * GRID_W + gx;
    if (start === goal) return true;

    const gen = ++this.generation;
    this.heapSize = 0;

    this.seen[start] = gen;
    this.closed[start] = 0;
    this.gScore[start] = 0;
    this.fScore[start] = (Math.abs(sx - gx) + Math.abs(sy - gy)) * STEP_COST;
    this.cameFrom[start] = -1;
    this.push(start);

    while (this.heapSize > 0) {
      const current = this.pop();
      if (current === goal) {
        for (let c = goal; c !== start && c >= 0; c = this.cameFrom[c]!) out.push(c);
        out.reverse();
        return true;
      }
      if (this.closed[current] === 1) continue;
      this.closed[current] = 1;

      const cx = current % GRID_W;
      const cy = (current / GRID_W) | 0;

      for (const [dx, dy] of NEIGHBOURS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
        const next = ny * GRID_W + nx;
        if (this.seen[next] === gen && this.closed[next] === 1) continue;

        const hp = arena.hpAt(nx, ny);
        const cost = STEP_COST + (hp > 0 ? SOLID_BASE + hp * SOLID_PER_HP : 0);
        const tentative = this.gScore[current]! + cost;

        if (this.seen[next] === gen && tentative >= this.gScore[next]!) continue;

        this.seen[next] = gen;
        this.closed[next] = 0;
        this.cameFrom[next] = current;
        this.gScore[next] = tentative;
        this.fScore[next] = tentative + (Math.abs(nx - gx) + Math.abs(ny - gy)) * STEP_COST;
        this.push(next);
      }
    }

    return false;
  }
}

export const cellOf = (x: number, y: number): [number, number] => [
  Math.min(GRID_W - 1, Math.max(0, Math.floor(x / CELL))),
  Math.min(GRID_H - 1, Math.max(0, Math.floor(y / CELL))),
];

export const cellX = (cell: number): number => cell % GRID_W;
export const cellY = (cell: number): number => (cell / GRID_W) | 0;

export const cellCenter = (cell: number): [number, number] => [
  ((cell % GRID_W) + 0.5) * CELL,
  (((cell / GRID_W) | 0) + 0.5) * CELL,
];

/** Deterministic sampled raycast: is the straight line between two points clear? */
export function lineIsClear(arena: Arena, x0: number, y0: number, x1: number, y1: number): boolean {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.ceil(dist / (CELL * 0.4));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    if (arena.hpAt(Math.floor(x / CELL), Math.floor(y / CELL)) > 0) return false;
  }
  return true;
}
