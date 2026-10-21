// Ghost cursor: a faint second mouse pointer that copies yours from a moment
// ago, then stops copying and goes about its own business. It glides to a link
// or button on the page, turns into a pointing hand over it like a real cursor,
// gives it a slow phantom "click", and drifts up toward the tab strip before
// fading away. With nothing to reach for it reads a line of text instead. Sweep
// your mouse at it and it flinches and is gone.
//
// Everything is drawn in our own click-through overlay: a small vector cursor
// and a few afterimages, moved with compositor-only transforms. The page never
// receives an event from us, and nothing of the page is changed.

import type { Effect, EffectContext } from './types';
import { createOverlay, seeded, type Overlay } from './overlay';

/** The standard arrow cursor, hotspot at 0,0 (about 12 by 20 CSS pixels). */
const ARROW = 'M0 0L0 17.2L4.15 13.25L6.95 19.75L9.7 18.6L6.95 12.35L12.5 12.35Z';
/**
 * The pointing hand, hotspot at the tip of the index finger. Vertical and
 * horizontal edges sit on whole pixels so they stay crisp.
 */
const HAND =
  'M-2 2A2 2 0 0 1 2 2L2 8.6A1.5 1.5 0 0 1 5 8.6L5 9.4A1.5 1.5 0 0 1 8 9.4L8 10.3A1.5 1.5 0 0 1 11 10.3' +
  'L11 15C11 17.3 10.1 18.8 9 20L9 22L-1 22L-1 20.2C-2.4 19 -4.6 16.6 -6.5 14.2' +
  'A1.45 1.45 0 0 1 -4.5 12.1L-2 14.1Z';
/** Creases between the folded fingers. */
const HAND_CREASES = 'M2 8.6L2 11.5M5 9.4L5 12M8 10.3L8 12.5';
/** The text I-beam, hotspot at its centre, drawn as a stroke. */
const IBEAM = 'M-3.5 -9.5Q-0.6 -9.5 0 -7.5Q0.6 -9.5 3.5 -9.5M0 -7.5L0 7.5M-3.5 9.5Q-0.6 9.5 0 7.5Q0.6 9.5 3.5 9.5';
/**
 * The cursor's SVG box. The cursor's origin sits half a pixel into it and the
 * box moves in whole pixels, so 1px strokes land exactly on device pixels.
 */
const PAD = 11.5;
const SHIFT = 12;
const BOX_W = 40;
const BOX_H = 46;

const HIST = 256; // recorded pointer samples (x, y, t), at least 8ms apart
const HIST_GAP = 8;
const RHIST = 48; // rendered positions, for afterimages (x, y, t)
const TRAILS = 6;
const TRAIL_ALPHA = [0.3, 0.24, 0.18, 0.13, 0.08, 0.045];
const TRAIL_MAX = 42; // px: the longest smear

const FLINCH_RADIUS = 60;
const FLINCH_SPEED = 0.9; // px/ms: a quick swipe, not a drift
const WANDER_AFTER = 1500; // ms of pointer stillness before it drifts off on its own
const LONG_HIDDEN = 3000; // ms hidden after which it quietly ends instead of resuming

const INTERACTIVE =
  'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="submit"], input[type="button"], summary, select, label[for]';
const TEXTY = /^(P|LI|TD|DD|BLOCKQUOTE|H[1-6]|SPAN|EM|STRONG|B|I)$/;

const glow = (d: string) => `<g fill="none" stroke-linejoin="round" stroke="rgb(125, 172, 255)">
    <path d="${d}" stroke-width="10" stroke-opacity="0.07"/>
    <path d="${d}" stroke-width="6" stroke-opacity="0.12"/>
    <path d="${d}" stroke-width="3.2" stroke-opacity="0.24"/>
  </g>`;
const body = (d: string, edge = 0.55) =>
  `<path d="${d}" fill="rgb(232, 241, 255)" fill-opacity="0.92" stroke="rgb(28, 40, 66)" stroke-opacity="${edge}" stroke-width="1" stroke-linejoin="round"/>`;
const svg = (cls: string, inner: string) =>
  `<svg class="${cls}" width="${BOX_W}" height="${BOX_H}" viewBox="${-PAD} ${-PAD} ${BOX_W} ${BOX_H}" aria-hidden="true">${inner}</svg>`;

const GHOST_HTML =
  '<div class="aura"></div>' +
  svg('arrow', glow(ARROW) + body(ARROW)) +
  svg(
    'hand',
    glow(HAND) +
      body(HAND) +
      `<path d="${HAND_CREASES}" fill="none" stroke="rgb(28, 40, 66)" stroke-opacity="0.4" stroke-width="1" stroke-linecap="round"/>`,
  ) +
  svg(
    'ibeam',
    `<g fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path d="${IBEAM}" stroke="rgb(125, 172, 255)" stroke-width="8" stroke-opacity="0.08"/>
      <path d="${IBEAM}" stroke="rgb(125, 172, 255)" stroke-width="5" stroke-opacity="0.16"/>
      <path d="${IBEAM}" stroke="rgb(28, 40, 66)" stroke-width="3" stroke-opacity="0.5"/>
      <path d="${IBEAM}" stroke="rgb(232, 241, 255)" stroke-width="1" stroke-opacity="0.95"/>
    </g>`,
  );
const TRAIL_HTML = svg('arrow', body(ARROW, 0.32));

const CSS = `
  .g, .t, .r { position: absolute; left: 0; top: 0; opacity: 0; will-change: transform, opacity; }
  .g, .t { width: ${BOX_W}px; height: ${BOX_H}px; transform-origin: ${PAD}px ${PAD}px; }
  .t { filter: blur(0.5px); }
  svg { position: absolute; left: 0; top: 0; display: block; overflow: visible; transition: opacity 90ms ease-out; }
  .g .hand, .g .ibeam, .g.pointing .arrow, .g.reading .arrow { opacity: 0; }
  .g.pointing .hand, .g.reading .ibeam { opacity: 1; }
  .aura {
    position: absolute; left: -6px; top: -2px; width: 44px; height: 46px; border-radius: 50%;
    background: radial-gradient(closest-side, rgba(150, 190, 255, 0.22), rgba(150, 190, 255, 0.08) 55%, rgba(150, 190, 255, 0));
  }
  .r {
    width: 30px; height: 30px; margin: -15px 0 0 -15px; border-radius: 50%; filter: blur(0.6px);
    background: radial-gradient(closest-side, rgba(130, 170, 250, 0) 52%, rgba(130, 170, 250, 0.9) 76%, rgba(130, 170, 250, 0) 100%);
  }
`;

