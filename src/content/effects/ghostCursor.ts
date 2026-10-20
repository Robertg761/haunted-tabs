// Ghost cursor: a faint second mouse pointer that copies yours from a moment
// ago, then stops copying and goes about its own business. It glides to a link
// or button on the page, hovers it, gives it a slow phantom "click", and drifts
// up toward the tab strip before fading away. Sweep your mouse at it and it
// flinches and is gone.
//
// Everything is drawn in our own click-through overlay: one small vector arrow
// and a few afterimages moved with compositor-only transforms. The page never
// receives an event from us, and nothing of the page is changed.

import type { Effect, EffectContext } from './types';
import { createOverlay, seeded, type Overlay } from './overlay';

/** The standard arrow cursor, hotspot at 0,0 (about 12 by 20 CSS pixels). */
const ARROW = 'M0 0L0 17.2L4.15 13.25L6.95 19.75L9.7 18.6L6.95 12.35L12.5 12.35Z';
/**
 * The arrow's SVG box. The arrow's origin sits half a pixel into it and the box
 * moves in whole pixels, so 1px strokes land exactly on device pixels.
 */
const PAD = 11.5;
const SHIFT = 12;
const BOX_W = 40;
const BOX_H = 44;

const HIST = 256; // recorded pointer samples (x, y, t)
const RHIST = 32; // rendered positions, for afterimages (x, y, t)
const TRAILS = 4;
const TRAIL_LAG = 16; // ms between afterimages...
const TRAIL_GAP = 9; // ...but never more than this many px apart
const TRAIL_ALPHA = [0.52, 0.34, 0.2, 0.1];

const FLINCH_RADIUS = 60;
const FLINCH_SPEED = 0.9; // px/ms: a quick swipe, not a drift

const CSS = `
  .g, .t, .ring { position: absolute; left: 0; top: 0; opacity: 0; will-change: transform, opacity; }
  .g, .t { width: ${BOX_W}px; height: ${BOX_H}px; transform-origin: ${PAD}px ${PAD}px; }
  .t { filter: blur(0.6px); }
  svg { display: block; overflow: visible; }
  .aura {
    position: absolute; left: -6px; top: -2px; width: 44px; height: 46px; border-radius: 50%;
    background: radial-gradient(closest-side, rgba(150, 190, 255, 0.22), rgba(150, 190, 255, 0.08) 55%, rgba(150, 190, 255, 0));
  }
  .ring {
    width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; box-sizing: border-box;
    border: 1.5px solid rgba(150, 188, 255, 0.85);
    box-shadow: 0 0 7px rgba(120, 165, 255, 0.55), inset 0 0 5px rgba(120, 165, 255, 0.4);
  }
`;

const GHOST_SVG = `<svg width="${BOX_W}" height="${BOX_H}" viewBox="${-PAD} ${-PAD} ${BOX_W} ${BOX_H}" aria-hidden="true">
  <g fill="none" stroke-linejoin="round" stroke="rgb(125, 172, 255)">
    <path d="${ARROW}" stroke-width="10" stroke-opacity="0.07"/>
    <path d="${ARROW}" stroke-width="6" stroke-opacity="0.12"/>
    <path d="${ARROW}" stroke-width="3.2" stroke-opacity="0.24"/>
  </g>
  <path d="${ARROW}" fill="rgb(232, 241, 255)" fill-opacity="0.92" stroke="rgb(28, 40, 66)" stroke-opacity="0.55" stroke-width="1" stroke-linejoin="round"/>
</svg>`;

const TRAIL_SVG = `<svg width="${BOX_W}" height="${BOX_H}" viewBox="${-PAD} ${-PAD} ${BOX_W} ${BOX_H}" aria-hidden="true">
  <path d="${ARROW}" fill="rgb(176, 204, 255)" fill-opacity="0.75" stroke="rgb(92, 132, 222)" stroke-opacity="0.5" stroke-width="1.4" stroke-linejoin="round"/>
</svg>`;

type Phase = 'idle' | 'wait' | 'follow' | 'script' | 'flinch' | 'fading';

/** One scripted motion: a curved glide (or a hold, when it goes nowhere). */
interface Step {
  dur: number;
  /** Where it ends: absolute viewport point, or an offset from the target. */
  rel: boolean;
  x: number;
  y: number;
  /** Sideways bow of the path, as a fraction of its length. */
  curve: number;
  ease: 'mj' | 'early' | 'in';
  click?: boolean;
  leave?: boolean;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};
