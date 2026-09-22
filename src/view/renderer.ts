import { TAU } from '../core/math.ts';
import { BLOCK_MAX_HP, CELL, GRID_H, GRID_W } from '../game/arena.ts';
import { TUNING, type PlayerState, type Projectile, type Sim } from '../game/sim.ts';
import { WEAPONS, type WeaponId } from '../game/weapons.ts';
import type { Fx } from './fx.ts';
import {
  PALETTE,
  circlePath,
  linePath,
  neonFill,
  neonStroke,
  polyPath,
  rectPath,
  type PathFn,
} from './neon.ts';
import { WORLD_H, WORLD_W, type Viewport } from './viewport.ts';

/**
 * Every drawing call in the game funnels through here, so swapping Canvas2D
 * for a GPU renderer later stays a change to this file plus neon.ts.
 */

const seatColor = (seat: 0 | 1) => (seat === 0 ? PALETTE.seat0 : PALETTE.seat1);

function drawGrid(ctx: CanvasRenderingContext2D, px: number): void {
  ctx.save();
  ctx.strokeStyle = PALETTE.grid;
  ctx.lineWidth = px;
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  for (let gx = 0; gx <= GRID_W; gx++) {
    ctx.moveTo(gx * CELL, 0);
    ctx.lineTo(gx * CELL, WORLD_H);
  }
  for (let gy = 0; gy <= GRID_H; gy++) {
    ctx.moveTo(0, gy * CELL);
    ctx.lineTo(WORLD_W, gy * CELL);
  }
  ctx.stroke();
  ctx.restore();
}

function drawBlocks(ctx: CanvasRenderingContext2D, sim: Sim, px: number): void {
  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      const hp = sim.arena.hpAt(gx, gy);
      if (hp <= 0) continue;
      const t = hp / BLOCK_MAX_HP;
      // Damage reads as the block shrinking and going hot, so you can tell a
      // one-hit-from-breaking block apart at a glance mid-fight.
      const inset = 3 + (1 - t) * 6;
      const color = hp === BLOCK_MAX_HP ? PALETTE.block : PALETTE.blockHurt;
      neonFill(
        ctx,
        rectPath(gx * CELL + inset, gy * CELL + inset, CELL - inset * 2, CELL - inset * 2),
        color,
        'rgba(20,26,54,0.85)',
        px * 1.5,
        0.35 + t * 0.55,
      );
    }
  }
}

const arcPath =
  (p: PlayerState, r0: number, r1: number, aim: number, half: number): PathFn =>
  (ctx) => {
    ctx.arc(p.x, p.y, r1, aim - half, aim + half);
    ctx.arc(p.x, p.y, r0, aim + half, aim - half, true);
    ctx.closePath();
  };

function drawSwing(ctx: CanvasRenderingContext2D, p: PlayerState, px: number): void {
  if (p.swingT < 0) return;
  const def = WEAPONS[p.swingWeapon];
  const t = Math.min(1, p.swingT / def.swing);
  const color = def.id === 'fist' ? seatColor(p.seat) : def.color;

  if (def.kind === 'throw') {
    // Nothing sweeps on a throw; flash the release direction instead.
    const fade = 1 - t;
    const r = TUNING.playerRadius;
    neonStroke(
      ctx,
      linePath(
        p.x + Math.cos(p.swingAim) * r,
        p.y + Math.sin(p.swingAim) * r,
        p.x + Math.cos(p.swingAim) * (r + 26 * (1 - fade) + 10),
        p.y + Math.sin(p.swingAim) * (r + 26 * (1 - fade) + 10),
      ),
      color,
      px * 2,
      fade,
    );
    return;
  }

  // The wedge sweeps across the arc rather than appearing all at once, which
  // makes the windup readable enough to dodge.
  const span = def.arc;
  const head = -span + t * span * 2;
  const tail = Math.max(-span, head - span * 0.85);
  const mid = (head + tail) / 2;
  const half = Math.max(0.02, (head - tail) / 2);
  const fade = 1 - t * t;

  const path = arcPath(p, TUNING.playerRadius + 2, def.range, p.swingAim + mid, half);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.14 * fade;
  ctx.fillStyle = color;
  ctx.beginPath();
  path(ctx);
  ctx.fill();
  ctx.restore();
  neonStroke(ctx, path, color, px * 1.4, fade);
}

/** Each weapon gets a silhouette so a drop is identifiable at a glance. */
function weaponGlyph(ctx: CanvasRenderingContext2D, id: WeaponId, x: number, y: number, r: number, px: number): void {
  const color = WEAPONS[id].color;
  switch (id) {
    case 'dagger':
      neonStroke(ctx, linePath(x - r * 0.5, y + r * 0.5, x + r * 0.6, y - r * 0.6), color, px * 1.6);
      neonStroke(ctx, linePath(x - r * 0.1, y - r * 0.1, x - r * 0.7, y - r * 0.7), color, px * 1.6);
      break;
    case 'spear':
      neonStroke(ctx, linePath(x - r * 0.8, y + r * 0.8, x + r * 0.8, y - r * 0.8), color, px * 1.4);
      neonStroke(ctx, polyPath(x + r * 0.55, y - r * 0.55, r * 0.34, 3, -Math.PI / 4), color, px * 1.4);
      break;
    case 'hammer':
      neonStroke(ctx, linePath(x - r * 0.7, y + r * 0.7, x + r * 0.3, y - r * 0.3), color, px * 1.4);
      neonStroke(ctx, rectPath(x + r * 0.1, y - r * 0.85, r * 0.75, r * 0.75), color, px * 1.4);
      break;
    case 'shard':
      neonStroke(ctx, polyPath(x, y, r * 0.8, 3, -Math.PI / 2), color, px * 1.5);
      break;
    case 'bomb':
      neonStroke(ctx, circlePath(x, y + r * 0.15, r * 0.6), color, px * 1.5);
      neonStroke(ctx, linePath(x + r * 0.3, y - r * 0.35, x + r * 0.75, y - r * 0.8), color, px * 1.3);
      break;
    case 'fist':
      break;
  }
}

