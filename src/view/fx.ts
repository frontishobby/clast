import { PALETTE } from './neon.ts';
import type { SimEvent } from '../game/sim.ts';
import { WEAPONS } from '../game/weapons.ts';
import { CELL } from '../game/arena.ts';
import { circlePath, neonStroke } from './neon.ts';

/**
 * Cosmetics only. This is the one place allowed to call Math.random, because
 * nothing here feeds back into the simulation: two peers can disagree about
 * where a spark flew without desyncing the match.
 */

interface Shard {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  rot: number;
  spin: number;
  color: string;
}

/** An expanding ring, used for blasts and pickups. */
interface Ring {
  x: number;
  y: number;
  r0: number;
  r1: number;
  life: number;
  maxLife: number;
  width: number;
  color: string;
}

const MAX_SHARDS = 400;

export class Fx {
  private shards: Shard[] = [];
  private rings: Ring[] = [];
  private shakeMag = 0;
  private shakeT = 0;
  /** Screen-space offset the renderer applies to the world pass. */
  shakeX = 0;
  shakeY = 0;

  private spawn(
    x: number,
    y: number,
    aim: number,
    count: number,
    speed: number,
    color: string,
    spread = 1.4,
    life = 0.5,
  ): void {
    for (let i = 0; i < count && this.shards.length < MAX_SHARDS; i++) {
      const a = aim + (Math.random() - 0.5) * 2 * spread;
      const s = speed * (0.45 + Math.random() * 0.9);
      const maxLife = life * (0.6 + Math.random() * 0.8);
      this.shards.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: maxLife,
        maxLife,
        size: 3 + Math.random() * 5,
        rot: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 14,
        color,
      });
    }
  }

  private ring(
    x: number,
    y: number,
    r0: number,
    r1: number,
    color: string,
    life = 0.34,
    width = 2.5,
  ): void {
    this.rings.push({ x, y, r0, r1, life, maxLife: life, width, color });
  }

  private shake(mag: number): void {
    this.shakeMag = Math.max(this.shakeMag, mag);
    this.shakeT = 1;
  }

  consume(events: readonly SimEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'blockHit':
          this.spawn(
            (e.gx + 0.5) * CELL,
            (e.gy + 0.5) * CELL,
            e.aim,
            5,
            190,
            PALETTE.blockHurt,
            0.9,
            0.35,
          );
          this.shake(3);
          break;
        case 'blockBreak':
          this.spawn(
            (e.gx + 0.5) * CELL,
            (e.gy + 0.5) * CELL,
            e.aim,
            16,
            260,
            PALETTE.block,
            Math.PI,
            0.7,
          );
          this.shake(7);
          break;
        case 'playerHit':
          this.spawn(e.x, e.y, e.aim, 14, 300, PALETTE.zone, 1.1, 0.5);
          this.shake(11);
          break;
        case 'death':
          this.spawn(e.x, e.y, 0, 48, 380, PALETTE.zone, Math.PI, 1.1);
          this.shake(20);
          break;
        case 'drop':
          this.ring(e.x, e.y, 2, 26, WEAPONS[e.weapon].color, 0.45, 2);
          break;
        case 'pickup':
          this.ring(e.x, e.y, 24, 4, WEAPONS[e.weapon].color, 0.3, 3);
          this.spawn(e.x, e.y, 0, 8, 150, WEAPONS[e.weapon].color, Math.PI, 0.3);
          break;
        case 'pickupLost':
          this.spawn(e.x, e.y, 0, 6, 90, PALETTE.dim, Math.PI, 0.4);
          break;
        case 'shot':
          this.spawn(e.x, e.y, e.aim, 4, 160, WEAPONS[e.weapon].color, 0.5, 0.2);
          this.shake(2);
          break;
        case 'blast': {
          const color = WEAPONS[e.weapon].color;
          this.ring(e.x, e.y, e.radius * 0.25, e.radius, color, 0.4, 4);
          this.ring(e.x, e.y, e.radius * 0.1, e.radius * 1.35, color, 0.55, 1.5);
          this.spawn(e.x, e.y, 0, 34, 420, color, Math.PI, 0.8);
          this.shake(22);
          break;
        }
        case 'swing':
          break;
      }
    }
  }

  update(dt: number): void {
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i]!;
      s.life -= dt;
      if (s.life <= 0) {
        // Swap-pop: order does not matter and it keeps the array compact.
        this.shards[i] = this.shards[this.shards.length - 1]!;
        this.shards.pop();
        continue;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.rot += s.spin * dt;
      const drag = Math.exp(-4.5 * dt);
      s.vx *= drag;
      s.vy *= drag;
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]!;
      r.life -= dt;
      if (r.life <= 0) {
        this.rings[i] = this.rings[this.rings.length - 1]!;
        this.rings.pop();
      }
    }

    this.shakeT = Math.max(0, this.shakeT - dt * 5);
    const amp = this.shakeMag * this.shakeT * this.shakeT;
    this.shakeX = (Math.random() - 0.5) * 2 * amp;
    this.shakeY = (Math.random() - 0.5) * 2 * amp;
    if (this.shakeT <= 0) this.shakeMag = 0;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    for (const r of this.rings) {
      const t = 1 - r.life / r.maxLife;
      const eased = 1 - (1 - t) * (1 - t);
      const radius = r.r0 + (r.r1 - r.r0) * eased;
      neonStroke(ctx, circlePath(r.x, r.y, Math.max(0.5, radius)), r.color, r.width, 1 - t);
    }

    if (this.shards.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const s of this.shards) {
      const t = s.life / s.maxLife;
      const h = s.size * t;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      ctx.globalAlpha = t * t;
      ctx.fillStyle = s.color;
      // A thin triangle reads as a chip off the block it came from.
      ctx.beginPath();
      ctx.moveTo(h * 1.8, 0);
      ctx.lineTo(-h, h * 0.7);
      ctx.lineTo(-h, -h * 0.7);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  get count(): number {
    return this.shards.length + this.rings.length;
  }
}
