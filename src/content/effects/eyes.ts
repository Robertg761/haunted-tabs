// Eyes in the dark. Come back to a dead tab and, after a moment, darkness pools
// in an empty part of the page and a pair of eyes slowly opens in it. They
// follow the cursor, blink, squint, and shut the instant you come for them,
// only to open again somewhere else. After three retreats, or about 45 seconds,
// they close for good. An entombed tab has a second, fainter pair further off.
//
// Everything is drawn on small canvases inside our own overlay; the page is
// only ever read (in idle time, to find somewhere truly empty), never touched.
// If nowhere is empty, nothing opens: the eyes never cover the page's content.

import type { Effect, EffectContext } from './types';
import { createOverlay, seeded, type Overlay } from './overlay';
import { EYE_BOX, Scan, Search, densifySpot, pageIsDark, stillFree, viewportSize, type PlaceOptions, type Rect, type Spot } from './eyes-place';
import { PALETTES, SCLERA_BOX, SOFT, paintDab, paintIris, paintPoolCore, paintPupil, paintSclera, type Palette } from './eyes-paint';

const LIFETIME = 45_000;
const MAX_RETREATS = 3;
/** The cursor this close (px from the eyes) makes them shut. */
const NEAR = 180;
/** Cursor speed towards the eyes (px/ms) that makes them shut from further away. */
const LUNGE = 1.25;
const LUNGE_RANGE = 460;
/** Start looking for a spot this long before the eyes are due. */
const PLAN_AHEAD = 700;

// Eye geometry, in eye widths, for an eye with its inner corner at -x.
const IRIS_R = 0.215;
const UPPER_OPEN = -0.27;
const LOWER_OPEN = 0.205;
const MEET = 0.1;
const P0X = -0.5;
const P0Y = 0.035;
const P3X = 0.5;
const P3Y = -0.04;
const C1X = -0.2;
const C2X = 0.25;
const SLIT = 0.17;
/** Resting openness: the upper lid over the top of the iris, heavy and patient. Wide is for surprise. */
const REST = 0.72;
/** How far the iris can travel: sideways, up, down. */
const MAX_X = 0.19;
const MAX_UP = 0.085;
const MAX_DOWN = 0.065;
const LASHES = 12;
const LOWER_LASHES = 9;

// Canvas sizes in eye widths. The darkness is soft, so it is drawn at half resolution.
const EYES_W = 4.3;
const EYES_H = 1.6;
const POOL_W = 6.2;
const POOL_H = 3.8;
const POOL_RES = 0.5;
const POOL_DY = 0.1;

const CSS = `
.w { position: absolute; left: 0; top: 0; display: none; will-change: transform; }
.w canvas { position: absolute; left: 0; top: 0; }
.w .pool { will-change: transform, opacity; }
`;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);
const easeInQuad = (t: number) => t * t;
const easeOutCubic = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

type Phase = 'waiting' | 'revealing' | 'watching' | 'retreating' | 'closing' | 'done';
type BlinkKind = 'single' | 'double' | 'slow';
type CloseKind = 'retreat' | 'stop' | 'final';
type PlanState = 'none' | 'pending' | 'ready' | 'nowhere';

interface Pointer {
  x: number;
  y: number;
  vx: number;
  vy: number;
  known: boolean;
  /** performance.now() of the last move. */
  at: number;
}

/** Where a pair will open, with what it needs to stay put on the page. */
interface Plan {
  spot: Spot;
  dark: boolean;
  /** The scrolling element under the spot (null: the page itself), and its scroll at planning time. */
  anchor: Element | null;
  ax: number;
  ay: number;
  sx: number;
  sy: number;
  vw: number;
  vh: number;
  at: number;
  pinned: Rect[];
}

interface Eye {
  side: -1 | 1;
  lx: number;
  ly: number;
  size: number;
  droop: number;
  lag: number;
  stiff: number;
  ph: number;
  ox: number;
  oy: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
  jfx: number;
  jfy: number;
  jtx: number;
  jty: number;
  dil: number;
  up: number;
  lo: number;
  ix: number;
  iy: number;
  iris: HTMLCanvasElement | null;
  sclera: HTMLCanvasElement | null;
  /** Per lash: position along the lid, length, angle jitter. */
  lashes: Float32Array;
}

interface Wisp {
  x: number;
  y: number;
  rx: number;
  ry: number;
  a: number;
  fx: number;
  fy: number;
  ph: number;
  drift: number;
}

interface Host {
  readonly pointer: Pointer;
  readonly reduced: boolean;
  readonly stage: number;
  readonly dpr: number;
  readonly seed: number;
  readonly palette: Palette;
  readonly layer: HTMLElement;
  readonly clock: number;
  rand(): number;
  onWatching(w: Watcher): void;
  onRetreat(w: Watcher, counted: boolean): void;
}

/** One pair of eyes and the darkness around it. */
class Watcher {
  phase: Phase = 'waiting';
  wakeAt = Infinity;
  /** When this pair next closes it stays closed. */
  final = false;
  plan: Plan | null = null;
  planState: PlanState = 'none';
  x = 0;
  y = 0;
  w = 40;
  anchor: Element | null = null;
  private baseX = 0;
  private baseY = 0;
  private sx0 = 0;
  private sy0 = 0;
  private ax0 = 0;
  private ay0 = 0;
  private pinned: Rect[] = [];
  private tilt = 0;
  private cos = 1;
  private sin = 0;
  private phaseT = 0;
  private revealed = false;
  private pool = 0;
  private env0 = 0;
  /** How wide they fly in the instant before they shut (only eyes that were really open). */
  private startle = 1.1;
  private pool0 = 0;
  private closeKind: CloseKind = 'retreat';
  private closeMs = 80;
  private dissolveDelay = 30;
  private dissolveMs = 880;
  private reopenDelay = 3000;
  private gather = 2000;
  private slitIn = 520;
  private slitHold = 700;
  private openMs = 1150;
  private gazeOn = false;
  private watchStart = -1;
  private widenAt = -1e9;
  private widenRise = 0;
  private lastDraw = -Infinity;
  private lastPoolDraw = -Infinity;
  private poolStyle = '';
  private poolOpacity = -1;
  calm = false;
  /** Something fast is happening (a blink shutting, a jump, a snap, the cursor moving): full frame rate. */
  urgent = true;

  private nextBlink = 0;
  private blinkAt = -1e9;
  private blinkKind: BlinkKind = 'single';
  private squintAt = -1e9;
  private squintDur = 1000;
  private nextSacc = 0;
  private sx = 0;
  private sy = 0;
  private svx = 0;
  private svy = 0;
  private stx = 0;
  private sty = 0;
  private glanceUntil = 0;
  private jumpAt = -1;
  private jumpDur = 50;
  private lastJump = -1e9;
  private wander = 0;

  private readonly el: HTMLDivElement;
  private readonly eyeC: HTMLCanvasElement;
  private readonly eyeG: CanvasRenderingContext2D;
  private readonly poolC: HTMLCanvasElement;
  private readonly poolG: CanvasRenderingContext2D;
  private ew = 0;
  private eh = 0;
  private pw = 0;
  private ph = 0;
  private readonly eyes: [Eye, Eye];
  private wisps: Wisp[] = [];
  private spriteDpr = 0;
  private pupil: HTMLCanvasElement | null = null;
  private highlight: HTMLCanvasElement | null = null;
  private glow: HTMLCanvasElement | null = null;
  private socket: HTMLCanvasElement | null = null;
  private readonly core: HTMLCanvasElement;
  private readonly tail: HTMLCanvasElement;
  private coreA = 0.95;
  private tailA = 0.08;

