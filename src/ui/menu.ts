import { CODE_LENGTH, isCodeChar, normalizeCode } from '../net/code.ts';
import { PALETTE, circlePath, font, neonStroke, polyPath, rectPath } from '../view/neon.ts';
import type { Viewport } from '../view/viewport.ts';

/**
 * Menus are drawn into the same letterboxed screen space as the HUD, so they
 * sit inside the 16:9 / 9:16 frame and rotate with nothing.
 */

export type Screen =
  | { k: 'title' }
  | { k: 'difficulty' }
  | { k: 'online' }
  | { k: 'searching'; status: string }
  | { k: 'hosting'; code: string; status: string }
  | { k: 'joining'; typed: string; error: string | null }
  | { k: 'connecting'; status: string }
  | { k: 'error'; message: string };

export interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  accent?: string;
}

export interface Hit {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const ITEM_W = 460;
const ITEM_H = 62;
const ITEM_GAP = 14;

export function itemsFor(screen: Screen): MenuItem[] {
  switch (screen.k) {
    case 'title':
      return [
        { id: 'single', label: 'SINGLE', hint: 'against the CPU', accent: PALETTE.seat0 },
        { id: 'online', label: 'ONLINE', hint: '1 v 1', accent: PALETTE.seat1 },
      ];
    case 'difficulty':
      return [
        { id: 'easy', label: 'EASY', accent: PALETTE.pickup },
        { id: 'normal', label: 'NORMAL', accent: PALETTE.hammer },
        { id: 'hard', label: 'HARD', accent: PALETTE.zone },
        { id: 'back', label: 'BACK', accent: PALETTE.dim },
      ];
    case 'online':
      return [
        { id: 'random', label: 'QUICK MATCH', hint: 'find anyone', accent: PALETTE.seat0 },
        { id: 'create', label: 'CREATE ROOM', hint: 'get a code to share', accent: PALETTE.pickup },
        { id: 'join', label: 'ENTER CODE', hint: 'join a friend', accent: PALETTE.shard },
        { id: 'back', label: 'BACK', accent: PALETTE.dim },
      ];
    case 'searching':
    case 'hosting':
    case 'connecting':
      return [{ id: 'cancel', label: 'CANCEL', accent: PALETTE.dim }];
    case 'joining':
      return [
        { id: 'go', label: 'JOIN', accent: PALETTE.pickup },
        { id: 'back', label: 'BACK', accent: PALETTE.dim },
      ];
    case 'error':
      return [{ id: 'back', label: 'BACK', accent: PALETTE.dim }];
  }
}

function title(screen: Screen): { heading: string; sub: string } {
  switch (screen.k) {
    case 'title':
      return { heading: 'CLAST', sub: 'break the field. last one standing.' };
    case 'difficulty':
      return { heading: 'CPU', sub: 'pick your opponent' };
    case 'online':
      return { heading: 'ONLINE', sub: 'peer to peer, no server' };
    case 'searching':
      return { heading: 'SEARCHING', sub: screen.status };
    case 'hosting':
      return { heading: 'YOUR CODE', sub: screen.status };
    case 'joining':
      return { heading: 'ROOM CODE', sub: screen.error ?? 'type the five characters' };
    case 'connecting':
      return { heading: 'CONNECTING', sub: screen.status };
    case 'error':
      return { heading: 'DISCONNECTED', sub: screen.message };
  }
}

/** Where the list of buttons starts, leaving room for the code display. */
function listTop(screen: Screen, logicalH: number, count: number): number {
  const stack = count * ITEM_H + (count - 1) * ITEM_GAP;
  const bias = screen.k === 'hosting' || screen.k === 'joining' ? 0.62 : 0.5;
  return logicalH * bias - stack / 2 + 40;
}

export function hitboxes(screen: Screen, vp: Viewport): Hit[] {
  const { logicalW, logicalH } = vp.layout;
  const items = itemsFor(screen);
  const top = listTop(screen, logicalH, items.length);
  const w = Math.min(ITEM_W, logicalW - 64);
  return items.map((item, i) => ({
    id: item.id,
    x: (logicalW - w) / 2,
    y: top + i * (ITEM_H + ITEM_GAP),
    w,
    h: ITEM_H,
  }));
}

/** Applies a keystroke to the code entry field; returns the new text. */
export function typeCode(current: string, key: string): string {
  if (key === 'Backspace') return current.slice(0, -1);
  if (key.length !== 1) return current;
  if (current.length >= CODE_LENGTH) return current;
  if (!isCodeChar(key)) return current;
  return normalizeCode(current + key + 'X'.repeat(CODE_LENGTH - current.length - 1))
    ? current + key.toUpperCase()
    : current;
}

function drawSpinner(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  time: number,
  color: string,
): void {
  for (let i = 0; i < 3; i++) {
    const a = time * (1.1 + i * 0.35) + (i * Math.PI * 2) / 3;
    neonStroke(ctx, polyPath(x, y, 16 + i * 9, 3, a), color, 1.6, 0.7 - i * 0.16);
  }
}

function drawCode(
  ctx: CanvasRenderingContext2D,
  code: string,
  cx: number,
  y: number,
  filledColor: string,
  caret: boolean,
  time: number,
): void {
  const boxW = 58;
  const boxH = 76;
  const gap = 12;
  const total = CODE_LENGTH * boxW + (CODE_LENGTH - 1) * gap;
  let x = cx - total / 2;

  for (let i = 0; i < CODE_LENGTH; i++) {
    const c = code[i];
    const active = caret && i === code.length;
    neonStroke(
      ctx,
      rectPath(x, y, boxW, boxH),
      c ? filledColor : PALETTE.dim,
      1.6,
      c ? 0.9 : active ? 0.5 + 0.4 * Math.sin(time * 6) : 0.25,
    );
    if (c) {
      ctx.save();
      ctx.font = font(44, 700);
      ctx.fillStyle = filledColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c, x + boxW / 2, y + boxH / 2 + 2);
      ctx.restore();
    }
    x += boxW + gap;
  }
}