type Phase = 'idle' | 'wait' | 'follow' | 'script' | 'flinch' | 'fading';

/** One scripted motion: a curved glide, or a hold when it goes nowhere. */
interface Step {
  dur: number;
  /** Where it ends: absolute viewport point, or an offset from the target point. */
  rel: boolean;
  x: number;
  y: number;
  /** Sideways bow of the path, as a fraction of its length. */
  curve: number;
  ease: 'mj' | 'early' | 'exit';
  hold?: boolean;
  click?: boolean;
  leave?: boolean;
  /** Over the target: a real cursor would be a hand here. */
  point?: boolean;
  /** On a line of text: a real cursor would be an I-beam here. */
  read?: boolean;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};
/** Minimum-jerk profile: how a hand moves a mouse from rest to rest. */
const minJerk = (t: number) => t * t * t * (10 + t * (6 * t - 15));
/** Gathers speed over the first 45%, then cruises: drifting away, not darting. */
const EXIT_A = 0.45;
const EXIT_V = 1 / (1 - EXIT_A / 2);
const exitEase = (k: number) => {
  if (k < EXIT_A) {
    const s = k / EXIT_A;
    return EXIT_V * EXIT_A * (s * s * s - (s * s * s * s) / 2);
  }
  return EXIT_V * (EXIT_A / 2 + (k - EXIT_A));
};

/** The clickable thing under a point, looking inside open shadow roots too. */
function interactiveAt(x: number, y: number): Element | null {
  let el = document.elementFromPoint(x, y);
  for (let depth = 0; el?.shadowRoot && depth < 8; depth++) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  let node: Element | null = el;
  while (node) {
    const hit = node.closest(INTERACTIVE);
    if (hit) return hit;
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

/** Where the text caret would land for a point: on a real line of words, or null. */
function caretAt(x: number, y: number): { x: number; y: number; h: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; getClientRect(): DOMRect | null } | null;
    caretRangeFromPoint?(x: number, y: number): Range | null;
  };
  let node: Node | null = null;
  let rect: DOMRect | null = null;
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    node = p?.offsetNode ?? null;
    rect = p?.getClientRect() ?? null;
  } else if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(x, y);
    node = range?.startContainer ?? null;
    rect = range?.getBoundingClientRect() ?? null;
  }
  if (!node || node.nodeType !== Node.TEXT_NODE || !/\S/.test(node.textContent ?? '') || !rect || rect.height < 6) return null;
  return { x: rect.left, y: rect.top + rect.height / 2, h: rect.height };
}

export class GhostCursor implements Effect {
  readonly name = 'ghostCursor' as const;

  private overlay: Overlay | null = null;
  private ghost: HTMLDivElement | null = null;
  private aura: HTMLDivElement | null = null;
  private trails: HTMLDivElement[] = [];
  private rings: HTMLDivElement[] = [];

  private phase: Phase = 'idle';
  private reduced = false;
  private rnd: () => number = Math.random;
  private raf = 0;
  private spawnTimer: number | undefined;
  private idleTimer: number | undefined;
  private killTimer: number | undefined;
  private listening = false;

  // Clock that stands still while the tab is hidden.
  private hiddenSince = 0;
  private hiddenTotal = 0;
  private lastFrame = 0;

  private vw = 0;
  private vh = 0;
  private dpr = 1;

  // Your pointer, as recorded.
  private hist = new Float64Array(HIST * 3);
  private histHead = 0;
  private histCount = 0;
  private px = 0;
  private py = 0;
  private pt = 0;
  private pointerSeen = false;

  // The ghost.
  private spawnAt = 0;
  private autonomyAt = 0;
  private delay = 750;
  private offX = 0;
  private offY = 0;
  private copying = false;
  private dx = 0; // desired position
  private dy = 0;
  private x = 0; // rendered position (spring-smoothed)
  private y = 0;
  private vx = 0; // px/s
  private vy = 0;
  private speed = 0; // smoothed, px/ms
  private rhist = new Float64Array(RHIST * 3);
  private rhHead = 0;
  private rhCount = 0;
  private alpha = 0;
  private fadeFrom = 1;
  private fadeAt = 0;
  private fadeDur = 700;
  private blendX = 0; // where a behaviour switch started from
  private blendY = 0;
  private blendAt = -1e9;
  /** Until when the desired point is known to stay put (0: it is moving). */
  private holdUntil = 0;

  // Wandering, when your pointer gives it nothing to copy.
  private wFromX = 0;
  private wFromY = 0;
  private wToX = 0;
  private wToY = 0;
  private wCurve = 0;
  private wAngle = NaN;
  private wAt = 0;
  private wDur = 1;
  private wNext = 0;

  // The script it follows once it acts on its own.
  private steps: Step[] = [];
  private stepIndex = 0;
  private stepAt = 0;
  private stepX0 = 0;
  private stepY0 = 0;
  private stepFired = false;
  private target: Element | null = null;
  private targetHand = false;
  private tOffX = 0; // hover point, relative to the target's box
  private tOffY = 0;
  private rL = 0; // the target's box, viewport coordinates
  private rT = 0;
  private rR = 0;
  private rB = 0;
  private rectDirty = false;
  private tx = 0; // hover point, viewport coordinates
  private ty = 0;
  private ringAt = -1e9;
  private pressAt = -1e9;
  private leaveAlpha = 1;
  private pointing = false;
  private reading = false;
  private onText = false;

