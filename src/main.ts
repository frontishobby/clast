import { startLoop } from './core/loop.ts';
import { DEFAULT_LAYOUT, type LayoutTuning } from './game/arena.ts';
import { IDLE_INPUT, Sim } from './game/sim.ts';
import { WEAPONS, type WeaponId } from './game/weapons.ts';
import { Ai, type Difficulty } from './input/ai.ts';
import { Keyboard } from './input/keyboard.ts';
import { LocalInput } from './input/local.ts';
import { randomCode, normalizeCode } from './net/code.ts';
import { describeProbe, probeNetwork } from './net/ice.ts';
import { findMatch, type Match } from './net/lobby.ts';
import { GuestSession, HostSession } from './net/session.ts';
import { BUTTON } from './input/gamepad.ts';
import { drawSticks } from './ui/controls.ts';
import { drawMenu, hitboxes, itemsFor, typeCode, type Screen } from './ui/menu.ts';
import { Fx } from './view/fx.ts';
import { PALETTE, font, loadFonts, neonStroke, rectPath } from './view/neon.ts';
import { drawWorld } from './view/renderer.ts';
import { Viewport, WORLD_H, WORLD_W, type Seat } from './view/viewport.ts';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const vp = new Viewport(canvas);

/**
 * Orientation simply follows the window, phones included.
 *
 * The per-seat view rotation already makes it a purely local choice: a
 * sideways phone gets the landscape view and an upright one the portrait
 * view, and the touch controls split the screen into halves either way.
 */

loadFonts();

// Installable and playable offline. Dev builds skip it so a cached bundle
// never hides the change you just made.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

/**
 * An installed desktop app opens with a 1280x720 playfield, one world unit per
 * pixel. The manifest has no way to ask for a window size, so it is set here:
 * resizeTo takes the outer size, so the title bar is measured and added on.
 * Browser tabs cannot be resized and phones ignore it, hence the checks.
 */
function sizeInstalledWindow(): void {
  const installed = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
  if (!installed || matchMedia('(pointer: coarse)').matches) return;
  // `screen` is the menu state in this file, hence window.screen.
  const display: globalThis.Screen & { availLeft?: number; availTop?: number } = window.screen;
  const chromeW = window.outerWidth - window.innerWidth;
  const chromeH = window.outerHeight - window.innerHeight;
  const w = Math.min(WORLD_W + chromeW, display.availWidth);
  const h = Math.min(WORLD_H + chromeH, display.availHeight);
  window.resizeTo(w, h);
  window.moveTo(
    Math.round((display.availLeft ?? 0) + (display.availWidth - w) / 2),
    Math.round((display.availTop ?? 0) + (display.availHeight - h) / 2),
  );
}
sizeInstalledWindow();

const keys = new Keyboard();
const input = new LocalInput(vp, keys, canvas);
const fx = new Fx();

const layout: LayoutTuning = { ...DEFAULT_LAYOUT };

// A function declaration, not a const: the demo match is built during module
// initialisation, before a const defined further down would exist.
function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

/** What is actually being simulated right now. */
type Game =
  | { kind: 'demo'; sim: Sim; bots: [Ai, Ai] }
  | { kind: 'single'; sim: Sim; cpu: Ai }
  | { kind: 'host'; session: HostSession; match: Match }
  | { kind: 'guest'; session: GuestSession; match: Match };

let game: Game = newDemo();
let screen: Screen | null = { k: 'title' };
/** Highlighted menu row. Driven by pointer, keyboard and gamepad alike. */
let selected = 0;
let lastScreenKind: string | null = null;
let difficulty: Difficulty = 'normal';
let matchAbort: AbortController | null = null;
let showDebug = false;
/** What this network looks like from outside, e.g. "ipv6 ok · ipv4 symmetric". */
let netProbe: string | null = null;
/** The path the current online match took, e.g. "p2p ipv6". */
let netRoute: string | null = null;
let fps = 60;

function selectedId(): string | null {
  if (!screen) return null;
  return itemsFor(screen)[selected]?.id ?? null;
}