  constructor(
    private readonly host: Host,
    readonly main: boolean,
    /** Relative size and strength: the far pair of an entombed tab is smaller and fainter. */
    readonly scale: number,
    private readonly alpha: number,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'w';
    this.poolC = document.createElement('canvas');
    this.poolC.className = 'pool';
    this.eyeC = document.createElement('canvas');
    this.el.append(this.poolC, this.eyeC);
    host.layer.appendChild(this.el);
    this.poolG = this.poolC.getContext('2d')!;
    this.eyeG = this.eyeC.getContext('2d')!;
    const r = seeded(host.seed ^ (main ? 0x51ed : 0x2bad));
    const makeEye = (side: -1 | 1): Eye => ({
      side,
      lx: 0,
      ly: 0,
      size: 1,
      droop: 1,
      lag: 0,
      stiff: 0.9 + r() * 0.2,
      ph: r() * 10,
      ox: 0,
      oy: 0,
      vx: 0,
      vy: 0,
      tx: 0,
      ty: 0,
      jfx: 0,
      jfy: 0,
      jtx: 0,
      jty: 0,
      dil: 0.6,
      up: 0,
      lo: 0,
      ix: 0,
      iy: 0,
      iris: null,
      sclera: null,
      lashes: new Float32Array(LASHES * 3),
    });
    this.eyes = [makeEye(-1), makeEye(1)];
    // A face is never quite symmetrical: one eye a touch smaller, one lid heavier.
    const odd = this.eyes[r() < 0.5 ? 0 : 1];
    odd.size = 0.955 + r() * 0.03;
    odd.lag = 10 + r() * 14;
    this.eyes[r() < 0.5 ? 0 : 1].droop = 0.92 + r() * 0.05;
    this.wander = r() * 100;
    this.core = paintPoolCore(128, [6, 5, 10], r);
    this.tail = paintDab(96, [6, 5, 10], SOFT);
  }

  get visible(): boolean {
    return this.phase === 'revealing' || this.phase === 'watching' || this.phase === 'retreating' || this.phase === 'closing';
  }

  /** Has the plan gone stale (scrolled, resized, too old) since it was made? */
  planValid(): boolean {
    const p = this.plan;
    if (!p || performance.now() - p.at > 6000 || scrollX !== p.sx || scrollY !== p.sy) return false;
    if (p.anchor && (!p.anchor.isConnected || p.anchor.scrollLeft !== p.ax || p.anchor.scrollTop !== p.ay)) return false;
    const { vw, vh } = viewportSize();
    return vw === p.vw && vh === p.vh;
  }

  // --- life cycle ------------------------------------------------------------

  reveal(now: number): void {
    const plan = this.plan!;
    this.plan = null;
    this.planState = 'none';
    this.setup(plan);
    const reduced = this.host.reduced;
    const first = !this.revealed;
    this.revealed = true;
    this.phase = 'revealing';
    this.phaseT = now;
    this.gazeOn = false;
    this.gather = first ? (reduced ? 2600 : 2100) : reduced ? 1900 : 1350;
    this.slitIn = reduced ? 1000 : 560;
    this.slitHold = first ? 650 + this.host.rand() * 450 : 280 + this.host.rand() * 260;
    this.openMs = reduced ? 1900 : first ? 1250 : 950;
    this.blinkAt = this.squintAt = -1e9;
    this.sx = this.sy = this.svx = this.svy = this.stx = this.sty = 0;
    this.jumpAt = -1;
    for (const e of this.eyes) {
      e.ox = e.oy = e.vx = e.vy = 0;
      e.dil = 0.62;
      e.up = 0;
    }
    this.lastDraw = this.lastPoolDraw = -Infinity;
    this.poolStyle = '';
    this.poolOpacity = -1;
    this.el.style.display = 'block';
  }

  /** Shut and fade. Counted retreats are the reader chasing them off. */
  retreat(counted: boolean): void {
    if (this.phase !== 'revealing' && this.phase !== 'watching') return;
    // Only eyes you actually saw open can be chased off; before that they just move.
    if (Math.max(this.eyes[0].up, this.eyes[1].up) <= SLIT + 0.02) counted = false;
    const reduced = this.host.reduced;
    this.beginClose('retreat');
    this.closeMs = reduced ? 850 : 85;
    this.dissolveDelay = reduced ? 300 : 30;
    this.dissolveMs = reduced ? 1500 : 750;
    this.reopenDelay = counted ? 3000 + this.host.rand() * 2200 : 1800 + this.host.rand() * 1400;
    this.host.onRetreat(this, counted);
  }

  /** Close for good: quickly for a stop, slowly with a last long look when their time is up. */
  close(kind: 'stop' | 'final'): void {
    this.final = true;
    if (this.phase === 'waiting') {
      this.hide();
      this.phase = 'done';
      return;
    }
    if (this.phase === 'done' || (this.phase === 'closing' && this.closeKind === 'stop')) return;
    if (this.phase === 'retreating' && kind === 'final') return;
    this.beginClose(kind);
    if (kind === 'stop') {
      this.closeMs = 420;
      this.dissolveDelay = 100;
      this.dissolveMs = 1000;
    } else {
      this.closeMs = 2500;
      this.dissolveDelay = 1500;
      this.dissolveMs = 1800;
    }
  }

  private beginClose(kind: CloseKind): void {
    const droop = Math.max(0.5, Math.min(this.eyes[0].droop, this.eyes[1].droop));
    this.env0 = Math.min(1.05, Math.max(0, Math.max(this.eyes[0].up, this.eyes[1].up) / droop));
    this.pool0 = this.pool;
    this.startle = this.env0 > 0.35 ? 1.1 : this.env0;
    this.closeKind = kind;
    this.phase = kind === 'retreat' ? 'retreating' : 'closing';
    this.phaseT = this.host.clock;
    this.blinkAt = this.squintAt = -1e9;
  }

  private hide(): void {
    this.el.style.display = 'none';
  }

  remove(): void {
    this.el.remove();
  }

  /** The cursor just came back: a flicker of interest, the lids lift. */
  noticed(now: number): void {
    if (this.phase === 'watching' && now - this.widenAt > 1600) {
      this.widenAt = now;
      this.widenRise = this.host.reduced ? 600 : 220;
    }
  }

  /** The page or the element under the eyes scrolled: stay on the same spot of the page. */
  follow(): void {
    if (!this.visible) return;
    let dx = scrollX - this.sx0;
    let dy = scrollY - this.sy0;
    if (this.anchor) {
      dx += this.anchor.scrollLeft - this.ax0;
      dy += this.anchor.scrollTop - this.ay0;
    }
    this.x = this.baseX - dx;
    this.y = this.baseY - dy;
    this.position();
    const hx = EYE_BOX.x * this.w;
    const hy = EYE_BOX.y * this.w + EYE_BOX.pad;
    const { vw, vh } = viewportSize();
    if (this.x - hx < 0 || this.x + hx > vw || this.y - hy < 0 || this.y + hy > vh) {
      this.retreat(false);
      return;
    }
    // Never peek out from behind a sticky header or a floating bar.
    for (const r of this.pinned) {
      if (this.x + hx > r.l && this.x - hx < r.r && this.y + hy > r.t && this.y - hy < r.b) {
        this.retreat(false);
        return;
      }
    }
  }