  private flinchAt = 0;

  // Last values written to the DOM, so still frames write nothing.
  private wX = NaN;
  private wY = NaN;
  private wS = NaN;
  private wA = NaN;
  private trailW = new Float64Array(TRAILS * 3).fill(NaN);
  private ringW = new Float64Array(8).fill(NaN); // per ring: x, y, scale, opacity
  private auraW = NaN;
  private trailOn = false;

  get active(): boolean {
    return !!this.overlay;
  }

  start(ctx: EffectContext): void {
    if (this.overlay && this.phase !== 'fading') return;
    if (this.overlay) this.destroy();

    this.reduced = ctx.reduced;
    this.rnd = seeded((ctx.seed ^ 0x6c3f9a1d) >>> 0);
    const r = this.rnd;
    this.delay = 600 + r() * 300;
    // Beside your pointer, never tucked under its body or tail (where it would
    // read as a drop shadow): to its left, its right, or above it. The sectors
    // leave room for the offset's slow sway (about 17 degrees either way).
    const sector = r();
    const deg = sector < 0.45 ? 150 + r() * 75 : sector < 0.75 ? -45 + r() * 60 : 235 + r() * 65;
    const dist = 26 + r() * 14;
    this.offX = Math.cos((deg * Math.PI) / 180) * dist;
    this.offY = Math.sin((deg * Math.PI) / 180) * dist;

    this.overlay = createOverlay(this.name, CSS);
    const layer = this.overlay.layer;
    if (!this.reduced) {
      for (let i = 0; i < TRAILS; i++) {
        const t = document.createElement('div');
        t.className = 't';
        t.innerHTML = TRAIL_HTML;
        layer.appendChild(t);
        this.trails.push(t);
      }
    }
    for (let i = 0; i < 2; i++) {
      const ring = document.createElement('div');
      ring.className = 'r';
      layer.appendChild(ring);
      this.rings.push(ring);
    }
    this.ghost = document.createElement('div');
    this.ghost.className = 'g';
    this.ghost.innerHTML = GHOST_HTML;
    this.aura = this.ghost.querySelector('.aura');
    layer.appendChild(this.ghost);

    this.measure();
    this.listen(true);
    this.hiddenTotal = 0;
    this.hiddenSince = document.hidden ? performance.now() : 0;
    this.phase = 'wait';
    // It shows itself when you next move, or after a moment of stillness.
    this.spawnTimer = window.setTimeout(() => this.spawn(), 900 + r() * 500);
  }

  stop(): void {
    if (!this.overlay || this.phase === 'fading') return;
    if (this.phase === 'wait' || this.phase === 'idle' || document.hidden || this.alpha < 0.01) {
      this.destroy();
      return;
    }
    this.beginFade(this.reduced ? 1000 : 700);
    // Hard limit, in case frames are not running.
    this.killTimer = window.setTimeout(() => this.destroy(), 1500);
  }

  destroy(): void {
    this.listen(false);
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    clearTimeout(this.spawnTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.killTimer);
    this.spawnTimer = this.idleTimer = this.killTimer = undefined;
    this.overlay?.remove();
    this.overlay = null;
    this.ghost = null;
    this.aura = null;
    this.trails = [];
    this.rings = [];
    this.steps = [];
    this.target = null;
    this.phase = 'idle';
    this.histCount = this.rhCount = 0;
    this.pointerSeen = false;
    this.pointing = this.reading = this.onText = false;
    this.alpha = 0;
    this.wX = this.wY = this.wS = this.wA = this.auraW = NaN;
    this.trailW.fill(NaN);
    this.ringW.fill(NaN);
    this.trailOn = false;
  }

  // ---- clock, viewport, listeners -------------------------------------------------

  private now(): number {
    return performance.now() - this.hiddenTotal;
  }

  private measure = (): void => {
    this.vw = innerWidth;
    this.vh = innerHeight;
    this.dpr = Math.min(2, devicePixelRatio || 1);
  };

  private listen(on: boolean): void {
    if (on === this.listening) return;
    this.listening = on;
    const opts: AddEventListenerOptions = { passive: true, capture: true };
    if (on) {
      window.addEventListener('pointermove', this.onPointer, opts);
      window.addEventListener('resize', this.measure, opts);
      // Capture sees scrolling inside any element too, not just the window.
      document.addEventListener('scroll', this.onScroll, opts);
      document.addEventListener('visibilitychange', this.onVisibility, opts);
    } else {
      window.removeEventListener('pointermove', this.onPointer, opts);
      window.removeEventListener('resize', this.measure, opts);
      document.removeEventListener('scroll', this.onScroll, opts);
      document.removeEventListener('visibilitychange', this.onVisibility, opts);
    }
  }

  private onScroll = (): void => {
    // The target may have moved: look again once, on the next frame.
    if (this.phase === 'script' && this.target) {
      this.rectDirty = true;
      this.wake();
    }
  };

  private onVisibility = (): void => {
    if (document.hidden) {
      if (!this.hiddenSince) this.hiddenSince = performance.now();
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      clearTimeout(this.idleTimer);
      return;
    }
    const away = this.hiddenSince ? performance.now() - this.hiddenSince : 0;
    this.hiddenTotal += away;
    this.hiddenSince = 0;
    // Gone for a while, or asked to leave: it does not pick up where it left off.
    if (away > LONG_HIDDEN || this.phase === 'fading') {
      this.destroy();
      return;
    }
    if (this.phase === 'wait') {
      if (this.spawnTimer === undefined) this.spawn();
    } else {
      this.wake();
    }
  };

  private onPointer = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return;
    const t = this.now();
    const x = e.clientX;
    const y = e.clientY;
    if (this.pointerSeen) {
      const mx = x - this.px;
      const my = y - this.py;
      const speed = Math.hypot(mx, my) / Math.max(1, t - this.pt);
      this.maybeFlinch(this.px, this.py, x, y, speed);
    }
    this.px = x;
    this.py = y;
    this.pt = t;
    this.pointerSeen = true;