export function drawMenu(
  vp: Viewport,
  screen: Screen,
  hovered: string | null,
  time: number,
): void {
  const ctx = vp.ctx;
  const { logicalW, logicalH } = vp.layout;
  const { heading, sub } = title(screen);

  ctx.save();
  ctx.fillStyle = 'rgba(5,6,10,0.82)';
  ctx.fillRect(0, 0, logicalW, logicalH);
  ctx.restore();

  // Heading
  ctx.save();
  ctx.textAlign = 'center';
  const headY = logicalH * (screen.k === 'title' ? 0.24 : 0.2);
  ctx.font = font(screen.k === 'title' ? 72 : 44, 700);
  ctx.fillStyle = PALETTE.text;
  ctx.fillText(heading, logicalW / 2, headY);
  ctx.font = font(16);
  ctx.fillStyle = PALETTE.dim;
  ctx.fillText(sub, logicalW / 2, headY + 34);
  ctx.restore();

  if (screen.k === 'searching' || screen.k === 'connecting') {
    drawSpinner(ctx, logicalW / 2, logicalH * 0.44, time, PALETTE.seat0);
  }
  if (screen.k === 'hosting') {
    drawCode(ctx, screen.code, logicalW / 2, logicalH * 0.36, PALETTE.pickup, false, time);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = font(15);
    ctx.fillStyle = PALETTE.dim;
    ctx.fillText('share this code', logicalW / 2, logicalH * 0.36 + 100);
    ctx.restore();
    drawSpinner(ctx, logicalW / 2, logicalH * 0.36 + 150, time, PALETTE.pickup);
  }
  if (screen.k === 'joining') {
    drawCode(ctx, screen.typed, logicalW / 2, logicalH * 0.36, PALETTE.shard, true, time);
  }

  // Buttons
  const items = itemsFor(screen);
  const boxes = hitboxes(screen, vp);
  items.forEach((item, i) => {
    const b = boxes[i]!;
    const accent = item.accent ?? PALETTE.text;
    const on = hovered === item.id;
    ctx.save();
    ctx.fillStyle = on ? 'rgba(207,216,255,0.07)' : 'rgba(10,14,30,0.6)';
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.restore();
    neonStroke(ctx, rectPath(b.x, b.y, b.w, b.h), accent, on ? 2 : 1.3, on ? 1 : 0.55);

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.font = font(22, 700);
    ctx.fillStyle = accent;
    ctx.textAlign = 'left';
    ctx.fillText(item.label, b.x + 26, b.y + b.h / 2);
    if (item.hint) {
      ctx.font = font(14);
      ctx.fillStyle = PALETTE.dim;
      ctx.textAlign = 'right';
      ctx.fillText(item.hint, b.x + b.w - 26, b.y + b.h / 2);
    }
    ctx.restore();

    if (on) neonStroke(ctx, circlePath(b.x + 12, b.y + b.h / 2, 3), accent, 1.6);
  });
}