  private position(): void {
    this.el.style.transform = `translate3d(${this.x.toFixed(1)}px,${this.y.toFixed(1)}px,0) rotate(${this.tilt.toFixed(4)}rad)`;
  }

  /** Size the canvases and paint this placement's sprites. */
  private setup(plan: Plan): void {
    const host = this.host;
    const dpr = host.dpr;
    const rand = host.rand;
    const { x, y, w } = plan.spot;
    this.x = this.baseX = x;
    this.y = this.baseY = y;
    this.w = w;
    this.sx0 = plan.sx;
    this.sy0 = plan.sy;
    this.anchor = plan.anchor;
    this.ax0 = plan.ax;
    this.ay0 = plan.ay;
    this.pinned = plan.pinned;
    this.tilt = (rand() - 0.5) * 0.12;
    this.cos = Math.cos(this.tilt);
    this.sin = Math.sin(this.tilt);
    // A light page needs a deep core to read and only a whisper of dimming around it;
    // a dark page takes a broader, softer shadow.
    this.coreA = (plan.dark ? 0.9 : 0.96) * (this.main ? 1 : 0.9);
    this.tailA = plan.dark ? 0.32 : 0.075;

    this.ew = Math.ceil(EYES_W * w);
    this.eh = Math.ceil(EYES_H * w);
    this.eyeC.width = Math.round(this.ew * dpr);
    this.eyeC.height = Math.round(this.eh * dpr);
    this.eyeC.style.width = `${this.ew}px`;
    this.eyeC.style.height = `${this.eh}px`;
    this.eyeC.style.transform = `translate(${-this.ew / 2}px,${-this.eh / 2}px)`;
    this.pw = Math.ceil(POOL_W * w);
    this.ph = Math.ceil(POOL_H * w);
    this.poolC.width = Math.max(1, Math.round(this.pw * POOL_RES));
    this.poolC.height = Math.max(1, Math.round(this.ph * POOL_RES));
    this.poolC.style.width = `${this.pw}px`;
    this.poolC.style.height = `${this.ph}px`;
    this.poolC.style.left = `${-this.pw / 2}px`;
    this.poolC.style.top = `${-this.ph / 2 + POOL_DY * w}px`;
    this.position();

    if (this.spriteDpr !== dpr) {
      this.spriteDpr = dpr;
      this.pupil = paintPupil(dpr);
      this.highlight = paintDab(32 * dpr, [255, 252, 244], [
        [0, 1],
        [0.18, 0.92],
        [0.38, 0.4],
        [0.66, 0.08],
        [1, 0],
      ]);
      this.glow = paintDab(64 * dpr, host.palette.glow, [
        [0, 0.6],
        [0.25, 0.26],
        [0.55, 0.07],
        [1, 0],
      ]);
      this.socket = paintDab(64 * dpr, [44, 32, 30], [
        [0, 0.55],
        [0.4, 0.3],
        [0.7, 0.08],
        [1, 0],
      ]);
    }
    const look = seeded(host.seed * 7 + 13);
    for (let i = 0; i < 2; i++) {
      const e = this.eyes[i];
      e.lx = e.side * 1.0 * w;
      e.ly = (i === 0 ? 1 : -1) * (look() - 0.5) * 0.04 * w;
      e.sclera = paintSclera(w, dpr * e.size, seeded(host.seed + 101 * (i + 1)), host.stage);
      e.iris = paintIris(IRIS_R * w, dpr * e.size, host.palette, seeded(host.seed + 977 * (i + 1)), host.stage);
      for (let k = 0; k < LASHES; k++) {
        e.lashes[k * 3] = 0.1 + (k / (LASHES - 1)) * 0.86 + (look() - 0.5) * 0.03;
        e.lashes[k * 3 + 1] = 0.45 + look() * 0.8;
        e.lashes[k * 3 + 2] = (look() - 0.5) * 0.5;
      }
    }

    // A few slow wisps inside the core keep the darkness alive.
    this.wisps = [0, 1, 2].map((i) => ({
      x: (i - 1) * 0.75 * w + (rand() - 0.5) * 0.3 * w,
      y: (0.1 + rand() * 0.3) * w,
      rx: (1.0 + rand() * 0.4) * w,
      ry: (0.5 + rand() * 0.2) * w,
      a: 0.3 + rand() * 0.15,
      fx: 1 / (2600 + rand() * 2600),
      fy: 1 / (3000 + rand() * 2800),
      ph: rand() * 10,
      drift: (0.06 + rand() * 0.08) * w,
    }));
  }

  // --- simulation --------------------------------------------------------------