/** Minimum-jerk profile: how a hand moves a mouse from rest to rest. */
const minJerk = (t: number) => t * t * t * (10 + t * (6 * t - 15));

export class GhostCursor implements Effect {
  readonly name = 'ghostCursor' as const;

  private overlay: Overlay | null = null;
  private ghost: HTMLDivElement | null = null;
  private trails: HTMLDivElement[] = [];
  private ring: HTMLDivElement | null = null;

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

  // Viewport.
  private vw = 0;
  private vh = 0;
  private dpr = 1;
  private sx = 0;
  private sy = 0;

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
  private dx = 0; // desired position
  private dy = 0;
  private x = 0; // rendered position (spring-smoothed)
  private y = 0;
  private vx = 0;
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

  // Wandering, when your pointer gives it nothing to copy.
  private wFromX = 0;
  private wFromY = 0;
  private wToX = 0;
  private wToY = 0;
  private wAt = 0;
  private wDur = 0;
  private wNext = 0;

  // The script it follows once it acts on its own.
  private steps: Step[] = [];
  private stepIndex = 0;
  private stepAt = 0;
  private stepX0 = 0;
  private stepY0 = 0;
  private stepFired = false;
  private candidates: { el: Element; x: number; y: number; w: number; h: number }[] = [];
  private tx = 0; // target hover point, page coordinates
  private ty = 0;
  private ringAt = -1e9;
  private pressAt = -1e9;
  private leaveAlpha = 1;

  // Flinch.
  private flinchAt = 0;

  // Last values written to the DOM, so still frames write nothing.
  private wX = NaN;
  private wY = NaN;
  private wS = NaN;
  private wA = NaN;
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
    const angle = 0.35 + r() * 1.1 + (r() < 0.3 ? Math.PI * 0.5 : 0);
    const dist = 14 + r() * 9;
    this.offX = Math.cos(angle) * dist;
    this.offY = Math.sin(angle) * dist;

    this.overlay = createOverlay(this.name, CSS);
    const layer = this.overlay.layer;
    if (!this.reduced) {
      for (let i = 0; i < TRAILS; i++) {
        const t = document.createElement('div');
        t.className = 't';
        t.innerHTML = TRAIL_SVG;
        layer.appendChild(t);
        this.trails.push(t);
      }
    }
    this.ring = document.createElement('div');
    this.ring.className = 'ring';
    this.ghost = document.createElement('div');
    this.ghost.className = 'g';
    this.ghost.innerHTML = `<div class="aura"></div>${GHOST_SVG}`;
    layer.append(this.ring, this.ghost);