/** Keeps the highlight in range, and back at the top when the screen changes. */
function syncSelection(): void {
  const kind = screen?.k ?? null;
  if (kind !== lastScreenKind) {
    lastScreenKind = kind;
    selected = 0;
  }
  if (!screen) return;
  const count = itemsFor(screen).length;
  selected = Math.max(0, Math.min(count - 1, selected));
}

function moveSelection(step: number): void {
  if (!screen) return;
  const count = itemsFor(screen).length;
  if (count === 0) return;
  selected = (selected + step + count) % count;
}

function currentSim(): Sim | null {
  switch (game.kind) {
    case 'demo':
    case 'single':
      return game.sim;
    case 'host':
      return game.session.sim;
    case 'guest':
      return game.session.sim;
  }
}

/** The seat this client controls and, therefore, renders from. */
function mySeat(): Seat {
  switch (game.kind) {
    case 'demo':
      return 0;
    case 'single':
      return 0;
    case 'host':
      return game.session.seat;
    case 'guest':
      return game.session.seat;
  }
}

function newDemo(): Game {
  const seed = randomSeed();
  return {
    kind: 'demo',
    sim: new Sim(seed, layout),
    bots: [new Ai(0, 'hard', seed ^ 1), new Ai(1, 'normal', seed ^ 2)],
  };
}

function leaveGame(): void {
  if (game.kind === 'host' || game.kind === 'guest') {
    game.session.close('left the match');
    game.match.leave();
  }
  matchAbort?.abort();
  matchAbort = null;
}

/**
 * A match owns one history entry, so the phone's back button or gesture
 * leaves it -- touch has no Escape key. Leaving through the UI pops that
 * entry again, so back from the menu still leaves the site as expected.
 */
function enterMatchHistory(): void {
  if (history.state?.clast !== 'match') history.pushState({ clast: 'match' }, '');
}

/** Set while we pop our own entry, so that popstate is not taken as "back". */
let poppingOwnEntry = false;

function leaveMatchHistory(): void {
  if (history.state?.clast !== 'match') return;
  poppingOwnEntry = true;
  history.back();
}

window.addEventListener('popstate', () => {
  if (poppingOwnEntry) {
    poppingOwnEntry = false;
    return;
  }
  if (game.kind !== 'demo') toMenu({ k: 'title' });
});

function toMenu(next: Screen): void {
  leaveMatchHistory();
  leaveGame();
  game = newDemo();
  screen = next;
  vp.seat = 0;
  vp.resize();
}

function startSingle(): void {
  leaveGame();
  const seed = randomSeed();
  game = { kind: 'single', sim: new Sim(seed, layout), cpu: new Ai(1, difficulty, seed ^ 0xa1) };
  screen = null;
  enterMatchHistory();
  vp.seat = 0;
  vp.resize();
}

async function startOnline(intent: Parameters<typeof findMatch>[0]): Promise<void> {
  leaveGame();
  const abort = new AbortController();
  matchAbort = abort;
  netRoute = null;

  // Not needed to connect; it is there to tell why a connection never came.
  void probeNetwork().then((probe) => {
    netProbe = describeProbe(probe);
    console.info(`[net] ${netProbe}`);
  });

  const setStatus = (status: string) => {
    if (screen?.k === 'searching') screen = { k: 'searching', status };
    else if (screen?.k === 'hosting') screen = { ...screen, status };
    else if (screen?.k === 'connecting') screen = { k: 'connecting', status };
  };

  try {
    const match = await findMatch(intent, { onStatus: setStatus, signal: abort.signal });
    if (abort.signal.aborted) {
      match.leave();
      return;
    }

    void match.route().then((route) => {
      netRoute = route;
      if (route) console.info(`[net] connected ${route}`);
    });

    // Both sides ran the same comparison on their peer ids, so exactly one of
    // them arrives here as host and there is nothing to negotiate.
    if (match.isHost) {
      const session = new HostSession(match.link, randomSeed(), layout);
      session.onEvents = (events) => fx.consume(events);
      game = { kind: 'host', session, match };
      screen = null;
    } else {
      const session = new GuestSession(match.link);
      session.onEvents = (events) => fx.consume(events);
      session.onStart = () => {
        vp.seat = session.seat;
        vp.resize();
        screen = null;
      };
      game = { kind: 'guest', session, match };
      screen = { k: 'connecting', status: 'waiting for the host' };
    }
    vp.seat = mySeat();
    vp.resize();
    enterMatchHistory();
  } catch (err) {
    if (abort.signal.aborted) return;
    toMenu({ k: 'error', message: err instanceof Error ? err.message : 'could not connect' });
  }
}