  update(now: number, dt: number): void {
    if (!this.visible) return;
    const host = this.host;
    const reduced = host.reduced;
    const rand = host.rand;
    const t = now - this.phaseT;
    let env = REST;
    let pool = 1;

    if (this.phase === 'revealing') {
      pool = easeInOut(clamp01(t / this.gather));
      const t0 = this.gather * 0.62;
      const t1 = t0 + this.slitIn;
      const t2 = t1 + this.slitHold;
      const t3 = t2 + this.openMs;
      // A line of light, a slit that finds you, then wide: it has seen you.
      env = t < t0 ? 0 : t < t1 ? SLIT * easeOutCubic((t - t0) / this.slitIn) : t < t2 ? SLIT : t < t3 ? SLIT + (1 - SLIT) * easeInOut((t - t2) / this.openMs) : 1;
      if (t >= t1 + this.slitHold * 0.45) this.gazeOn = true;
      if (t >= t3 && t >= this.gather) {
        this.phase = 'watching';
        this.phaseT = now;
        this.widenAt = now;
        this.widenRise = 0;
        if (this.watchStart < 0) this.watchStart = now;
        this.nextBlink = now + 1600 + rand() * 1600;
        this.nextSacc = now + 400 + rand() * 900;
        host.onWatching(this);
      }
    } else if (this.phase === 'watching') {
      env = this.widen(now - this.widenAt);
    } else {
      env = this.closeProfile(t);
      pool = this.pool0 * (1 - easeInOut(clamp01((t - this.dissolveDelay) / this.dissolveMs)));
      if (t >= this.dissolveDelay + this.dissolveMs && t >= this.closeMs) {
        this.hide();
        if (this.final || this.phase === 'closing') {
          this.phase = 'done';
        } else {
          this.phase = 'waiting';
          this.wakeAt = now + this.reopenDelay;
          this.planState = 'none';
        }
        return;
      }
    }
    this.pool = pool;

    // Blinks, double blinks, slow knowing blinks and the occasional squint.
    if (this.phase === 'watching' && now >= this.nextBlink) {
      const r = rand();
      if (r < 0.13 && !reduced) this.startBlink(now, 'double');
      else if (r < 0.25 && now - this.squintAt > 4000) {
        this.squintAt = now;
        this.squintDur = 900 + rand() * 1200;
      } else if (r < 0.35) this.startBlink(now, 'slow');
      else this.startBlink(now, 'single');
      this.nextBlink = now + (reduced ? 3800 : 2300) + rand() * (reduced ? 4200 : 4300) + (rand() < 0.15 ? 2800 : 0);
    }
    const squint = this.squintAmount(now - this.squintAt);

    const p = host.pointer;
    const w = this.w;
    const live = this.phase === 'revealing' || this.phase === 'watching';
    // Micro-saccades and the odd glance elsewhere.
    if (!reduced && live && this.gazeOn && now >= this.nextSacc) {
      this.nextSacc = now + 600 + rand() * 2200;
      if (p.known && rand() < 0.12) {
        const a = rand() * Math.PI * 2;
        this.glanceUntil = now + 380 + rand() * 650;
        this.stx = Math.cos(a) * MAX_X * w * 0.8 - this.eyes[0].ox;
        this.sty = Math.sin(a) * MAX_UP * w * 0.7 - this.eyes[0].oy;
      } else {
        this.stx = (rand() - 0.5) * 0.04 * w;
        this.sty = (rand() - 0.5) * 0.025 * w;
      }
    }
    if (this.glanceUntil && now >= this.glanceUntil) {
      this.glanceUntil = 0;
      this.stx = this.sty = 0;
    }
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    if (!reduced) {
      const k = 1300;
      const c = 2 * Math.sqrt(k) * 0.82;
      for (let s = 0; s < steps; s++) {
        this.svx += (k * (this.stx - this.sx) - c * this.svx) * h;
        this.svy += (k * (this.sty - this.sy) - c * this.svy) * h;
        this.sx += this.svx * h;
        this.sy += this.svy * h;
      }
    }

    // Where each eye wants to look: the cursor, or straight out at you.
    for (const e of this.eyes) {
      if (this.gazeOn && p.known) {
        const ex = this.x + this.cos * e.lx - this.sin * e.ly;
        const ey = this.y + this.sin * e.lx + this.cos * e.ly;
        const dx = p.x - ex;
        const dy = p.y - ey;
        const lx = this.cos * dx + this.sin * dy;
        const ly = -this.sin * dx + this.cos * dy;
        const dist = Math.hypot(lx, ly) || 1;
        const f = dist / (dist + 170);
        e.tx = (lx / dist) * f * MAX_X * w * 1.15;
        e.ty = (ly / dist) * f * (ly < 0 ? MAX_UP : MAX_DOWN) * w * 1.5;
      } else {
        const sp = reduced ? 0.00012 : 0.00028;
        e.tx = Math.sin(now * sp + this.wander) * 0.03 * w;
        e.ty = 0.01 * w + Math.sin(now * sp * 0.7 + this.wander * 2) * 0.012 * w;
      }
    }
    // Big gaze changes are ballistic jumps, like real eyes; small ones are smooth pursuit.
    const e0 = this.eyes[0];
    if (!reduced && this.gazeOn && p.known && this.jumpAt < 0 && now - this.lastJump > 180) {
      const err = Math.hypot(e0.tx - e0.ox, e0.ty - e0.oy);
      if (err > 0.055 * w) {
        this.jumpAt = now;
        this.jumpDur = 40 + 22 * Math.min(1, err / (MAX_X * w));
        for (const e of this.eyes) {
          e.jfx = e.ox;
          e.jfy = e.oy;
          e.jtx = e.tx;
          e.jty = e.ty;
        }
      }
    }
    let jumpU = -1;
    if (this.jumpAt >= 0) {
      jumpU = (now - this.jumpAt) / this.jumpDur;
      if (jumpU >= 1) {
        this.jumpAt = -1;
        this.lastJump = now;
      }
    }
    const pursuitK = reduced ? 22 : p.known ? 70 : 30;
    const pursuitZeta = reduced ? 1.05 : 0.9;

    const dxp = p.x - this.x;
    const dyp = p.y - this.y;
    const pairDist = p.known ? Math.hypot(Math.max(0, Math.abs(dxp) - 1.6 * w), Math.max(0, Math.abs(dyp) - 0.35 * w)) : Infinity;
    const watched = this.watchStart < 0 ? 0 : now - this.watchStart;
    let calm =
      this.phase === 'watching' && squint === 0 && now - this.blinkAt > 1400 && now - this.widenAt > 1500 && this.jumpAt < 0 && performance.now() - p.at > 250;

    for (const e of this.eyes) {
      if (jumpU >= 0) {
        const u = easeInOut(Math.min(1, jumpU));
        e.ox = lerp(e.jfx, e.jtx, u);
        e.oy = lerp(e.jfy, e.jty, u);
        e.vx = e.vy = 0;
      } else {
        const k = pursuitK * e.stiff;
        const c = 2 * Math.sqrt(k) * pursuitZeta;
        for (let s = 0; s < steps; s++) {
          e.vx += (k * (e.tx - e.ox) - c * e.vx) * h;
          e.vy += (k * (e.ty - e.oy) - c * e.vy) * h;
          e.ox += e.vx * h;
          e.oy += e.vy * h;
        }
      }
      // Keep the iris inside the eye.
      let ix = e.ox + this.sx;
      let iy = e.oy + this.sy;
      const nx = ix / (MAX_X * w * 1.12);
      const ny = iy / ((iy < 0 ? MAX_UP : MAX_DOWN) * w * 1.25);
      const m = nx * nx + ny * ny;
      if (m > 1) {
        const q = 1 / Math.sqrt(m);
        ix *= q;
        iy *= q;
      }
      e.ix = ix;
      e.iy = iy;

      // Lids.
      const b = this.blinkFactor(now - this.blinkAt - e.lag);
      let up = env * b * (1 - 0.36 * squint) * e.droop;
      // Startle: they fly wide for an instant before they shut.
      if (this.phase === 'retreating' && !reduced && t < 45) up = lerp(this.env0, this.startle, t / 45) * e.droop;
      e.up = up;
      e.lo = clamp01(lerp(0.68, 1, Math.min(1, (env / REST) * b)) - 0.46 * squint);

      // Pupils: wide in the dark, wider the longer they watch, tight when you come close.
      let target = this.phase === 'revealing' ? 0.62 : 0.46 + 0.1 * smooth(clamp01(watched / 26000)) + (host.stage >= 4 ? 0.03 : 0);
      if (pairDist < 560) target *= 1 - 0.44 * smooth(clamp01((560 - pairDist) / 360));
      target += 0.014 * Math.sin(now * 0.0037 + e.ph) + 0.008 * Math.sin(now * 0.0011 + e.ph * 2);
      const tau = (target < e.dil ? 0.28 : 0.9) * (reduced ? 1.6 : 1);
      e.dil += (target - e.dil) * (1 - Math.exp(-dt / tau));

      if (Math.abs(e.vx) + Math.abs(e.vy) > 0.02 * w) calm = false;
    }
    if (Math.abs(this.svx) + Math.abs(this.svy) > 0.02 * w) calm = false;
    this.calm = calm;
    this.urgent =
      this.phase === 'retreating' ||
      this.jumpAt >= 0 ||
      now - this.blinkAt < 260 ||
      performance.now() - p.at < 300 ||
      Math.abs(this.svx) + Math.abs(this.svy) > 0.3 * w;

    // Come for them and they are gone.
    if (live && p.known) {
      if (pairDist < NEAR) this.retreat(true);
      else if (performance.now() - p.at < 140 && pairDist < LUNGE_RANGE) {
        const d = Math.hypot(dxp, dyp) || 1;
        const towards = -(p.vx * dxp + p.vy * dyp) / d;
        if (towards > LUNGE) this.retreat(true);
      }
    }
  }