function drawPickups(ctx: CanvasRenderingContext2D, sim: Sim, time: number, px: number): void {
  for (const drop of sim.pickups) {
    const color = WEAPONS[drop.weapon].color;
    const bob = Math.sin(time * 3 + drop.id) * 2.5;
    const y = drop.y + bob;
    const r = TUNING.pickupRadius;
    neonStroke(ctx, polyPath(drop.x, y, r + 5, 6, time * 0.9 + drop.id), color, px, 0.5);
    weaponGlyph(ctx, drop.weapon, drop.x, y, r, px);
  }
}

function drawProjectiles(ctx: CanvasRenderingContext2D, projectiles: readonly Projectile[], px: number): void {
  for (const pr of projectiles) {
    const def = WEAPONS[pr.weapon];
    const shape = def.projectile!;
    const a = Math.atan2(pr.vy, pr.vx);
    if (shape.blast > 0) {
      // A bomb has to read as dangerous from across the arena.
      const pulse = 0.6 + 0.4 * Math.sin(pr.life * 40);
      neonStroke(ctx, circlePath(pr.x, pr.y, shape.radius), def.color, px * 2, pulse);
      neonStroke(ctx, circlePath(pr.x, pr.y, shape.radius + 6), def.color, px, pulse * 0.4);
    } else {
      // Trail length tracks speed, so a shard reads as travelling not floating.
      const len = shape.radius * 4;
      neonStroke(
        ctx,
        linePath(pr.x - Math.cos(a) * len, pr.y - Math.sin(a) * len, pr.x, pr.y),
        def.color,
        px * 1.8,
      );
      neonStroke(ctx, polyPath(pr.x, pr.y, shape.radius, 3, a), def.color, px * 1.4);
    }
  }
}

function drawPlayer(ctx: CanvasRenderingContext2D, p: PlayerState, px: number): void {
  if (!p.alive) return;
  const color = seatColor(p.seat);
  const r = TUNING.playerRadius;
  const held = WEAPONS[p.weapon];

  drawSwing(ctx, p, px);

  // A ring in the weapon's colour, so you can read what your opponent is
  // holding without looking away from the fight.
  if (held.id !== 'fist') {
    neonStroke(ctx, circlePath(p.x, p.y, r + 4), held.color, px * 1.2, 0.8);
  }

  if (p.invuln > 0) {
    neonStroke(
      ctx,
      circlePath(p.x, p.y, r + 7),
      PALETTE.text,
      px,
      (p.invuln / TUNING.invulnerable) * 0.7,
    );
  }

  const hot = p.hitFlash / TUNING.hitFlash;
  neonFill(
    ctx,
    circlePath(p.x, p.y, r),
    hot > 0 ? PALETTE.text : color,
    'rgba(10,14,30,0.92)',
    px * 2,
    1 + hot,
  );
  // Facing nub, so aim is legible without the swing being active.
  neonStroke(
    ctx,
    linePath(
      p.x + Math.cos(p.aim) * r,
      p.y + Math.sin(p.aim) * r,
      p.x + Math.cos(p.aim) * (r + 14),
      p.y + Math.sin(p.aim) * (r + 14),
    ),
    color,
    px * 2,
  );

  // Health pips ring the player so you read both bars without leaving the fight.
  const pips = TUNING.playerMaxHp;
  for (let i = 0; i < pips; i++) {
    const a = -Math.PI / 2 + (i / pips) * TAU;
    const px2 = p.x + Math.cos(a) * (r + 12);
    const py2 = p.y + Math.sin(a) * (r + 12);
    const filled = i < p.hp;
    neonStroke(
      ctx,
      circlePath(px2, py2, 2.6),
      filled ? color : PALETTE.dim,
      px * 1.2,
      filled ? 0.95 : 0.3,
    );
  }
}

export function drawWorld(vp: Viewport, sim: Sim, fx: Fx, time: number, showGrid: boolean): void {
  const ctx = vp.ctx;
  const px = vp.worldPerPx;

  ctx.fillStyle = PALETTE.field;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  if (showGrid) drawGrid(ctx, px);
  neonStroke(ctx, rectPath(0, 0, WORLD_W, WORLD_H), PALETTE.wall, px * 2, 0.8);

  drawBlocks(ctx, sim, px);

  // Spawn pads stay visible as landmarks once the zone starts closing.
  sim.players.forEach((p) => {
    const pulse = 0.5 + 0.5 * Math.sin(time * 2 + p.seat);
    if (!p.alive) return;
    neonStroke(
      ctx,
      polyPath(p.x, p.y, TUNING.playerRadius + 22, 3, time * 0.6 + p.seat * Math.PI),
      seatColor(p.seat),
      px,
      0.12 + pulse * 0.1,
    );
  });

  drawPickups(ctx, sim, time, px);
  for (const p of sim.players) drawPlayer(ctx, p, px);
  drawProjectiles(ctx, sim.projectiles, px);

  fx.draw(ctx);

  const z = sim.zone();
  neonStroke(
    ctx,
    rectPath(z.cx - z.w / 2, z.cy - z.h / 2, z.w, z.h),
    PALETTE.zone,
    px * 2,
    0.85,
  );
}