// --- menu input -------------------------------------------------------------

function activate(id: string): void {
  const s = screen;
  if (!s) return;

  if (id === 'back') {
    if (s.k === 'difficulty' || s.k === 'online' || s.k === 'error') toMenu({ k: 'title' });
    else if (s.k === 'joining') screen = { k: 'online' };
    return;
  }
  if (id === 'cancel') {
    toMenu({ k: 'online' });
    return;
  }

  switch (s.k) {
    case 'title':
      screen = id === 'single' ? { k: 'difficulty' } : { k: 'online' };
      break;
    case 'difficulty':
      difficulty = id as Difficulty;
      startSingle();
      break;
    case 'online':
      if (id === 'random') {
        screen = { k: 'searching', status: 'looking for an opponent' };
        void startOnline({ kind: 'random' });
      } else if (id === 'create') {
        const code = randomCode();
        screen = { k: 'hosting', code, status: 'waiting for someone to join' };
        void startOnline({ kind: 'create', code });
      } else if (id === 'join') {
        screen = { k: 'joining', typed: '', error: null };
      }
      break;
    case 'joining': {
      if (id !== 'go') break;
      const code = normalizeCode(s.typed);
      if (!code) {
        screen = { ...s, error: 'that is not a valid code' };
        break;
      }
      screen = { k: 'connecting', status: `joining ${code}` };
      void startOnline({ kind: 'join', code });
      break;
    }
    default:
      break;
  }
}