  /** Openness while watching: wide when they have just found you, then heavy-lidded rest. */
  private widen(t: number): number {
    const rise = this.widenRise;
    if (t < rise) return lerp(REST, 1, easeOutCubic(t / rise));
    if (t < rise + 450) return 1;
    if (t < rise + 1400) return lerp(1, REST, easeInOut((t - rise - 450) / 950));
    return REST;
  }

  private startBlink(now: number, kind: BlinkKind): void {
    this.blinkAt = now;
    this.blinkKind = kind;
  }

  /** 1 open … 0 shut. Fast close, short hold, slower open. */
  private blinkFactor(t: number): number {
    if (t < 0 || t > 2600) return 1;
    let C = 78;
    let H = 40;
    let O = 215;
    if (this.host.reduced) {
      C = 320;
      H = 160;
      O = 620;
    } else if (this.blinkKind === 'slow') {
      C = 330;
      H = 280;
      O = 640;
    }
    const count = this.blinkKind === 'double' ? 2 : 1;
    const per = C + H + O;
    let f = 1;
    for (let k = 0; k < count; k++) {
      const lt = t - k * (per + 110);
      if (lt < 0) break;
      if (lt < C) f = Math.min(f, 1 - easeInQuad(lt / C));
      else if (lt < C + H) f = 0;
      else if (lt < per) f = Math.min(f, easeOutCubic((lt - C - H) / O));
    }
    return f;
  }

  private squintAmount(t: number): number {
    const tin = this.host.reduced ? 900 : 420;
    const tout = this.host.reduced ? 1000 : 560;
    if (t < 0 || t > tin + this.squintDur + tout) return 0;
    if (t < tin) return easeInOut(t / tin);
    if (t < tin + this.squintDur) return 1;
    return 1 - easeInOut((t - tin - this.squintDur) / tout);
  }

  private closeProfile(t: number): number {
    const e0 = this.env0;
    if (this.closeKind === 'retreat') {
      if (this.host.reduced) return e0 * (1 - easeInOut(clamp01(t / this.closeMs)));
      if (t < 45) return e0;
      return this.startle * (1 - easeInQuad(clamp01((t - 45) / this.closeMs)));
    }
    if (this.closeKind === 'stop') return e0 * (1 - easeInOut(clamp01(t / this.closeMs)));
    // Final: narrow to a last long look, hold it, then close slowly.
    const look = Math.min(e0, 0.42);
    if (t < 550) return lerp(e0, look, easeInOut(t / 550));
    if (t < 1350) return look;
    return look * (1 - easeInOut(clamp01((t - 1350) / 1150)));
  }

  // --- drawing -----------------------------------------------------------------