    // Record the path, at most one sample per 8ms: the newest sample keeps
    // moving until the gap to the one before it is wide enough.
    const h = this.hist;
    const prev2 = (this.histHead - 2 + HIST) % HIST;
    let slot = this.histHead;
    if (this.histCount >= 2 && t - h[prev2 * 3 + 2] < HIST_GAP) slot = (this.histHead - 1 + HIST) % HIST;
    else {
      this.histHead = (this.histHead + 1) % HIST;
      if (this.histCount < HIST) this.histCount++;
    }
    h[slot * 3] = x;
    h[slot * 3 + 1] = y;
    h[slot * 3 + 2] = t;

    if (this.phase === 'wait') this.spawn();
    else if (this.phase === 'follow') this.wake();
  };

  // ---- lifecycle of the apparition ------------------------------------------------

  private spawn(): void {
    clearTimeout(this.spawnTimer);
    this.spawnTimer = undefined;
    // Never while hidden: the clock is stopped, so it would stamp a time in the future.
    if (this.phase !== 'wait' || document.hidden) return;
    const r = this.rnd;
    const t = this.now();
    this.spawnAt = t;
    this.autonomyAt = t + 3600 + r() * 1000;
    if (this.pointerSeen) {
      this.dx = this.px + this.offX;
      this.dy = this.py + this.offY;
      this.copying = true;
    } else {
      // Nothing to copy: it shows up near the middle and finds its own way.
      this.dx = this.vw * (0.42 + r() * 0.16);
      this.dy = this.vh * (0.38 + r() * 0.18);
      this.copying = false;
      this.startWander(t, 500 + r() * 600);
    }
    this.x = this.dx;
    this.y = this.dy;
    this.vx = this.vy = 0;
    this.phase = 'follow';
    this.wake();
  }

  private markBlend(): void {
    this.blendX = this.dx;
    this.blendY = this.dy;
    this.blendAt = this.now();
  }

  private beginFade(ms: number): void {
    this.fadeFrom = this.alpha;
    this.fadeAt = this.now();
    this.fadeDur = ms;
    this.phase = 'fading';
    this.wake();
  }

  /** You came at it fast: anywhere along the last stretch of your pointer's path counts. */
  private maybeFlinch(x0: number, y0: number, x1: number, y1: number, speed: number): void {
    if (this.phase !== 'follow' && this.phase !== 'script') return;
    if (this.alpha < 0.3 || speed < FLINCH_SPEED || this.now() - this.spawnAt < 1200) return;
    const sx = x1 - x0;
    const sy = y1 - y0;
    const len2 = sx * sx + sy * sy;
    if (len2 < 1) return;
    const gx = this.x;
    const gy = this.y;
    const u = ((gx - x0) * sx + (gy - y0) * sy) / len2;
    // u <= 0: the closest point is where the swipe began, so it moved away.
    if (u <= 0) return;
    const k = Math.min(1, u);
    const cx = x0 + sx * k;
    const cy = y0 + sy * k;
    const d = Math.hypot(gx - cx, gy - cy);
    if (d > FLINCH_RADIUS) return;
    const len = Math.sqrt(len2);
    // Away from the swipe's line; straight ahead of it when hit dead on.
    const ux = d > 2 ? (gx - cx) / d : sx / len;
    const uy = d > 2 ? (gy - cy) / d : sy / len;
    this.phase = 'flinch';
    this.flinchAt = this.now();
    this.fadeFrom = this.alpha;
    if (!this.reduced) {
      this.dx = this.x + ux * 34;
      this.dy = this.y + uy * 34;
    }
    this.wake();
  }

  // ---- targets ------------------------------------------------------------------

  /**
   * At the moment it decides: probe a coarse grid of points for something
   * clickable that is actually visible there. Costs the same on any page size.
   * Falls back to a spot of text to read.
   */
  private chooseTarget(): boolean {
    const r = this.rnd;
    const cols = 6;
    const rows = 5;
    const seen = new Set<Element>();
    let best: Element | null = null;
    let bestScore = -Infinity;
    let bx = 0;
    let by = 0;
    let textScore = -Infinity;
    let textX = NaN;
    let textY = NaN;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = this.vw * (0.07 + (0.86 * (col + 0.2 + r() * 0.6)) / cols);
        const y = this.vh * (0.1 + (0.82 * (row + 0.2 + r() * 0.6)) / rows);
        const el = interactiveAt(x, y);
        const d = Math.hypot(x - this.dx, y - this.dy);
        const fromYou = this.pointerSeen ? Math.hypot(x - this.px, y - this.py) : 999;
        // A deliberate trip: not right where it is, not across the world, not under your cursor.
        let score = -Math.abs(d - 320) / 320 + r() * 0.35;
        if (d < 70) score -= 2;
        if (fromYou < 90) score -= 1;
        if (!el) {
          if (score > textScore) {
            const hit = document.elementFromPoint(x, y);
            const caret = hit && TEXTY.test(hit.tagName) ? caretAt(x, y) : null;
            // Only right on a line of words, not in the blank end of a paragraph.
            if (caret && Math.abs(caret.x - x) < 10 && Math.abs(caret.y - y) < caret.h) {
              textScore = score;
              textX = caret.x;
              textY = caret.y;
            }
          }
          continue;
        }
        if (seen.has(el)) continue;
        seen.add(el);
        if (score > bestScore) {
          bestScore = score;
          best = el;
          bx = x;
          by = y;
        }
      }
    }
    if (best) {
      const rect = best.getBoundingClientRect();
      let hx = bx;
      let hy = by;
      if (rect.width <= 520 && rect.height <= 160) {
        // Where a person would point: on the label, a little left of centre.
        hx = rect.left + Math.min(rect.width * (0.3 + r() * 0.3), 26 + r() * 30);
        hy = rect.top + rect.height * (0.45 + r() * 0.15);
        if (hx < 6 || hy < 6 || hx > this.vw - 6 || hy > this.vh - 6 || interactiveAt(hx, hy) !== best) {
          hx = bx;
          hy = by;
        }
      }
      this.target = best;
      this.tOffX = hx - rect.left;
      this.tOffY = hy - rect.top;
      this.setRect(rect);
      // Only things that really show a hand get one (in most browsers a <button> keeps the arrow).
      this.targetHand = getComputedStyle(best).cursor === 'pointer';
      return true;
    }
    this.target = null;
    this.targetHand = false;
    this.onText = textX === textX;
    if (this.onText) {
      this.tx = textX;
      this.ty = textY;
    } else {
      const a = r() * Math.PI * 2;
      const d = 160 + r() * 140;
      this.tx = Math.min(this.vw - 120, Math.max(60, this.dx + Math.cos(a) * d));
      this.ty = Math.min(this.vh - 60, Math.max(80, this.dy + Math.sin(a) * d));
    }
    return false;
  }

  private setRect(rect: DOMRect): void {
    this.rL = rect.left;
    this.rT = rect.top;
    this.rR = rect.right;
    this.rB = rect.bottom;
    this.tx = rect.left + this.tOffX;
    this.ty = rect.top + this.tOffY;
  }

  /** It stops copying you and makes its own plan. */
  private beginScript(): void {
    const r = this.rnd;
    const slow = this.reduced ? 1.6 : 1;
    // Stop where its own momentum would carry it: abrupt, but not a jump.
    const omega = this.reduced ? 6 : 34;
    this.dx = this.x + this.vx / omega;
    this.dy = this.y + this.vy / omega;
    const hasTarget = this.chooseTarget();
    const x0 = this.dx;
    const y0 = this.dy;
    const len = Math.hypot(this.tx - x0, this.ty - y0) || 1;
    const ux = (this.tx - x0) / len;
    const uy = (this.ty - y0) / len;
    const side = r() < 0.5 ? -1 : 1;
    const steps: Step[] = [];

    // Stops dead. Seems to look around, then makes a false start.
    steps.push({ dur: 220 + r() * 100, rel: false, x: x0, y: y0, curve: 0, ease: 'mj', hold: true });
    const la = Math.atan2(uy, ux) + side * (1.6 + r() * 0.9);
    const ld = 20 + r() * 20;
    const lx = Math.min(this.vw - 20, Math.max(20, x0 + Math.cos(la) * ld));
    const ly = Math.min(this.vh - 30, Math.max(20, y0 + Math.sin(la) * ld));
    steps.push({ dur: 430 * slow, rel: false, x: lx, y: ly, curve: side * 0.35, ease: 'mj' });
    steps.push({ dur: 100 + r() * 60, rel: false, x: lx, y: ly, curve: 0, ease: 'mj', hold: true });
    const l2 = Math.hypot(this.tx - lx, this.ty - ly) || 1;
    const fd = 10 + r() * 6;
    const fx = lx + ((this.tx - lx) / l2) * fd;
    const fy = ly + ((this.ty - ly) / l2) * fd;
    steps.push({ dur: 200 * slow, rel: false, x: fx, y: fy, curve: 0, ease: 'mj' });
    steps.push({ dur: 150 + r() * 70, rel: false, x: fx, y: fy, curve: 0, ease: 'mj', hold: true });

    // The glide: a gentle bow, a slight overshoot, a small correction.
    const gl = Math.hypot(this.tx - fx, this.ty - fy) || 1;
    const gx = (this.tx - fx) / gl;
    const gy = (this.ty - fy) / gl;
    const glide = Math.min(1500, Math.max(650, 500 + gl * 0.9)) * slow;
    const curve = side * (0.08 + r() * 0.08);
    if (hasTarget) {
      const over = this.reduced ? 0 : 6 + r() * 7;
      const err = this.reduced ? 0 : (r() - 0.5) * 6;
      steps.push({ dur: glide, rel: true, x: gx * over - gy * err, y: gy * over + gx * err, curve, ease: 'early', point: true });
      if (!this.reduced) steps.push({ dur: 280 + r() * 80, rel: true, x: 0, y: 0, curve: 0, ease: 'mj', point: true });
      // It hovers. A slow press. It lingers on what it touched.
      steps.push({ dur: 300 + r() * 120, rel: true, x: 0, y: 0, curve: 0, ease: 'mj', hold: true, point: true });
      steps.push({ dur: 850 + r() * 200, rel: true, x: 0, y: 0, curve: 0, ease: 'mj', hold: true, click: true, point: true });
      steps.push({ dur: 320 * slow, rel: true, x: (r() - 0.5) * 6, y: -2 - r() * 3, curve: 0, ease: 'mj', point: true });
    } else {
      // Nothing to reach for: it settles on a line of text and reads along it.
      const read = this.onText;
      steps.push({ dur: glide, rel: true, x: 0, y: 0, curve, ease: 'early', read });
      steps.push({ dur: 260 + r() * 120, rel: true, x: 0, y: 0, curve: 0, ease: 'mj', hold: true, read });
      let along = Math.min(40 + r() * 40, this.vw - 30 - this.tx);
      if (read) {
        // Not past the end of the line.
        const end = caretAt(this.tx + along, this.ty);
        if (!end || Math.abs(end.y - this.ty) > 4 || Math.abs(end.x - this.tx - along) > 12) along = Math.min(along, 22);
      }
      steps.push({ dur: (1300 + along * 6) * slow, rel: true, x: along, y: 0, curve: 0, ease: 'mj', read });
      steps.push({ dur: 220 + r() * 120, rel: true, x: along, y: 0, curve: 0, ease: 'mj', hold: true, read });
    }

    // Up toward the tab strip, at a drift whatever the distance, and gone.
    const ex = Math.min(this.vw - 30, Math.max(30, this.tx + side * (40 + r() * 120)));
    const ey = -40;
    const dist = Math.hypot(ex - this.tx, ey - this.ty);
    const exitDur = Math.min(3000, Math.max(1500, (EXIT_V * dist) / 0.3)) * (this.reduced ? 1.2 : 1);
    steps.push({ dur: exitDur, rel: false, x: ex, y: ey, curve: -side * 0.12, ease: 'exit', leave: true });

    this.steps = steps;
    this.stepIndex = 0;
    this.stepFired = false;
    this.stepAt = this.now();
    this.stepX0 = this.dx;
    this.stepY0 = this.dy;
    this.leaveAlpha = 1;
    this.phase = 'script';
  }

  // ---- frame loop ---------------------------------------------------------------

  private wake(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.raf || document.hidden || !this.overlay) return;
    this.lastFrame = this.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (): void => {
    this.raf = 0;
    if (!this.overlay || !this.ghost) return;
    const t = this.now();
    const dt = Math.min(48, Math.max(1, t - this.lastFrame));
    this.lastFrame = t;
    this.holdUntil = 0;

    switch (this.phase) {
      case 'follow': {
        if (t >= this.autonomyAt) {
          this.beginScript();
          return this.scripted(t, dt);
        }
        // Your pointer has been still a while: it drifts off on its own.
        const parked = !this.pointerSeen || t - this.pt > this.delay + WANDER_AFTER;
        if (parked && this.copying) {
          this.copying = false;
          this.startWander(t, 0);
        } else if (!parked && !this.copying) {
          this.copying = true;
          this.markBlend();
        }
        if (this.copying) this.copyPath(t);
        else this.wander(t);
        const alpha = smooth((t - this.spawnAt) / (this.reduced ? 1400 : 900));
        // Copying gently when reduced: a soft spring, and never fast.
        return this.render(t, dt, this.reduced ? 6 : 34, alpha, 1, this.reduced);
      }
      case 'script':
        return this.scripted(t, dt);
      case 'flinch': {
        const k = (t - this.flinchAt) / (this.reduced ? 700 : 300);
        if (k >= 1) return this.destroy();
        return this.render(t, dt, 30, this.fadeFrom * (1 - smooth(k)), 1, false);
      }
      case 'fading': {
        const k = (t - this.fadeAt) / this.fadeDur;
        if (k >= 1) return this.destroy();
        this.dy -= dt * 0.01;
        return this.render(t, dt, this.reduced ? 14 : 34, this.fadeFrom * (1 - smooth(k)), 1, false);
      }
    }
  };

  private scripted(t: number, dt: number): void {
    if (this.rectDirty) {
      // Scrolled (the window or any box): one fresh read of where the target is now.
      this.rectDirty = false;
      if (this.target?.isConnected) this.setRect(this.target.getBoundingClientRect());
      const last = this.steps.length - 1;
      if (this.stepIndex < last && (!this.target?.isConnected || this.tx < 4 || this.ty < 4 || this.tx > this.vw - 4 || this.ty > this.vh - 4)) {
        // Scrolled out of reach: it loses interest and drifts off from where it is.
        this.target = null;
        this.stepIndex = last;
        this.stepAt = t;
        this.stepX0 = this.dx;
        this.stepY0 = this.dy;
        this.stepFired = false;
      }
    }
    let step = this.steps[this.stepIndex];
    while (step && t - this.stepAt >= step.dur) {
      // Finish the step exactly where it meant to end.
      this.stepEnd(step);
      this.dx = this.endX;
      this.dy = this.endY;
      this.stepAt += step.dur;
      this.stepX0 = this.dx;
      this.stepY0 = this.dy;
      this.stepIndex++;
      this.stepFired = false;
      step = this.steps[this.stepIndex];
    }
    if (!step) return this.destroy();
    const k = clamp01((t - this.stepAt) / step.dur);
    this.stepEnd(step);
    const ax = this.stepX0;
    const ay = this.stepY0;
    const bx = this.endX;
    const by = this.endY;
    const u = step.ease === 'early' ? minJerk(Math.pow(k, 0.82)) : step.ease === 'exit' ? exitEase(k) : minJerk(k);
    if (step.curve) {
      // Quadratic bow, control point pushed sideways from the midpoint.
      const mx = (ax + bx) * 0.5 - (by - ay) * step.curve;
      const my = (ay + by) * 0.5 + (bx - ax) * step.curve;
      const iu = 1 - u;
      this.dx = iu * iu * ax + 2 * iu * u * mx + u * u * bx;
      this.dy = iu * iu * ay + 2 * iu * u * my + u * u * by;
    } else {
      this.dx = ax + (bx - ax) * u;
      this.dy = ay + (by - ay) * u;
    }

    // A hand over the link once it is really there; an arrow again once it is off it.
    const there = Math.hypot(this.x - this.tx, this.y - this.ty);
    let point = this.pointing;
    if (step.point && this.targetHand && there < 2.5) point = true;
    if (point && (step.leave || !step.point) && (this.x < this.rL || this.x > this.rR || this.y < this.rT || this.y > this.rB)) point = false;
    if (point !== this.pointing) {
      this.pointing = point;
      this.ghost!.classList.toggle('pointing', point);
    }
    // An I-beam while it is on the text, an arrow again once it lifts off.
    let read = this.reading;
    if (step.read && there < 2.5) read = true;
    if (read && !step.read && Math.hypot(this.x - this.stepX0, this.y - this.stepY0) > 8) read = false;
    if (read !== this.reading) {
      this.reading = read;
      this.ghost!.classList.toggle('reading', read);
    }

    // The press happens only once it has truly arrived.
    if (step.click && !this.stepFired && t >= this.stepAt + 120 && there < 1) {
      this.stepFired = true;
      this.ringAt = t;
      this.pressAt = t;
    }
    let scale = 1;
    if (!this.reduced) {
      const p = (t - this.pressAt) / 260;
      if (p >= 0 && p < 1) scale = 1 - 0.08 * Math.sin(p * Math.PI);
    }
    if (step.leave) this.leaveAlpha = 1 - smooth((k - 0.45) / 0.55);
    if (step.hold && (!step.click || this.stepFired)) this.holdUntil = this.stepAt + step.dur;
    this.render(t, dt, this.reduced ? 14 : 34, this.leaveAlpha, scale, false);
  }

  private endX = 0;
  private endY = 0;
  private stepEnd(step: Step): void {
    this.endX = step.rel ? this.tx + step.x : step.x;
    this.endY = step.rel ? this.ty + step.y : step.y;
  }

  /** Your path from a moment ago, smoothly interpolated, held slightly to one side. */
  private copyPath(t: number): void {
    const want = t - this.delay;
    const h = this.hist;
    let x = 0;
    let y = 0;
    // Walk back from the newest sample to the pair that straddles `want`.
    let newer = (this.histHead - 1 + HIST) % HIST;
    if (h[newer * 3 + 2] <= want) {
      x = h[newer * 3];
      y = h[newer * 3 + 1];
    } else {
      let found = false;
      for (let n = 1; n < this.histCount; n++) {
        const older = (newer - 1 + HIST) % HIST;
        const to = h[older * 3 + 2];
        if (to <= want) {
          const tn = h[newer * 3 + 2];
          const f = tn > to ? (want - to) / (tn - to) : 1;
          x = h[older * 3] + (h[newer * 3] - h[older * 3]) * f;
          y = h[older * 3 + 1] + (h[newer * 3 + 1] - h[older * 3 + 1]) * f;
          found = true;
          break;
        }
        newer = older;
      }
      if (!found) {
        x = h[newer * 3];
        y = h[newer * 3 + 1];
      }
    }
    // The offset sways a little while it moves, so it never feels bolted on.
    // (Keyed to the replayed path's time, so it holds still when you do.)
    const wob = Math.sin((Math.min(want, this.pt) - this.spawnAt) * 0.0007) * 0.3;
    const c = Math.cos(wob);
    const s = Math.sin(wob);
    let gx = x + this.offX * c - this.offY * s;
    let gy = y + this.offX * s + this.offY * c;
    const b = (t - this.blendAt) / 600;
    if (b < 1) {
      const e = minJerk(clamp01(b));
      gx = this.blendX + (gx - this.blendX) * e;
      gy = this.blendY + (gy - this.blendY) * e;
    }
    this.dx = gx;
    this.dy = gy;
    if (want > this.pt + 20 && b >= 1) this.holdUntil = Math.min(this.pt + this.delay + WANDER_AFTER, this.autonomyAt);
  }

  private startWander(t: number, pause: number): void {
    this.wFromX = this.wToX = this.dx;
    this.wFromY = this.wToY = this.dy;
    this.wAt = t;
    this.wDur = 1;
    this.wNext = t + pause;
  }

  /** No pointer to copy: small, unhurried, bowed trips nearby, with pauses. */
  private wander(t: number): void {
    if (t >= this.wNext && t - this.wAt >= this.wDur) {
      const r = this.rnd;
      // A new heading, never straight back the way it came.
      let a = r() * Math.PI * 2;
      if (this.wAngle === this.wAngle) {
        const back = this.wAngle + Math.PI;
        // Signed angle from straight back to the new heading, in -PI..PI.
        const diff = ((a - back + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        if (Math.abs(diff) < 1.1) a = back + (diff < 0 ? -1 : 1) * (1.1 + r() * 1.2);
      }
      const d = 50 + r() * 110;
      this.wFromX = this.dx;
      this.wFromY = this.dy;
      this.wToX = Math.min(this.vw - 40, Math.max(40, this.dx + Math.cos(a) * d));
      this.wToY = Math.min(this.vh - 40, Math.max(60, this.dy + Math.sin(a) * d));
      this.wAngle = Math.atan2(this.wToY - this.wFromY, this.wToX - this.wFromX);
      this.wCurve = (r() < 0.5 ? -1 : 1) * (0.12 + r() * 0.18);
      this.wAt = t;
      this.wDur = (650 + d * 3) * (this.reduced ? 1.6 : 1);
      this.wNext = t + this.wDur + 400 + r() * 900;
    }
    const k = (t - this.wAt) / this.wDur;
    if (k >= 1) {
      this.dx = this.wToX;
      this.dy = this.wToY;
      this.holdUntil = Math.min(this.wNext, this.autonomyAt);
      return;
    }
    const u = minJerk(clamp01(k));
    const ax = this.wFromX;
    const ay = this.wFromY;
    const bx = this.wToX;
    const by = this.wToY;
    const mx = (ax + bx) * 0.5 - (by - ay) * this.wCurve;
    const my = (ay + by) * 0.5 + (bx - ax) * this.wCurve;
    const iu = 1 - u;
    this.dx = iu * iu * ax + 2 * iu * u * mx + u * u * bx;
    this.dy = iu * iu * ay + 2 * iu * u * my + u * u * by;
  }

  /** Spring toward the desired point, record, write to the DOM, and decide whether to keep going. */
  private render(t: number, dt: number, omega: number, alpha: number, scale: number, capped: boolean): void {
    // Critically damped spring, exact for any frame time: smooth and never overshoots.
    const s = dt / 1000;
    const ex = Math.exp(-omega * s);
    let d = this.x - this.dx;
    let tmp = (this.vx + omega * d) * s;
    this.x = this.dx + (d + tmp) * ex;
    this.vx = (this.vx - omega * tmp) * ex;
    d = this.y - this.dy;
    tmp = (this.vy + omega * d) * s;
    this.y = this.dy + (d + tmp) * ex;
    this.vy = (this.vy - omega * tmp) * ex;
    let v = Math.hypot(this.vx, this.vy);
    if (capped && v > 320) {
      // Reduced motion while copying you: never fast.
      this.vx *= 320 / v;
      this.vy *= 320 / v;
      v = 320;
    }
    v /= 1000;
    this.speed += (v - this.speed) * Math.min(1, dt / 40);
    this.alpha = alpha;

    const i = this.rhHead * 3;
    this.rhist[i] = this.x;
    this.rhist[i + 1] = this.y;
    this.rhist[i + 2] = t;
    this.rhHead = (this.rhHead + 1) % RHIST;
    if (this.rhCount < RHIST) this.rhCount++;

    this.placeGhost(scale, alpha);
    this.drawTrails(v, alpha);
    const ringing = this.drawRing(t, alpha);

    // Sleep while it holds perfectly still and nothing else is changing.
    const settled =
      this.holdUntil - t > 30 &&
      !ringing &&
      !this.trailOn &&
      (this.phase !== 'follow' || t - this.spawnAt > (this.reduced ? 1400 : 900)) &&
      Math.abs(this.x - this.dx) < 0.05 &&
      Math.abs(this.y - this.dy) < 0.05 &&
      v < 0.001;
    if (settled) {
      this.idleTimer = window.setTimeout(() => this.wake(), this.holdUntil - t);
    } else {
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  /** Device-pixel snapping, like a real pointer, so the cursor stays crisp. */
  private snap(v: number): number {
    return Math.round(v * this.dpr) / this.dpr - SHIFT;
  }

  private placeGhost(scale: number, alpha: number): void {
    const el = this.ghost!;
    const px = this.snap(this.x);
    const py = this.snap(this.y);
    if (px !== this.wX || py !== this.wY || scale !== this.wS) {
      el.style.transform = scale === 1 ? `translate3d(${px}px,${py}px,0)` : `translate3d(${px}px,${py}px,0) scale(${scale})`;
      this.wX = px;
      this.wY = py;
      this.wS = scale;
    }
    const a = Math.round(alpha * 1000) / 1000;
    if (a !== this.wA) {
      el.style.opacity = String(a * 0.78);
      this.wA = a;
    }
  }

  /**
   * Afterimages: a short smear back along the path it just travelled, spaced by
   * distance and scaled by its speed right now, so it reads as motion blur.
   */
  private drawTrails(v: number, alpha: number): void {
    if (!this.trails.length) return;
    const k = smooth((v - 0.35) / 0.9) * alpha;
    if (k * TRAIL_ALPHA[0] < 0.01) {
      if (this.trailOn) {
        for (let i = 0; i < this.trails.length; i++) {
          this.trails[i].style.opacity = '0';
          this.trailW[i * 3 + 2] = 0;
        }
        this.trailOn = false;
      }
      return;
    }
    this.trailOn = true;
    const length = Math.min(TRAIL_MAX, v * 26);
    const h = this.rhist;
    let idx = (this.rhHead - 1 + RHIST) % RHIST;
    let ax = h[idx * 3];
    let ay = h[idx * 3 + 1];
    let walked = 0;
    let n = 1;
    for (let i = 0; i < this.trails.length; i++) {
      const want = (length * (i + 1)) / this.trails.length;
      let x = ax;
      let y = ay;
      // Walk back along the recorded path until `want` px are covered.
      for (;;) {
        if (n >= this.rhCount) break;
        const prev = (idx - 1 + RHIST) % RHIST;
        const bx = h[prev * 3];
        const by = h[prev * 3 + 1];
        const seg = Math.hypot(bx - ax, by - ay);
        if (walked + seg >= want) {
          const f = seg > 0 ? (want - walked) / seg : 0;
          x = ax + (bx - ax) * f;
          y = ay + (by - ay) * f;
          break;
        }
        walked += seg;
        ax = bx;
        ay = by;
        idx = prev;
        n++;
        x = ax;
        y = ay;
      }
      this.placeTrail(i, x, y, k * TRAIL_ALPHA[i]);
    }
  }

  private placeTrail(i: number, x: number, y: number, alpha: number): void {
    const el = this.trails[i];
    const w = this.trailW;
    const px = this.snap(x);
    const py = this.snap(y);
    const a = Math.round(alpha * 1000) / 1000;
    if (px !== w[i * 3] || py !== w[i * 3 + 1]) {
      el.style.transform = `translate3d(${px}px,${py}px,0)`;
      w[i * 3] = px;
      w[i * 3 + 1] = py;
    }
    if (a !== w[i * 3 + 2]) {
      el.style.opacity = String(a);
      w[i * 3 + 2] = a;
    }
  }

  /** The phantom click: the glow swells, and two soft ripples open from the tip. */
  private drawRing(t: number, alpha: number): boolean {
    const dur = this.reduced ? 1400 : 950;
    let busy = false;
    for (let i = 0; i < this.rings.length; i++) {
      const k = (t - this.ringAt - i * 280) / dur;
      let a = 0;
      let sc = 1;
      if (k >= 0 && k <= 1) {
        busy = true;
        const e = 1 - (1 - k) * (1 - k) * (1 - k);
        sc = 0.3 + e * 0.7;
        a = (k < 0.15 ? smooth(k / 0.15) : 1 - smooth((k - 0.15) / 0.85)) * (i ? 0.17 : 0.3) * (this.reduced ? 0.7 : 1) * alpha;
      } else if (k < 0) busy = true;
      a = Math.round(a * 1000) / 1000;
      const w = this.ringW;
      const o = i * 4;
      if (a > 0) {
        const px = Math.round(this.x * 2) / 2;
        const py = Math.round(this.y * 2) / 2;
        sc = Math.round(sc * 1000) / 1000;
        if (px !== w[o] || py !== w[o + 1] || sc !== w[o + 2]) {
          this.rings[i].style.transform = `translate3d(${px}px,${py}px,0) scale(${sc})`;
          w[o] = px;
          w[o + 1] = py;
          w[o + 2] = sc;
        }
      }
      if (a !== w[o + 3]) {
        this.rings[i].style.opacity = String(a);
        w[o + 3] = a;
      }
    }
    // The cold glow around the cursor swells with the press and settles back.
    const g = (t - this.ringAt) / (this.reduced ? 1200 : 800);
    const swell = g >= 0 && g < 1 ? Math.sin(g * Math.PI) * (1 - g * 0.3) : 0;
    const q = Math.round(swell * 100) / 100;
    if (q !== this.auraW && this.aura) {
      this.aura.style.transform = q ? `scale(${1 + q * 0.5})` : '';
      this.auraW = q;
    }
    return busy && t - this.ringAt < dur + 280;
  }
}