function hitIndex(clientX: number, clientY: number): number {
  if (!screen) return -1;
  const p = vp.screenFromClient(clientX, clientY);
  return hitboxes(screen, vp).findIndex(
    (b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h,
  );
}

canvas.addEventListener('pointermove', (e) => {
  if (!screen) return;
  const i = hitIndex(e.clientX, e.clientY);
  if (i >= 0) selected = i;
});

canvas.addEventListener('pointerdown', (e) => {
  if (!screen) return;
  const i = hitIndex(e.clientX, e.clientY);
  if (i < 0) return;
  selected = i;
  const id = selectedId();
  if (id) activate(id);
});

window.addEventListener('resize', () => vp.resize());
window.addEventListener('orientationchange', () => vp.resize());

window.addEventListener('keydown', (e) => {
  if (screen?.k === 'joining') {
    if (e.key === 'Enter') {
      activate('go');
      return;
    }
    const typed = typeCode(screen.typed, e.key);
    if (typed !== screen.typed) screen = { ...screen, typed, error: null };
    return;
  }

  if (screen) {
    if (e.code === 'ArrowUp' || e.code === 'KeyW') {
      moveSelection(-1);
      e.preventDefault();
      return;
    }
    if (e.code === 'ArrowDown' || e.code === 'KeyS') {
      moveSelection(1);
      e.preventDefault();
      return;
    }
    if (e.code === 'Space' || (e.code === 'Enter' && screen.k !== 'error')) {
      const id = selectedId();
      if (id) activate(id);
      e.preventDefault();
      return;
    }
  }

  switch (e.code) {
    case 'Escape':
      if (screen) {
        if (screen.k !== 'title') activate(screen.k === 'online' || screen.k === 'difficulty' ? 'back' : 'cancel');
      } else {
        toMenu({ k: 'title' });
      }
      break;
    case 'Enter':
      if (screen?.k === 'error') toMenu({ k: 'title' });
      else if (!screen && currentSim()?.phase === 'over') finishMatch('again');
      break;
    case 'F3':
      showDebug = !showDebug;
      e.preventDefault();
      break;
    default:
      break;
  }
});

// --- loop --------------------------------------------------------------------

function handleGamepadMenu(): void {
  const pad = input.pad;
  if (!pad.connected) return;

  if (screen) {
    if (pad.menuStep !== 0) moveSelection(pad.menuStep);
    if (pad.pressed(BUTTON.confirm)) {
      const id = selectedId();
      if (id) activate(id);
    } else if (pad.pressed(BUTTON.back)) {
      const items = itemsFor(screen).map((i) => i.id);
      if (items.includes('back')) activate('back');
      else if (items.includes('cancel')) activate('cancel');
    }
    return;
  }

  if (pad.pressed(BUTTON.back)) {
    toMenu({ k: 'title' });
    return;
  }
  if (pad.pressed(BUTTON.confirm) && currentSim()?.phase === 'over') finishMatch('again');
}

function update(dt: number): void {
  input.poll();
  syncSelection();
  handleGamepadMenu();

  const sim = currentSim();
  overFor = sim?.phase === 'over' && !screen ? overFor + dt : 0;

  switch (game.kind) {
    case 'demo': {
      // The title screen plays itself. Restart when somebody wins.
      const { sim: s, bots } = game;
      s.step(dt, [bots[0].sample(s, dt), bots[1].sample(s, dt)]);
      s.drainEvents();
      if (s.phase === 'over') game = newDemo();
      break;
    }
    case 'single': {
      const me = game.sim.players[0];
      const local = screen ? IDLE_INPUT : input.sample(me.x, me.y);
      game.sim.step(dt, [local, game.cpu.sample(game.sim, dt)]);
      fx.consume(game.sim.drainEvents());
      break;
    }
    case 'host':
    case 'guest': {
      if (game.session.phase === 'closed') {
        toMenu({ k: 'error', message: game.session.closedReason ?? 'connection lost' });
        break;
      }
      const s = currentSim();
      const me = s?.players[mySeat()];
      const local = screen || !me ? IDLE_INPUT : input.sample(me.x, me.y);
      game.session.step(dt, local);
      break;
    }
  }

  if (game.kind !== 'demo' && sim) fx.update(dt);
  else fx.update(dt);
  keys.endFrame();
}

// --- end of match -------------------------------------------------------------

interface OverButton {
  id: 'again' | 'menu';
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Seconds since the result appeared, so a swing in the last instant is not a tap. */
let overFor = 0;
const OVER_TAP_DELAY = 0.6;

function overButtons(): OverButton[] {
  const { logicalW, logicalH } = vp.layout;
  const w = 200;
  const h = 58;
  const gap = 20;
  const y = logicalH / 2 + 96;
  const labels: [OverButton['id'], string][] =
    game.kind === 'single' ? [['again', 'AGAIN'], ['menu', 'MENU']] : [['menu', 'MENU']];
  const total = labels.length * w + (labels.length - 1) * gap;
  return labels.map(([id, label], i) => ({
    id,
    label,
    x: logicalW / 2 - total / 2 + i * (w + gap),
    y,
    w,
    h,
  }));
}

function finishMatch(choice: OverButton['id']): void {
  if (choice === 'again' && game.kind === 'single') startSingle();
  else if (game.kind === 'single') toMenu({ k: 'title' });
  else if (game.kind !== 'demo') toMenu({ k: 'online' });
}

canvas.addEventListener('pointerdown', (e) => {
  if (screen || currentSim()?.phase !== 'over' || overFor < OVER_TAP_DELAY) return;
  const p = vp.screenFromClient(e.clientX, e.clientY);
  const hit = overButtons().find(
    (b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h,
  );
  if (hit) finishMatch(hit.id);
});

function drawMatchHud(sim: Sim): void {
  const ctx = vp.ctx;
  const { logicalW, logicalH } = vp.layout;
  const me = sim.players[mySeat()];
  const held = WEAPONS[me.weapon];

  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = font(22, 700);
  ctx.fillStyle = held.color;
  ctx.fillText(held.name, logicalW / 2, logicalH - 108);
  if (me.uses >= 0) {
    ctx.font = font(14);
    ctx.fillStyle = PALETTE.dim;
    ctx.fillText(`${me.uses} left`, logicalW / 2, logicalH - 84);
  }
  ctx.restore();

  if (sim.phase === 'over') {
    const won = sim.winner === mySeat();
    ctx.save();
    ctx.fillStyle = 'rgba(5,6,10,0.7)';
    ctx.fillRect(0, logicalH / 2 - 76, logicalW, 152);
    ctx.textAlign = 'center';
    ctx.font = font(58, 700);
    ctx.fillStyle = sim.winner === null ? PALETTE.text : won ? PALETTE.pickup : PALETTE.zone;
    ctx.fillText(
      sim.winner === null ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT',
      logicalW / 2,
      logicalH / 2 - 44,
    );
    // Keys are only worth mentioning to someone who has them.
    if (!input.touch.engaged) {
      ctx.font = font(16);
      ctx.fillStyle = PALETTE.dim;
      ctx.fillText(
        game.kind === 'single' ? 'enter to play again  ·  esc for the menu' : 'esc for the menu',
        logicalW / 2,
        logicalH / 2 + 26,
      );
    }
    ctx.restore();

    const ready = overFor >= OVER_TAP_DELAY;
    for (const b of overButtons()) {
      const color = b.id === 'again' ? PALETTE.seat0 : PALETTE.dim;
      ctx.save();
      ctx.fillStyle = 'rgba(5,6,10,0.85)';
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.restore();
      neonStroke(ctx, rectPath(b.x, b.y, b.w, b.h), color, 1.8, ready ? 0.9 : 0.3);
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = font(22, 700);
      ctx.fillStyle = color;
      ctx.globalAlpha = ready ? 1 : 0.4;
      ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 1);
      ctx.restore();
    }
  }
}

function drawDebug(sim: Sim | null): void {
  const ctx = vp.ctx;
  const L = vp.layout;
  const lines = [
    `${L.cssW}x${L.cssH} -> ${L.logicalW}x${L.logicalH} ${L.orientation}  ${fps.toFixed(0)}fps`,
    `seat ${vp.seat}  turns ${L.quarterTurns}  zoom ${vp.zoom.toFixed(2)}  mode ${game.kind}`,
    sim
      ? `blocks ${sim.arena.count()}  drops ${sim.pickups.length}  shots ${sim.projectiles.length}  fx ${fx.count}`
      : 'no sim',
    `net ${netProbe ?? '-'}  route ${netRoute ?? '-'}`,
  ];
  ctx.save();
  ctx.fillStyle = 'rgba(5,6,10,0.72)';
  ctx.fillRect(12, 12, 430, lines.length * 19 + 14);
  lines.forEach((s, i) => {
    ctx.fillStyle = PALETTE.dim;
    ctx.font = font(13);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(s, 22, 20 + i * 19);
  });
  ctx.restore();
}

function render(_alpha: number, frameSeconds: number): void {
  if (frameSeconds > 0) fps += (1 / frameSeconds - fps) * 0.08;
  const time = performance.now() / 1000;
  const sim = currentSim();
  const ctx = vp.ctx;

  vp.clear(PALETTE.bg);

  if (sim) {
    const z = sim.zone();
    const shake = vp.worldPerPx;
    vp.camera = { cx: z.cx + fx.shakeX * shake, cy: z.cy + fx.shakeY * shake, w: z.w, h: z.h };

    ctx.save();
    vp.clipToBox();
    vp.beginWorld();
    drawWorld(vp, sim, fx, time, false);
    ctx.restore();
  }

  ctx.save();
  vp.clipToBox();
  vp.beginScreen();
  if (!screen && sim) drawMatchHud(sim);
  if (!screen && sim) drawSticks(vp, input.touch);
  if (screen) drawMenu(vp, screen, selectedId(), time, netProbe);
  if (showDebug) drawDebug(sim);
  ctx.restore();
}

vp.resize();
startLoop({ stepMs: 1000 / 60, update, render });

if (import.meta.env.DEV) {
  Object.assign(window as unknown as Record<string, unknown>, {
    clast: {
      get game() {
        return game;
      },
      get sim() {
        return currentSim();
      },
      get screen() {
        return screen;
      },
      vp,
      fx,
      input,
      go: (id: string) => activate(id),
      give(weapon: WeaponId, seat: 0 | 1 = mySeat()) {
        const s = currentSim();
        if (!s) return;
        s.players[seat].weapon = weapon;
        s.players[seat].uses = WEAPONS[weapon].uses;
      },
    },
  });
}