  draw(now: number): void {
    if (!this.visible) return;
    this.drawPool(now);
    // Calm eyes only need the odd frame for the pupils' slow unrest.
    if (this.calm && now - this.lastDraw < 95) return;
    this.lastDraw = now;
    const g = this.eyeG;
    const dpr = this.host.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, this.eyeC.width, this.eyeC.height);
    const A = this.alpha * smooth(clamp01((this.pool - 0.5) / 0.42));
    if (A <= 0.003) return;
    g.setTransform(dpr, 0, 0, dpr, (dpr * this.ew) / 2, (dpr * this.eh) / 2);
    for (const e of this.eyes) this.drawEye(e, A);
    // A faint warm eyeshine spilling into the dark around each eye. The far pair is mostly this.
    g.globalCompositeOperation = 'lighter';
    const w = this.w;
    const boost = this.main ? 1 : 1.7;
    for (const e of this.eyes) {
      const open = clamp01(e.up / 0.6);
      if (open <= 0.01 || !this.glow) continue;
      g.globalAlpha = Math.min(1, A * 0.2 * open * boost);
      g.drawImage(this.glow, e.lx + e.ix * 0.5 - 0.95 * w, e.ly - 0.52 * w, 1.9 * w, 1.04 * w);
    }
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
  }

  /**
   * The darkness: its shape is redrawn rarely (it only drifts); growing,
   * sinking and fading are compositor transforms and opacity on its canvas.
   */
  private drawPool(now: number): void {
    const p = this.pool;
    const dissolving = this.phase === 'retreating' || this.phase === 'closing';
    let s: number;
    let oy = 0;
    let op: number;
    if (dissolving) {
      // It contracts and sinks away rather than spreading into grey.
      s = 0.35 + 0.65 * p;
      oy = (1 - p) * 0.3 * this.w;
      op = smooth(Math.min(1, p * 1.8));
    } else {
      // It seeps out from where the eyes will be.
      s = 0.15 + 0.85 * easeOutCubic(p);
      op = smooth(Math.min(1, p * 3));
    }
    const settled = this.phase === 'watching';
    // Slow breathing; while settled it only moves with the (rare) redraws below.
    if (settled && now - this.lastPoolDraw < 160) return;
    s *= 1 + 0.025 * Math.sin(now / 2100 + this.wander);
    const style = `translate(0px,${oy.toFixed(1)}px) scale(${s.toFixed(3)})`;
    if (style !== this.poolStyle) {
      this.poolStyle = style;
      this.poolC.style.transform = style;
    }
    if (Math.abs(op - this.poolOpacity) > 0.004) {
      this.poolOpacity = op;
      this.poolC.style.opacity = op.toFixed(3);
    }
    if (now - this.lastPoolDraw < (this.host.reduced ? 400 : 160)) return;
    this.lastPoolDraw = now;
    const g = this.poolG;
    const w = this.w;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.poolC.width, this.poolC.height);
    g.setTransform(POOL_RES, 0, 0, POOL_RES, (POOL_RES * this.pw) / 2, (POOL_RES * this.ph) / 2);
    g.globalAlpha = this.tailA;
    g.drawImage(this.tail, -3.05 * w, -1.85 * w, 6.1 * w, 3.7 * w);
    g.globalAlpha = this.coreA;
    g.drawImage(this.core, -2.75 * w, -1.1 * w, 5.5 * w, 2.2 * w);
    const calm = this.host.reduced ? 0.4 : 1;
    for (const k of this.wisps) {
      const bx = k.x + Math.sin(now * k.fx + k.ph) * k.drift * calm;
      const by = k.y + Math.cos(now * k.fy + k.ph) * k.drift * 0.5 * calm;
      g.globalAlpha = this.coreA * k.a;
      g.drawImage(this.core, bx - k.rx, by - k.ry, k.rx * 2, k.ry * 2);
    }
    g.globalAlpha = 1;
  }

  private drawEye(e: Eye, A: number): void {
    const g = this.eyeG;
    const w = this.w;
    const m = e.side;
    const lowerY = lerp(MEET, LOWER_OPEN, e.lo) * w;
    const upperY = Math.min(lerp(MEET, UPPER_OPEN, e.up) * w, lowerY);
    const p0x = P0X * w;
    const p0y = P0Y * w;
    const p3x = P3X * w;
    const p3y = P3Y * w;
    const c1x = C1X * w;
    const c2x = C2X * w;
    const R = IRIS_R * w;
    const hair = 0.7 / this.host.dpr;
    // Everything around the eye is only seen by its own light: shut, it is just darkness.
    const lit = smooth(clamp01(e.up / SLIT));
    const L = A * lit;

    g.save();
    g.translate(e.lx, e.ly);
    g.scale(m * e.size, e.size);

    if (this.socket && L > 0.01) {
      g.globalAlpha = L * 0.4;
      g.drawImage(this.socket, -0.9 * w, -0.62 * w, 1.8 * w, 1.2 * w);
    }

    const openH = lowerY - upperY;
    if (openH > 0.004 * w) {
      g.save();
      g.beginPath();
      g.moveTo(p0x, p0y);
      g.bezierCurveTo(c1x, upperY, c2x, upperY, p3x, p3y);
      g.bezierCurveTo(c2x, lowerY, c1x, lowerY, p0x, p0y);
      g.closePath();
      g.clip();

      g.globalAlpha = A * (this.main ? 1 : 0.5);
      if (e.sclera) g.drawImage(e.sclera, SCLERA_BOX.x * w, SCLERA_BOX.y * w, SCLERA_BOX.w * w, SCLERA_BOX.h * w);
      g.globalAlpha = A;

      // Iris and pupil, foreshortened as the eyeball turns.
      const ix = e.ix * m;
      const iy = e.iy;
      const fx = 1 - 0.2 * Math.min(1, (e.ix / (MAX_X * w)) ** 2);
      const fy = 1 - 0.12 * Math.min(1, (iy / (MAX_UP * w)) ** 2);
      g.save();
      g.translate(ix, iy);
      g.scale(fx, fy);
      const ir = R + 2;
      if (e.iris) g.drawImage(e.iris, -ir, -ir, ir * 2, ir * 2);
      const pr = (R * e.dil) / 0.8;
      if (this.pupil) g.drawImage(this.pupil, -pr, -pr, pr * 2, pr * 2);
      g.restore();
      // Eyeshine scattering into the white around the iris.
      if (this.glow) {
        g.globalCompositeOperation = 'lighter';
        g.globalAlpha = A * (this.main ? 0.3 : 0.5);
        g.drawImage(this.glow, ix - R * 1.6, iy - R * 1.6, R * 3.2, R * 3.2);
        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = A;
      }

      // Shadow of the upper lid on the eyeball, and a little under the lower lid.
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(p0x, p0y);
      g.bezierCurveTo(c1x, upperY, c2x, upperY, p3x, p3y);
      g.strokeStyle = 'rgba(0,0,0,0.26)';
      g.lineWidth = 0.24 * w;
      g.stroke();
      g.strokeStyle = 'rgba(0,0,0,0.3)';
      g.lineWidth = 0.13 * w;
      g.stroke();
      g.strokeStyle = 'rgba(0,0,0,0.42)';
      g.lineWidth = 0.055 * w;
      g.stroke();
      g.beginPath();
      g.moveTo(p0x, p0y);
      g.bezierCurveTo(c1x, lowerY, c2x, lowerY, p3x, p3y);
      g.strokeStyle = 'rgba(0,0,0,0.3)';
      g.lineWidth = 0.075 * w;
      g.stroke();

      // Wet: a glint of tear along the lower lid and the corneal highlight.
      g.translate(0, -0.02 * w);
      g.strokeStyle = 'rgba(255,238,222,0.2)';
      g.lineWidth = Math.max(hair, 0.012 * w);
      g.stroke();
      g.translate(0, 0.02 * w);
      if (this.highlight) {
        g.globalAlpha = A * 0.95;
        const hs = 0.3 * R;
        const hx = ix * 0.55 - m * 0.36 * R;
        const hy = iy * 0.55 - 0.4 * R;
        g.drawImage(this.highlight, hx - hs, hy - hs * 0.8, hs * 2, hs * 1.6);
        g.globalAlpha = A * 0.4;
        const hs2 = 0.11 * R;
        g.drawImage(this.highlight, ix * 0.55 + m * 0.34 * R - hs2, iy * 0.55 + 0.3 * R - hs2, hs2 * 2, hs2 * 2);
      }
      g.restore();
    }

    if (L > 0.01) {
      // No lid skin is drawn: in this dark only the rim catches the eyeshine.
      g.globalAlpha = L;
      g.beginPath();
      g.moveTo(p0x, p0y);
      g.bezierCurveTo(c1x, upperY, c2x, upperY, p3x, p3y);
      g.translate(0, -0.03 * w);
      g.strokeStyle = 'rgba(70,46,36,0.3)';
      g.lineWidth = 0.03 * w;
      g.stroke();
      g.translate(0, 0.03 * w);

      // Crease above the lid, deeper when the eye is wide.
      const creaseY = lerp(-0.3, -0.41, clamp01(e.up)) * w;
      g.beginPath();
      g.moveTo(-0.44 * w, -0.02 * w);
      g.bezierCurveTo(-0.2 * w, creaseY, 0.24 * w, creaseY, 0.5 * w, -0.08 * w);
      g.globalAlpha = A * 0.3 * smooth(clamp01((e.up - 0.25) / 0.45));
      g.strokeStyle = 'rgba(0,0,0,0.5)';
      g.lineWidth = 0.032 * w;
      g.stroke();

      // Lid margins.
      g.globalAlpha = L;
      g.beginPath();
      g.moveTo(p0x, p0y);
      g.bezierCurveTo(c1x, upperY, c2x, upperY, p3x, p3y);
      g.strokeStyle = 'rgba(6,4,4,0.7)';
      g.lineWidth = 0.032 * w;
      g.stroke();
      g.beginPath();
      g.moveTo(p0x, p0y);
      g.bezierCurveTo(c1x, lowerY, c2x, lowerY, p3x, p3y);
      g.strokeStyle = 'rgba(20,12,11,0.5)';
      g.lineWidth = 0.018 * w;
      g.stroke();

      // Lashes: up and out when open, down and out as the lid falls. Faint: they only catch the eyeshine.
      const fall = 1 - clamp01(e.up);
      g.beginPath();
      for (let k = 0; k < LASHES; k++) {
        const t = e.lashes[k * 3];
        const u = 1 - t;
        const bx = u * u * u * p0x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * p3x;
        const by = u * u * u * p0y + 3 * u * u * t * upperY + 3 * u * t * t * upperY + t * t * t * p3y;
        const dx = 3 * u * u * (c1x - p0x) + 6 * u * t * (c2x - c1x) + 3 * t * t * (p3x - c2x);
        const dy = 3 * u * u * (upperY - p0y) + 3 * t * t * (p3y - upperY);
        const ang = Math.atan2(-dx, dy) + 0.3 + 0.35 * t + e.lashes[k * 3 + 2] + fall * 1.15;
        const len = w * (0.045 + 0.07 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 0.8) + 0.03 * t) * e.lashes[k * 3 + 1];
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        const ang2 = ang - 0.55;
        g.moveTo(bx, by);
        g.quadraticCurveTo(bx + ca * len * 0.55, by + sa * len * 0.55, bx + Math.cos(ang2) * len, by + Math.sin(ang2) * len);
      }
      g.globalAlpha = A * 0.45 * smooth(clamp01((e.up - 0.12) / 0.4));
      g.strokeStyle = 'rgb(6,4,4)';
      g.lineWidth = Math.max(hair, 0.011 * w);
      g.stroke();
      g.beginPath();
      for (let k = 0; k < LOWER_LASHES; k++) {
        const t = 0.3 + (k / (LOWER_LASHES - 1)) * 0.62;
        const u = 1 - t;
        const bx = u * u * u * p0x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * p3x;
        const by = u * u * u * p0y + 3 * u * u * t * lowerY + 3 * u * t * t * lowerY + t * t * t * p3y;
        const len = w * (0.022 + 0.018 * t);
        const ang = Math.PI / 2 - 0.5 - 0.4 * t;
        g.moveTo(bx, by);
        g.lineTo(bx + Math.cos(ang) * len, by + Math.sin(ang) * len);
      }
      g.globalAlpha = L * 0.3;
      g.lineWidth = Math.max(hair, 0.01 * w);
      g.stroke();
    }
    g.restore();
  }
}