    this.measure();
    this.findCandidates();
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
    this.ring = null;
    this.trails = [];
    this.candidates = [];
    this.steps = [];
    this.phase = 'idle';
    this.histCount = this.rhCount = 0;
    this.pointerSeen = false;
    this.alpha = 0;
    this.wX = this.wY = this.wS = this.wA = NaN;
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
    this.sx = scrollX;
    this.sy = scrollY;
  };

  private listen(on: boolean): void {
    if (on === this.listening) return;
    this.listening = on;
    const opts: AddEventListenerOptions = { passive: true, capture: true };
    if (on) {
      window.addEventListener('pointermove', this.onPointer, opts);
      window.addEventListener('scroll', this.onScroll, opts);
      window.addEventListener('resize', this.measure, opts);
      document.addEventListener('visibilitychange', this.onVisibility, opts);
    } else {
      window.removeEventListener('pointermove', this.onPointer, opts);
      window.removeEventListener('scroll', this.onScroll, opts);
      window.removeEventListener('resize', this.measure, opts);
      document.removeEventListener('visibilitychange', this.onVisibility, opts);
    }
  }

  private onScroll = (): void => {
    this.sx = scrollX;
    this.sy = scrollY;
  };

  private onVisibility = (): void => {
    if (document.hidden) {
      if (!this.hiddenSince) this.hiddenSince = performance.now();
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      clearTimeout(this.idleTimer);
    } else {
      if (this.hiddenSince) this.hiddenTotal += performance.now() - this.hiddenSince;
      this.hiddenSince = 0;
      if (this.phase === 'fading') this.destroy();
      else if (this.phase !== 'wait') this.wake();
    }
  };

  private onPointer = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return;
    const t = this.now();
    const x = e.clientX;
    const y = e.clientY;
    let speed = 0;
    if (this.pointerSeen) {
      const dt = Math.max(1, t - this.pt);
      const mx = x - this.px;
      const my = y - this.py;
      speed = Math.hypot(mx, my) / dt;
      this.maybeFlinch(x, y, mx, my, speed);
    }
    this.px = x;
    this.py = y;
    this.pt = t;
    const first = !this.pointerSeen;
    this.pointerSeen = true;
    const i = this.histHead * 3;
    this.hist[i] = x;
    this.hist[i + 1] = y;
    this.hist[i + 2] = t;
    this.histHead = (this.histHead + 1) % HIST;
    if (this.histCount < HIST) this.histCount++;

    if (this.phase === 'wait') {
      this.spawn();
    } else if (this.phase === 'follow') {
      // It was wandering on its own: now there is something to copy.
      if (first) this.markBlend();
      this.wake();
    }
  };

  // ---- lifecycle of the apparition ------------------------------------------------

  private spawn(): void {
    if (this.phase !== 'wait') return;
    clearTimeout(this.spawnTimer);
    this.spawnTimer = undefined;
    const r = this.rnd;
    const t = this.now();
    this.spawnAt = t;
    this.autonomyAt = t + 4000 + r() * 1300;
    if (this.pointerSeen) {
      this.dx = this.px + this.offX;
      this.dy = this.py + this.offY;
    } else {
      // Nothing to copy: it shows up near the middle and finds its own way.
      this.dx = this.vw * (0.42 + r() * 0.16);
      this.dy = this.vh * (0.38 + r() * 0.18);
    }
    this.x = this.dx;
    this.y = this.dy;
    this.vx = this.vy = 0;
    this.wFromX = this.wToX = this.dx;
    this.wFromY = this.wToY = this.dy;
    this.wAt = t;
    this.wDur = 1;
    this.wNext = t + 500 + r() * 700;
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

  private maybeFlinch(x: number, y: number, mx: number, my: number, speed: number): void {
    if (this.phase !== 'follow' && this.phase !== 'script') return;
    if (this.alpha < 0.3 || this.now() - this.spawnAt < 1200 || speed < FLINCH_SPEED) return;
    const gx = this.x - x;
    const gy = this.y - y;
    const d = Math.hypot(gx, gy);
    if (d > FLINCH_RADIUS) return;
    // Only when you come at it, not when you sweep away from it.
    if (d > 8 && (mx * gx + my * gy) / (Math.hypot(mx, my) * d || 1) < 0.2) return;
    const k = d > 0.5 ? 1 / d : 0;
    const ux = d > 0.5 ? gx * k : mx / (Math.hypot(mx, my) || 1);
    const uy = d > 0.5 ? gy * k : my / (Math.hypot(mx, my) || 1);
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

  /** Once, at start: a handful of visible links and buttons to take an interest in. */
  private findCandidates(): void {
    const els = document.querySelectorAll('a[href], button, [role="button"], input[type="submit"], input[type="button"], summary');
    const n = Math.min(els.length, 400);
    const found: { el: Element; x: number; y: number; w: number; h: number; score: number }[] = [];
    const cx = this.vw * 0.5;
    const cy = this.vh * 0.5;
    for (let i = 0; i < n; i++) {
      const el = els[i];
      const r = el.getBoundingClientRect();
      if (r.width < 12 || r.height < 10 || r.width > 520 || r.height > 160) continue;
      if (r.left < 8 || r.top < 8 || r.right > this.vw - 8 || r.bottom > this.vh - 8) continue;
      const d = Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy) / Math.hypot(cx, cy);
      found.push({ el, x: r.left + this.sx, y: r.top + this.sy, w: r.width, h: r.height, score: 1 - d * 0.6 + this.rnd() * 0.5 });
    }
    found.sort((a, b) => b.score - a.score);
    for (const f of found) {
      if (this.candidates.length >= 8) break;
      // Skip anything covered by something else.
      const hit = document.elementFromPoint(f.x - this.sx + f.w / 2, f.y - this.sy + f.h / 2);
      if (hit && (hit === f.el || f.el.contains(hit))) this.candidates.push(f);
    }
  }

  /** At the moment it decides: the best candidate from where it is now. */
  private chooseTarget(): boolean {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < this.candidates.length; i++) {
      const c = this.candidates[i];
      const vx = c.x - this.sx + c.w / 2;
      const vy = c.y - this.sy + c.h / 2;
      if (vx < 20 || vy < 20 || vx > this.vw - 20 || vy > this.vh - 20) continue;
      const d = Math.hypot(vx - this.dx, vy - this.dy);
      const fromYou = this.pointerSeen ? Math.hypot(vx - this.px, vy - this.py) : 999;
      // A deliberate trip: not right where it is, not across the world, not under your cursor.
      let score = -Math.abs(d - 340) / 340 + this.rnd() * 0.35;
      if (d < 70) score -= 2;
      if (fromYou < 90) score -= 1;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) return false;
    const c = this.candidates[best];
    // One fresh read, in case the page moved since we looked.
    const r = c.el.isConnected ? c.el.getBoundingClientRect() : null;
    if (!r || r.width < 4 || r.bottom < 0 || r.top > this.vh) return false;
    const fx = 0.3 + this.rnd() * 0.3;
    this.tx = r.left + this.sx + Math.min(r.width * fx, 26 + this.rnd() * 30);
    this.ty = r.top + this.sy + r.height * (0.45 + this.rnd() * 0.15);
    return true;
  }

  /** It stops copying you and makes its own plan. */
  private beginScript(): void {
    const r = this.rnd;
    const slow = this.reduced ? 1.5 : 1;
    const steps: Step[] = [];
    const hasTarget = this.chooseTarget();
    if (!hasTarget) {
      // Nothing to reach for: somewhere a little way off, as if reading.
      const a = r() * Math.PI * 2;
      const d = 160 + r() * 160;
      this.tx = Math.min(this.vw - 60, Math.max(60, this.dx + Math.cos(a) * d)) + this.sx;
      this.ty = Math.min(this.vh - 60, Math.max(80, this.dy + Math.sin(a) * d)) + this.sy;
    }
    const x0 = this.dx;
    const y0 = this.dy;
    const txv = this.tx - this.sx;
    const tyv = this.ty - this.sy;
    const len = Math.hypot(txv - x0, tyv - y0) || 1;
    const ux = (txv - x0) / len;
    const uy = (tyv - y0) / len;
    const side = r() < 0.5 ? -1 : 1;

    // Stops dead. Settles. Seems to look around, then makes a false start.
    steps.push({ dur: 360 + r() * 200, rel: false, x: x0, y: y0, curve: 0, ease: 'mj' });
    const lx = x0 + (r() - 0.5) * 12;
    const ly = y0 + (r() - 0.5) * 10;
    steps.push({ dur: 380 * slow, rel: false, x: lx, y: ly, curve: 0, ease: 'mj' });
    steps.push({ dur: 160 + r() * 140, rel: false, x: lx, y: ly, curve: 0, ease: 'mj' });
    const fx = lx + ux * (10 + r() * 8) - uy * side * 3;
    const fy = ly + uy * (10 + r() * 8) + ux * side * 3;
    steps.push({ dur: 240 * slow, rel: false, x: fx, y: fy, curve: 0, ease: 'mj' });
    steps.push({ dur: 300 + r() * 200, rel: false, x: fx, y: fy, curve: 0, ease: 'mj' });

    // The glide: a gentle bow, a slight overshoot, a small correction.
    const over = this.reduced ? 0 : 6 + r() * 7;
    const err = (r() - 0.5) * 6;
    const glide = Math.min(1500, Math.max(700, 520 + len * 0.95)) * slow;
    steps.push({ dur: glide, rel: true, x: ux * over - uy * err, y: uy * over + ux * err, curve: side * (0.08 + r() * 0.08), ease: 'early' });
    if (!this.reduced) steps.push({ dur: 300 + r() * 80, rel: true, x: 0, y: 0, curve: 0, ease: 'mj' });

    // It hovers. A slow press. It lingers on what it touched.
    steps.push({ dur: 380 + r() * 160, rel: true, x: 0, y: 0, curve: 0, ease: 'mj' });
    steps.push({ dur: 900 + r() * 300, rel: true, x: 0, y: 0, curve: 0, ease: 'mj', click: true });
    steps.push({ dur: 320 * slow, rel: true, x: (r() - 0.5) * 6, y: -2 - r() * 3, curve: 0, ease: 'mj' });

    // Up toward the tab strip, and gone.
    const upX = Math.min(this.vw - 30, Math.max(30, txv + side * (40 + r() * 120)));
    steps.push({ dur: (1800 + r() * 400) * (this.reduced ? 1.4 : 1), rel: false, x: upX, y: -46, curve: -side * 0.12, ease: 'in', leave: true });

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
    let alpha = 1;
    let scale = 1;
    let omega = this.reduced ? 5 : 34; // spring stiffness: snappy normally, languid when reduced

    switch (this.phase) {
      case 'follow': {
        if (t >= this.autonomyAt) {
          this.beginScript();
          return this.frame2(t, dt, omega);
        }
        if (this.histCount > 0) this.copyPath(t);
        else this.wander(t);
        break;
      }
      case 'script':
        return this.frame2(t, dt, omega);
      case 'flinch': {
        const k = (t - this.flinchAt) / (this.reduced ? 700 : 300);
        if (k >= 1) return this.destroy();
        alpha = this.fadeFrom * (1 - smooth(k));
        omega = 30;
        break;
      }
      case 'fading': {
        const k = (t - this.fadeAt) / this.fadeDur;
        if (k >= 1) return this.destroy();
        alpha = this.fadeFrom * (1 - smooth(k));
        this.dy -= dt * 0.01;
        break;
      }
      default:
        return;
    }
    if (this.phase === 'follow') alpha = smooth((t - this.spawnAt) / (this.reduced ? 1400 : 900));
    this.render(t, dt, omega, alpha, scale);
  };

  /** Scripted frames, split out so the switch above stays readable. */
  private frame2(t: number, dt: number, omega: number): void {
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
    let u: number;
    if (step.ease === 'early') u = minJerk(Math.pow(k, 0.82));
    else if (step.ease === 'in') u = k * k * (1.6 - 0.6 * k);
    else u = minJerk(k);
    const ax = this.stepX0;
    const ay = this.stepY0;
    const bx = this.endX;
    const by = this.endY;
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
    let scale = 1;
    if (step.click) {
      const at = this.stepAt + 120;
      if (!this.stepFired && t >= at) {
        this.stepFired = true;
        this.ringAt = t;
        this.pressAt = t;
      }
    }
    if (!this.reduced) {
      const p = (t - this.pressAt) / 260;
      if (p >= 0 && p < 1) scale = 1 - 0.1 * Math.sin(p * Math.PI);
    }
    if (step.leave) this.leaveAlpha = 1 - smooth((k - 0.25) / 0.65);
    this.render(t, dt, omega, this.leaveAlpha, scale);
  }

  private endX = 0;
  private endY = 0;
  private stepEnd(step: Step): void {
    if (step.rel) {
      this.endX = this.tx - this.sx + step.x;
      this.endY = this.ty - this.sy + step.y;
    } else {
      this.endX = step.x;
      this.endY = step.y;
    }
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
    const wob = Math.sin((Math.min(want, this.pt) - this.spawnAt) * 0.0007) * 0.35;
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
  }

  /** No pointer to copy: small, unhurried trips nearby, with pauses. */
  private wander(t: number): void {
    if (t >= this.wNext && t - this.wAt >= this.wDur) {
      const r = this.rnd;
      const a = r() * Math.PI * 2;
      const d = 50 + r() * 110;
      this.wFromX = this.dx;
      this.wFromY = this.dy;
      this.wToX = Math.min(this.vw - 40, Math.max(40, this.dx + Math.cos(a) * d));
      this.wToY = Math.min(this.vh - 40, Math.max(60, this.dy + Math.sin(a) * d));
      this.wAt = t;
      this.wDur = (650 + d * 3) * (this.reduced ? 1.8 : 1);
      this.wNext = t + this.wDur + 400 + r() * 900;
    }
    const e = minJerk(clamp01((t - this.wAt) / this.wDur));
    this.dx = this.wFromX + (this.wToX - this.wFromX) * e;
    this.dy = this.wFromY + (this.wToY - this.wFromY) * e;
  }

  /** Spring toward the desired point, record, write to the DOM, and decide whether to keep going. */
  private render(t: number, dt: number, omega: number, alpha: number, scale: number): void {
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
    if (this.reduced) {
      // Never fast: cap the speed outright.
      const v = Math.hypot(this.vx, this.vy);
      if (v > 320) {
        this.vx *= 320 / v;
        this.vy *= 320 / v;
      }
    }
    const v = Math.hypot(this.vx, this.vy) / 1000;
    this.speed += (v - this.speed) * Math.min(1, dt / 40);
    this.alpha = alpha;

    const i = this.rhHead * 3;
    this.rhist[i] = this.x;
    this.rhist[i + 1] = this.y;
    this.rhist[i + 2] = t;
    this.rhHead = (this.rhHead + 1) % RHIST;
    if (this.rhCount < RHIST) this.rhCount++;

    this.place(this.ghost!, this.x, this.y, scale, alpha, true);
    this.drawTrails(t, alpha);
    this.drawRing(t, alpha);

    // Keep animating unless it is holding perfectly still with nothing to wait for.
    const still =
      this.phase === 'follow' &&
      this.histCount > 0 &&
      t - this.spawnAt > 1500 &&
      t - this.blendAt > 700 &&
      t - this.pt > this.delay + 50 &&
      Math.abs(this.x - this.dx) < 0.05 &&
      Math.abs(this.y - this.dy) < 0.05 &&
      Math.abs(this.vx) + Math.abs(this.vy) < 1 &&
      !this.trailOn;
    if (still) {
      // Asleep until you move again or it is time to act.
      this.idleTimer = window.setTimeout(() => this.wake(), Math.max(16, this.autonomyAt - t));
    } else {
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  private place(el: HTMLElement, x: number, y: number, scale: number, alpha: number, main: boolean): void {
    // Snap to device pixels like a real pointer, so the arrow stays crisp.
    const px = Math.round(x * this.dpr) / this.dpr - SHIFT;
    const py = Math.round(y * this.dpr) / this.dpr - SHIFT;
    const a = Math.round(alpha * 1000) / 1000;
    if (main) {
      if (px !== this.wX || py !== this.wY || scale !== this.wS) {
        el.style.transform = scale === 1 ? `translate3d(${px}px,${py}px,0)` : `translate3d(${px}px,${py}px,0) scale(${scale})`;
        this.wX = px;
        this.wY = py;
        this.wS = scale;
      }
      if (a !== this.wA) {
        el.style.opacity = String(a * 0.78);
        this.wA = a;
      }
    } else {
      el.style.transform = `translate3d(${px}px,${py}px,0)`;
      el.style.opacity = String(a);
    }
  }

  /** Afterimages: where it was a few frames ago, only visible when it moves fast. */
  private drawTrails(t: number, alpha: number): void {
    if (!this.trails.length) return;
    const k = smooth((this.speed - 0.3) / 0.9) * alpha;
    if (k < 0.004) {
      if (this.trailOn) {
        for (let i = 0; i < this.trails.length; i++) this.trails[i].style.opacity = '0';
        this.trailOn = false;
      }
      return;
    }
    this.trailOn = true;
    // Close-packed, so it smears like motion blur instead of stamping copies.
    const lag = Math.min(TRAIL_LAG, TRAIL_GAP / Math.max(0.01, this.speed));
    for (let i = 0; i < this.trails.length; i++) {
      const want = t - (i + 1) * lag;
      this.sampleRendered(want);
      this.place(this.trails[i], this.sX, this.sY, 1, k * TRAIL_ALPHA[i], false);
    }
  }

  private sX = 0;
  private sY = 0;
  private sampleRendered(want: number): void {
    const h = this.rhist;
    let newer = (this.rhHead - 1 + RHIST) % RHIST;
    for (let n = 1; n < this.rhCount; n++) {
      const older = (newer - 1 + RHIST) % RHIST;
      const to = h[older * 3 + 2];
      if (to <= want) {
        const tn = h[newer * 3 + 2];
        const f = tn > to ? (want - to) / (tn - to) : 1;
        this.sX = h[older * 3] + (h[newer * 3] - h[older * 3]) * f;
        this.sY = h[older * 3 + 1] + (h[newer * 3 + 1] - h[older * 3 + 1]) * f;
        return;
      }
      newer = older;
    }
    this.sX = h[newer * 3];
    this.sY = h[newer * 3 + 1];
  }

  /** The phantom click: one slow ring opening from the tip. */
  private drawRing(t: number, alpha: number): void {
    const ring = this.ring!;
    const dur = this.reduced ? 1400 : 850;
    const k = (t - this.ringAt) / dur;
    if (k < 0 || k > 1) {
      if (ring.style.opacity !== '0') ring.style.opacity = '0';
      return;
    }
    const e = 1 - (1 - k) * (1 - k) * (1 - k);
    const sc = 0.12 + e * (this.reduced ? 0.6 : 0.88);
    const a = (k < 0.12 ? smooth(k / 0.12) : 1 - smooth((k - 0.12) / 0.88)) * (this.reduced ? 0.4 : 0.7) * alpha;
    ring.style.transform = `translate3d(${this.x}px,${this.y}px,0) scale(${sc})`;
    ring.style.opacity = String(Math.round(a * 1000) / 1000);
  }
}
