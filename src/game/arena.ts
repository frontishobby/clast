import { Rng } from '../core/rng.ts';
import { WORLD_H, WORLD_W } from '../view/viewport.ts';

export const CELL = 40;
export const GRID_W = WORLD_W / CELL; // 32
export const GRID_H = WORLD_H / CELL; // 18

export const BLOCK_MAX_HP = 3;

/** Spawn points in canonical world space. Seat 0 is left, seat 1 is right. */
export const SPAWNS = [
  { x: CELL * 2.5, y: WORLD_H / 2 },
  { x: WORLD_W - CELL * 2.5, y: WORLD_H / 2 },
] as const;

const SPAWN_CLEAR_RADIUS = CELL * 2.6;

/**
 * Cover is built from small clumps rather than per-cell noise. Scattered
 * single blocks read as visual static and give a melee player nothing to hide
 * behind; a handful of 2-4 cell chunks leaves the field open to move through
 * while still breaking line of sight.
 */
export interface LayoutTuning {
  /**
   * Fraction of the grid to cover, 0..1. Clumps are added until this is met,
   * rather than a fixed clump count being rolled: a count lets the seed decide
   * the density, and an 8%-cover map and a 17%-cover map play nothing alike.
   */
  targetDensity: number;
  minSize: number;
  maxSize: number;
  /** 0 = clumps spread evenly, 1 = all crowded onto the centre line. */
  midfieldBias: number;
}

export const DEFAULT_LAYOUT: LayoutTuning = {
  targetDensity: 0.125,
  minSize: 1,
  maxSize: 4,
  midfieldBias: 0.6,
};

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

export class Arena {
  /** Remaining HP per cell, 0 = empty. Row-major, GRID_W * GRID_H. */
  readonly hp: Uint8Array;
  readonly seed: number;
  readonly tuning: LayoutTuning;

  constructor(seed: number, tuning: LayoutTuning = DEFAULT_LAYOUT) {
    this.seed = seed;
    this.tuning = tuning;
    this.hp = new Uint8Array(GRID_W * GRID_H);
    this.generate();
  }

  idx(gx: number, gy: number): number {
    return gy * GRID_W + gx;
  }

  hpAt(gx: number, gy: number): number {
    if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return 0;
    return this.hp[this.idx(gx, gy)];
  }

  /** Live blocks on the field. */
  count(): number {
    let n = 0;
    for (let i = 0; i < this.hp.length; i++) if (this.hp[i] > 0) n++;
    return n;
  }

  /** Fraction of the grid occupied, 0..1. */
  density(): number {
    return this.count() / this.hp.length;
  }

  private placeable(gx: number, gy: number, half: number): boolean {
    if (gx < 0 || gx >= half || gy < 0 || gy >= GRID_H) return false;
    if (this.hp[this.idx(gx, gy)] > 0) return false;
    const cx = (gx + 0.5) * CELL;
    const cy = (gy + 0.5) * CELL;
    return Math.hypot(cx - SPAWNS[0].x, cy - SPAWNS[0].y) >= SPAWN_CLEAR_RADIUS;
  }

  /**
   * Point-symmetric layout: whatever seat 0 faces, seat 1 faces the same thing
   * rotated 180 degrees. Combined with the per-seat view rotation this means
   * both players literally see the same picture.
   *
   * Only the left half is generated; the right half is its mirror. Because the
   * mirror flips both axes, a clump near the centre line lands on a different
   * row and no seam is visible.
   */
  private generate(): void {
    const { targetDensity, minSize, maxSize, midfieldBias } = this.tuning;
    const rng = new Rng(this.seed);
    const half = Math.floor(GRID_W / 2);
    const target = Math.round((targetDensity * GRID_W * GRID_H) / 2);

    const frontier: Array<[number, number]> = [];
    let placed = 0;
    // Bounded so a saturated or over-tuned field cannot spin forever.
    let guard = target * 40 + 64;

    while (placed < target && guard-- > 0) {
      // Bias toward midfield so the contested middle has the most cover.
      const u = rng.next();
      const t = midfieldBias > 0 ? u ** (1 - midfieldBias * 0.8) : u;
      let gx = Math.min(half - 1, Math.floor(t * half));
      let gy = rng.int(0, GRID_H);

      // Nudge off a bad seed rather than dropping the whole clump.
      let tries = 0;
      while (!this.placeable(gx, gy, half) && tries++ < 12) {
        gx = rng.int(0, half);
        gy = rng.int(0, GRID_H);
      }
      if (!this.placeable(gx, gy, half)) continue;

      // Clip the last clump so hitting the target never overshoots.
      const size = Math.min(rng.int(minSize, maxSize + 1), target - placed);
      frontier.length = 0;
      frontier.push([gx, gy]);
      this.hp[this.idx(gx, gy)] = BLOCK_MAX_HP;
      placed++;

      for (let grown = 1; grown < size && frontier.length > 0; ) {
        const from = frontier[rng.int(0, frontier.length)]!;
        const [dx, dy] = rng.pick(NEIGHBOURS);
        const nx = from[0] + dx;
        const ny = from[1] + dy;
        if (!this.placeable(nx, ny, half)) {
          // Give up on this clump if the walk keeps dead-ending.
          if (rng.chance(0.25)) break;
          continue;
        }
        this.hp[this.idx(nx, ny)] = BLOCK_MAX_HP;
        frontier.push([nx, ny]);
        placed++;
        grown++;
      }
    }

    // Mirror the left half onto the right.
    for (let gy = 0; gy < GRID_H; gy++) {
      for (let gx = 0; gx < half; gx++) {
        if (this.hp[this.idx(gx, gy)] > 0) {
          this.hp[this.idx(GRID_W - 1 - gx, GRID_H - 1 - gy)] = BLOCK_MAX_HP;
        }
      }
    }
  }
}