interface Job {
  w: Watcher;
  scan: Scan;
  search: Search | null;
  cands: Spot[] | null;
  k: number;
  verifying: boolean;
}

/** Something is watching. */
export class Eyes implements Effect, Host {
  readonly name = 'eyes' as const;
  readonly pointer: Pointer = { x: 0, y: 0, vx: 0, vy: 0, known: false, at: 0 };
  reduced = false;
  stage = 3;
  dpr = 1;
  seed = 0;
  palette: Palette = PALETTES[0];
  clock = 0;
  rand: () => number = Math.random;

  private overlay: Overlay | null = null;
  private watchers: Watcher[] = [];
  private lastReal = 0;
  private lastFrame = 0;
  private paused = false;
  private raf = 0;
  private wakeTimer: number | undefined;
  private calmTimer: number | undefined;
  private stopTimer: number | undefined;
  private idleId = 0;
  private job: Job | null = null;
  private scan: Scan | null = null;
  private stopping = false;
  private ending = false;
  private retreats = 0;
  private history: { x: number; y: number }[] = [];

  get active(): boolean {
    return !!this.overlay;
  }

  get layer(): HTMLElement {
    return this.overlay!.layer;
  }

  start(ctx: EffectContext): void {
    if (this.overlay && !this.stopping) {
      // Already watching. A deeper stage brings the second pair.
      if (ctx.stage >= 4 && this.stage < 4 && !this.ending) {
        this.stage = ctx.stage;
        this.addSecondary();
        this.schedule();
      }
      return;
    }
    if (this.overlay) this.destroy();
    this.reduced = ctx.reduced;
    this.stage = ctx.stage;
    this.seed = ctx.seed >>> 0;
    this.rand = seeded(this.seed ^ 0x9e3779b9);
    this.palette = PALETTES[this.seed % PALETTES.length];
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.clock = 0;
    this.lastReal = performance.now();
    this.paused = document.visibilityState === 'hidden';
    this.stopping = this.ending = false;
    this.retreats = 0;
    this.history = [];
    this.scan = null;
    this.overlay = createOverlay(this.name, CSS);

    const first = new Watcher(this, true, 1, 1);
    first.wakeAt = 1300 + this.rand() * 700;
    this.watchers = [first];
    if (this.stage >= 4) this.addSecondary();

    addEventListener('pointermove', this.onPointer, { capture: true, passive: true });
    document.addEventListener('pointerout', this.onPointerOut, { capture: true, passive: true });
    addEventListener('resize', this.onResize, { passive: true });
    document.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
    document.addEventListener('visibilitychange', this.onVisibility);
    this.schedule();
  }

  stop(): void {
    if (!this.overlay) return;
    // Hidden pages get no animation frames: just go.
    if (this.paused || document.visibilityState === 'hidden') {
      this.destroy();
      return;
    }
    this.stopping = true;
    this.cancelJob();
    for (const w of this.watchers) w.close('stop');
    clearTimeout(this.stopTimer);
    this.stopTimer = window.setTimeout(() => this.destroy(), 1500);
    this.schedule();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    clearTimeout(this.wakeTimer);
    clearTimeout(this.calmTimer);
    clearTimeout(this.stopTimer);
    this.wakeTimer = this.calmTimer = this.stopTimer = undefined;
    this.cancelJob();
    removeEventListener('pointermove', this.onPointer, { capture: true });
    document.removeEventListener('pointerout', this.onPointerOut, { capture: true });
    removeEventListener('resize', this.onResize);
    document.removeEventListener('scroll', this.onScroll, { capture: true });
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const w of this.watchers) w.remove();
    this.watchers = [];
    this.scan = null;
    this.overlay?.remove();
    this.overlay = null;
    this.stopping = false;
  }

  // --- Host ----------------------------------------------------------------------

  onWatching(w: Watcher): void {
    if (!w.main) return;
    for (const o of this.watchers) {
      if (o !== w && o.phase === 'waiting' && o.wakeAt === Infinity) o.wakeAt = this.clock + 4500 + this.rand() * 3500;
    }
  }

  onRetreat(w: Watcher, counted: boolean): void {
    this.history.push({ x: w.x, y: w.y });
    if (!counted || !w.main) return;
    this.retreats++;
    if (this.retreats >= MAX_RETREATS) {
      // Chased off for the last time: they do not come back.
      w.final = true;
      this.ending = true;
      for (const o of this.watchers) if (o !== w) o.close('final');
    }
  }

  // --- finding a spot, in idle time ---------------------------------------------

  private placeOptions(w: Watcher, scan: Scan): PlaceOptions {
    const p = this.pointer;
    const baseW = Math.min(58, Math.max(30, Math.min(scan.vw, scan.vh * 1.6) * 0.036)) * w.scale;
    const avoid = this.history.slice(-3).map((h) => ({ x: h.x, y: h.y, r: 280 }));
    let far: { x: number; y: number } | undefined;
    for (const o of this.watchers) {
      if (o === w || !o.visible) continue;
      avoid.push({ x: o.x, y: o.y, r: 460 });
      far = { x: o.x, y: o.y };
    }
    return {
      baseW,
      cursorX: p.known ? p.x : scan.vw / 2,
      cursorY: p.known ? p.y : scan.vh / 2,
      cursorR: p.known ? 420 : 260,
      cursorWeight: p.known ? 1.6 : 0.7,
      avoid,
      far: w.main ? undefined : far,
      rand: this.rand,
    };
  }

  private startPlan(w: Watcher): void {
    if (this.job || this.paused || this.stopping) return;
    w.planState = 'pending';
    const scan = this.scan && this.scan.fresh(15_000) ? this.scan : new Scan();
    this.scan = scan;
    this.job = { w, scan, search: null, cands: null, k: 0, verifying: false };
    this.requestIdle();
  }

  private requestIdle(): void {
    if (typeof requestIdleCallback === 'function') this.idleId = requestIdleCallback(this.pump, { timeout: 250 });
    else this.idleId = window.setTimeout(this.pump, 16);
  }

  private cancelJob(): void {
    if (this.idleId) {
      if (typeof cancelIdleCallback === 'function') cancelIdleCallback(this.idleId);
      clearTimeout(this.idleId);
    }
    this.idleId = 0;
    if (this.job && this.job.w.planState === 'pending') this.job.w.planState = 'none';
    this.job = null;
  }

  /** A slice of the search: scan, rank, then densely re-check the leaders one by one. */
  private pump = (deadline?: IdleDeadline): void => {
    this.idleId = 0;
    const job = this.job;
    if (!job || !this.overlay) return;
    const budget = deadline && !deadline.didTimeout ? Math.max(3, Math.min(10, deadline.timeRemaining())) : 5;
    const end = performance.now() + budget;
    for (;;) {
      if (!job.scan.run(end)) break;
      if (!job.cands) {
        job.search ??= new Search(job.scan, this.placeOptions(job.w, job.scan));
        if (!job.search.run(end)) break;
        job.cands = job.search.result;
        job.k = 0;
        job.verifying = false;
      }
      const c = job.cands[job.k];
      if (!c) return this.finishPlan(null);
      if (!job.verifying) {
        densifySpot(job.scan, c);
        job.verifying = true;
        continue;
      }
      if (stillFree(job.scan, c)) return this.finishPlan(c);
      job.k++;
      job.verifying = false;
      if (performance.now() > end) break;
    }
    this.requestIdle();
  };

  private finishPlan(spot: Spot | null): void {
    const job = this.job!;
    this.job = null;
    const w = job.w;
    if (!spot) {
      w.plan = null;
      w.planState = 'nowhere';
    } else {
      const anchor = job.scan.anchorAt(spot.x, spot.y);
      const { vw, vh } = viewportSize();
      w.plan = {
        spot,
        dark: pageIsDark(spot.x, spot.y),
        anchor,
        ax: anchor ? anchor.scrollLeft : 0,
        ay: anchor ? anchor.scrollTop : 0,
        sx: scrollX,
        sy: scrollY,
        vw,
        vh,
        at: performance.now(),
        pinned: job.scan.pinned.slice(),
      };
      w.planState = 'ready';
    }
    this.schedule();
  }

  // --- loop ------------------------------------------------------------------------

  private addSecondary(): void {
    for (const w of this.watchers) if (!w.main) return;
    const second = new Watcher(this, false, 0.7, 0.75);
    const main = this.watchers[0];
    second.wakeAt = main && main.phase === 'watching' ? this.clock + 4000 + this.rand() * 3000 : Infinity;
    this.watchers.push(second);
  }

  private anyVisible(): boolean {
    for (const w of this.watchers) if (w.visible) return true;
    return false;
  }

  private allCalm(): boolean {
    for (const w of this.watchers) if (w.visible && !w.calm) return false;
    return true;
  }

  private anyUrgent(): boolean {
    for (const w of this.watchers) if (w.visible && w.urgent) return true;
    return false;
  }

  private allDone(): boolean {
    for (const w of this.watchers) if (w.phase !== 'done') return false;
    return true;
  }

  private advance(): number {
    const now = performance.now();
    if (!this.paused) this.clock += now - this.lastReal;
    this.lastReal = now;
    return this.clock;
  }

  private frame = (): void => {
    this.raf = 0;
    this.wakeTimer = this.calmTimer = undefined;
    if (!this.overlay || this.paused) return;
    // Slow things (a lid easing open, darkness gathering) look the same at 30 fps and cost half.
    const real = performance.now();
    if (real - this.lastFrame < 28 && !this.anyUrgent()) {
      this.raf = requestAnimationFrame(this.frame);
      return;
    }
    this.lastFrame = real;
    const prev = this.clock;
    const now = this.advance();
    const dt = Math.min(0.05, Math.max(0, (now - prev) / 1000));
    const p = this.pointer;
    if (performance.now() - p.at > 120) p.vx = p.vy = 0;
    if (!this.ending && !this.stopping && now > LIFETIME) {
      this.ending = true;
      this.cancelJob();
      for (const w of this.watchers) w.close('final');
    }
    for (const w of this.watchers) {
      if (w.phase === 'waiting' && w.wakeAt !== Infinity && !this.stopping && !this.ending) this.wake(w, now);
      w.update(now, dt);
    }
    if (this.allDone()) {
      this.destroy();
      return;
    }
    // The second pair has nothing to wait for once the first is gone.
    if (this.watchers[0].phase === 'done') {
      for (const w of this.watchers) if (w.phase === 'waiting' && w.wakeAt === Infinity) w.close('final');
    }
    for (const w of this.watchers) w.draw(now);
    this.schedule();
  };

  private wake(w: Watcher, now: number): void {
    if (w.planState === 'none' && now >= w.wakeAt - PLAN_AHEAD) this.startPlan(w);
    if (now < w.wakeAt) return;
    if (w.planState === 'ready') {
      if (w.planValid()) w.reveal(now);
      else {
        w.planState = 'none';
        this.startPlan(w);
      }
    } else if (w.planState === 'nowhere') {
      // Nowhere empty to open: wait for the page to move, or try again later.
      w.planState = 'none';
      w.wakeAt = now + 6000;
    }
  }

  /** Animate while anything is on screen (slowly when all is calm); otherwise sleep until the next pair is due. */
  private schedule(): void {
    if (!this.overlay || this.paused) return;
    if (this.anyVisible()) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
      if (this.raf || this.calmTimer) return;
      if (this.allCalm()) this.calmTimer = window.setTimeout(this.frame, 95);
      else this.raf = requestAnimationFrame(this.frame);
      return;
    }
    if (this.raf || this.calmTimer) return;
    let next = this.ending || this.stopping ? this.clock : LIFETIME;
    for (const w of this.watchers) {
      if (w.phase !== 'waiting' || w.planState === 'pending') continue;
      next = Math.min(next, w.planState === 'none' ? w.wakeAt - PLAN_AHEAD : w.wakeAt);
    }
    if (this.allDone()) next = this.clock;
    clearTimeout(this.wakeTimer);
    this.wakeTimer = window.setTimeout(this.frame, Math.max(16, next - this.clock));
  }

  /** Leave the slow calm tick at once when something happens. */
  private hurry(): void {
    if (!this.calmTimer) return;
    clearTimeout(this.calmTimer);
    this.calmTimer = undefined;
    if (!this.raf && !this.paused) this.raf = requestAnimationFrame(this.frame);
  }

  private onPointer = (e: PointerEvent): void => {
    const p = this.pointer;
    const t = performance.now();
    if (p.known) {
      const dtm = t - p.at;
      if (dtm > 0 && dtm < 120) {
        p.vx = p.vx * 0.5 + ((e.clientX - p.x) / dtm) * 0.5;
        p.vy = p.vy * 0.5 + ((e.clientY - p.y) / dtm) * 0.5;
      } else {
        p.vx = p.vy = 0;
      }
    } else {
      p.vx = p.vy = 0;
      for (const w of this.watchers) w.noticed(this.clock);
    }
    p.x = e.clientX;
    p.y = e.clientY;
    p.known = true;
    p.at = t;
    this.hurry();
  };

  /** The cursor left the window: they drift back to staring straight out. */
  private onPointerOut = (e: PointerEvent): void => {
    if (e.relatedTarget) return;
    this.pointer.known = false;
    this.pointer.vx = this.pointer.vy = 0;
    this.hurry();
  };

  private onScroll = (e: Event): void => {
    const t = e.target;
    const page = t === document || t === document.documentElement || t === document.body || t === document.scrollingElement;
    for (const w of this.watchers) {
      if (page || (w.anchor && w.anchor === t)) w.follow();
      // A pair with nowhere to go gets another look once the page has moved.
      if (w.phase === 'waiting' && w.planState !== 'pending' && w.wakeAt !== Infinity && w.wakeAt - this.clock > 1500 && w.planState === 'none') {
        w.wakeAt = this.clock + 1500;
      }
    }
    this.hurry();
  };

  private onResize = (): void => {
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.scan = null;
    for (const w of this.watchers) {
      w.retreat(false);
      if (w.phase === 'waiting' && w.planState === 'ready') w.planState = 'none';
    }
    this.hurry();
  };

  private onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      this.advance();
      this.paused = true;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      clearTimeout(this.wakeTimer);
      clearTimeout(this.calmTimer);
      this.wakeTimer = this.calmTimer = undefined;
      this.cancelJob();
    } else if (this.paused) {
      this.lastReal = performance.now();
      this.paused = false;
      this.schedule();
    }
  };
}

