// Eyes in the dark. Come back to a dead tab and, after a moment, darkness pools
// in an empty corner of the page and a pair of eyes slowly opens in it. They
// follow the cursor, blink, squint, and shut the instant you come for them,
// only to open again somewhere else. After three retreats, or about 45 seconds,
// they close for good. An entombed tab has a second, fainter pair further off.
//
// Everything is drawn on small canvases inside our own overlay; the page is
// only ever read (once per placement, to find somewhere empty), never touched.

import type { Effect, EffectContext } from './types';
import { createOverlay, seeded, type Overlay } from './overlay';
import { chooseSpot, pageIsDark, scanViewport } from './eyes-place';
import { PALETTES, SCLERA_BOX, paintDab, paintIris, paintPupil, paintSclera, paintSmoke, type Palette } from './eyes-paint';

const LIFETIME = 45_000;
const MAX_RETREATS = 3;
/** The cursor this close (px from the eyes) makes them shut. */
const NEAR = 180;
/** Cursor speed towards the eyes (px/ms) that makes them shut from further away. */
const LUNGE = 1.25;
const LUNGE_RANGE = 460;

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
/** How far the iris can travel: sideways, up, down. */
const MAX_X = 0.19;
const MAX_UP = 0.085;
const MAX_DOWN = 0.065;
const LASHES = 12;
const LOWER_LASHES = 9;

const CSS = `canvas { position: absolute; left: 0; top: 0; display: none; will-change: transform; }`;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);
const easeInQuad = (t: number) => t * t;
const easeOutCubic = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

type Phase = 'waiting' | 'revealing' | 'watching' | 'retreating' | 'closing' | 'done';
type BlinkKind = 'single' | 'double' | 'slow';
type CloseKind = 'retreat' | 'stop' | 'final';

interface Pointer {
  x: number;
  y: number;
  vx: number;
  vy: number;
  known: boolean;
  /** performance.now() of the last move. */
  at: number;
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

interface Blob {
  x: number;
  y: number;
  rx: number;
  ry: number;
  a: number;
  delay: number;
  fx: number;
  fy: number;
  ph: number;
  drift: number;
  sprite: number;
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
  findSpot(w: Watcher): { x: number; y: number; w: number; dark: boolean };
  onWatching(w: Watcher): void;
  onRetreat(w: Watcher, counted: boolean): void;
}

/** One pair of eyes and the darkness around it. */
class Watcher {
  phase: Phase = 'waiting';
  wakeAt = Infinity;
  /** When this pair next closes it stays closed. */
  final = false;
  x = 0;
  y = 0;
  w = 40;
  private pageX = 0;
  private pageY = 0;
  private tilt = 0;
  private cos = 1;
  private sin = 0;
  private phaseT = 0;
  private revealed = false;
  private pool = 0;
  private env0 = 0;
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
  private poolAlpha = 0.95;
  private lastDraw = -Infinity;
  private calm = false;

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
  private wander = 0;

  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private cw = 0;
  private ch = 0;
  private readonly eyes: [Eye, Eye];
  private blobs: Blob[] = [];
  private readonly pupil: HTMLCanvasElement;
  private readonly highlight: HTMLCanvasElement;
  private readonly smoke: HTMLCanvasElement[];
  private readonly glow: HTMLCanvasElement;
  private readonly socket: HTMLCanvasElement;
  private lidFill: CanvasGradient | null = null;

  constructor(
    private readonly host: Host,
    readonly main: boolean,
    /** Relative size and strength: the far pair of an entombed tab is smaller and fainter. */
    readonly scale: number,
    private readonly alpha: number,
  ) {
    this.canvas = document.createElement('canvas');
    host.layer.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d')!;
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
      dil: 0.56,
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
    this.eyes[r() < 0.5 ? 0 : 1].droop = 0.9 + r() * 0.06;
    this.wander = r() * 100;
    const dpr = host.dpr;
    this.pupil = paintPupil(dpr);
    this.highlight = paintDab(32 * dpr, [255, 252, 244], [
      [0, 1],
      [0.18, 0.92],
      [0.38, 0.4],
      [0.66, 0.08],
      [1, 0],
    ]);
    this.smoke = [0, 1, 2].map(() => paintSmoke(200, [3, 2, 5], r));
    this.glow = paintDab(64 * dpr, host.palette.glow, [
      [0, 0.6],
      [0.25, 0.26],
      [0.55, 0.07],
      [1, 0],
    ]);
    this.socket = paintDab(64 * dpr, [70, 50, 44], [
      [0, 0.62],
      [0.4, 0.36],
      [0.7, 0.1],
      [1, 0],
    ]);
  }

  get visible(): boolean {
    return this.phase === 'revealing' || this.phase === 'watching' || this.phase === 'retreating' || this.phase === 'closing';
  }

  // --- life cycle ------------------------------------------------------------

  private reveal(now: number): void {
    const spot = this.host.findSpot(this);
    this.setup(spot.x, spot.y, spot.w, spot.dark);
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
    for (const e of this.eyes) {
      e.ox = e.oy = e.vx = e.vy = 0;
      e.dil = 0.62;
    }
    this.lastDraw = -Infinity;
    this.canvas.style.display = 'block';
  }

  /** Shut and fade. Counted retreats are the reader chasing them off. */
  retreat(counted: boolean): void {
    if (this.phase !== 'revealing' && this.phase !== 'watching') return;
    const reduced = this.host.reduced;
    this.beginClose('retreat');
    this.closeMs = reduced ? 850 : 85;
    this.dissolveDelay = reduced ? 300 : 30;
    this.dissolveMs = reduced ? 1500 : 900;
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
    this.env0 = Math.max(this.eyes[0].up, this.eyes[1].up) / Math.max(0.5, Math.min(this.eyes[0].droop, this.eyes[1].droop));
    this.env0 = Math.min(1.05, Math.max(this.env0, 0));
    this.pool0 = this.pool;
    this.closeKind = kind;
    this.phase = kind === 'retreat' ? 'retreating' : 'closing';
    this.phaseT = this.host.clock;
    this.blinkAt = this.squintAt = -1e9;
  }

  private hide(): void {
    this.canvas.style.display = 'none';
  }

  remove(): void {
    this.canvas.remove();
  }

  /** The page scrolled: stay in the same spot on the page, and give up if it leaves the screen. */
  follow(sx: number, sy: number): void {
    if (!this.visible) return;
    this.x = this.pageX - sx;
    this.y = this.pageY - sy;
    this.position();
    const hx = 1.7 * this.w;
    const hy = 0.6 * this.w;
    if (this.x - hx < 0 || this.x + hx > innerWidth || this.y - hy < 0 || this.y + hy > innerHeight) this.retreat(false);
  }

  overlaps(r: DOMRect): boolean {
    const hx = 2 * this.w;
    const hy = 1.2 * this.w;
    return this.visible && this.x + hx > r.left && this.x - hx < r.right && this.y + hy > r.top && this.y - hy < r.bottom;
  }

  private position(): void {
    this.canvas.style.transform = `translate3d(${(this.x - this.cw / 2).toFixed(1)}px,${(this.y - this.ch / 2).toFixed(1)}px,0)`;
  }

  /** Size the canvas and paint this placement's sprites. */
  private setup(x: number, y: number, w: number, dark: boolean): void {
    const host = this.host;
    const dpr = host.dpr;
    const rand = host.rand;
    this.x = x;
    this.y = y;
    this.w = w;
    this.pageX = x + scrollX;
    this.pageY = y + scrollY;
    this.tilt = (rand() - 0.5) * 0.12;
    this.cos = Math.cos(this.tilt);
    this.sin = Math.sin(this.tilt);
    this.poolAlpha = dark ? 0.86 : 0.96;
    this.cw = Math.ceil(7.6 * w);
    this.ch = Math.ceil(5.2 * w);
    this.canvas.width = Math.round(this.cw * dpr);
    this.canvas.height = Math.round(this.ch * dpr);
    this.canvas.style.width = `${this.cw}px`;
    this.canvas.style.height = `${this.ch}px`;
    this.position();

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
    const lid = this.g.createLinearGradient(0, -0.19 * w, 0, MEET * w);
    lid.addColorStop(0, 'rgb(8,6,7)');
    lid.addColorStop(0.7, 'rgb(26,19,18)');
    lid.addColorStop(0.92, 'rgb(40,29,26)');
    lid.addColorStop(1, 'rgb(30,22,20)');
    this.lidFill = lid;

    // The darkness: soft dabs that gather from the edges and breathe.
    const j = () => (rand() - 0.5) * 0.3;
    const B = (x0: number, y0: number, rx: number, ry: number, a: number, delay: number): Blob => ({
      x: (x0 + j()) * w,
      y: (y0 + j()) * w,
      rx: rx * w * (0.92 + rand() * 0.16),
      ry: ry * w * (0.92 + rand() * 0.16),
      a,
      delay,
      fx: 1 / (2400 + rand() * 2800),
      fy: 1 / (2600 + rand() * 3000),
      ph: rand() * 10,
      drift: (0.05 + rand() * 0.09) * w,
      sprite: Math.floor(rand() * 3),
    });
    this.blobs = [
      B(0, 0.02, 2.7, 1.0, 0.9, 0.0),
      B(0, 0.3, 2.5, 1.5, 0.75, 0.04),
      B(-1.45, 0.15, 1.5, 1.2, 0.6, 0.14),
      B(1.45, 0.1, 1.5, 1.15, 0.6, 0.18),
      B(0.1, -0.55, 1.9, 0.9, 0.45, 0.24),
      B(-0.1, 1.0, 2.0, 1.05, 0.5, 0.28),
      B((rand() < 0.5 ? -1 : 1) * (0.8 + rand()), -0.4 + rand() * 1.2, 0.8 + rand() * 0.4, 0.6 + rand() * 0.3, 0.26, 0.34),
      B((rand() < 0.5 ? -1 : 1) * (0.8 + rand()), -0.4 + rand() * 1.2, 0.8 + rand() * 0.4, 0.6 + rand() * 0.3, 0.22, 0.4),
    ];
  }

  // --- simulation --------------------------------------------------------------

  update(now: number, dt: number): void {
    if (this.phase === 'done') return;
    if (this.phase === 'waiting') {
      if (now < this.wakeAt) return;
      this.reveal(now);
    }
    const host = this.host;
    const reduced = host.reduced;
    const rand = host.rand;
    const t = now - this.phaseT;
    let env = 1;
    let pool = 1;

    if (this.phase === 'revealing') {
      pool = easeInOut(clamp01(t / this.gather));
      const t0 = this.gather * 0.62;
      const t1 = t0 + this.slitIn;
      const t2 = t1 + this.slitHold;
      const t3 = t2 + this.openMs;
      env = t < t0 ? 0 : t < t1 ? SLIT * easeOutCubic((t - t0) / this.slitIn) : t < t2 ? SLIT : t < t3 ? SLIT + (1 - SLIT) * easeInOut((t - t2) / this.openMs) : 1;
      // While still slits, they find you.
      if (t >= t1 + this.slitHold * 0.45) this.gazeOn = true;
      if (t >= t3 && t >= this.gather) {
        this.phase = 'watching';
        this.phaseT = now;
        if (this.watchStart < 0) this.watchStart = now;
        this.nextBlink = now + 700 + rand() * 1600;
        this.nextSacc = now + 400 + rand() * 900;
        host.onWatching(this);
      }
    } else if (this.phase === 'retreating' || this.phase === 'closing') {
      env = this.closeProfile(t);
      pool = this.pool0 * (1 - easeInOut(clamp01((t - this.dissolveDelay) / this.dissolveMs)));
      if (t >= this.dissolveDelay + this.dissolveMs && t >= this.closeMs) {
        this.hide();
        if (this.final || this.phase === 'closing') {
          this.phase = 'done';
        } else {
          this.phase = 'waiting';
          this.wakeAt = now + this.reopenDelay;
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

    // Where they look: the cursor if they know where it is, otherwise straight out at you.
    const p = host.pointer;
    const w = this.w;
    const live = this.phase === 'revealing' || this.phase === 'watching';
    if (!reduced && live && this.gazeOn && now >= this.nextSacc) {
      this.nextSacc = now + 600 + rand() * 2200;
      if (p.known && rand() < 0.12) {
        // A glance at something else on the page, then straight back.
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
    const pursuitK = reduced ? 22 : 150;
    const pursuitZeta = reduced ? 1.05 : 0.74;
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      if (!reduced) {
        const k = 1300;
        const c = 2 * Math.sqrt(k) * 0.82;
        this.svx += (k * (this.stx - this.sx) - c * this.svx) * h;
        this.svy += (k * (this.sty - this.sy) - c * this.svy) * h;
        this.sx += this.svx * h;
        this.sy += this.svy * h;
      }
    }

    const dxp = p.x - this.x;
    const dyp = p.y - this.y;
    const pairDist = p.known ? Math.hypot(Math.max(0, Math.abs(dxp) - 1.6 * w), Math.max(0, Math.abs(dyp) - 0.35 * w)) : Infinity;
    const watched = this.watchStart < 0 ? 0 : now - this.watchStart;
    let calm = this.phase === 'watching' && squint === 0 && now - this.blinkAt > 2400 && performance.now() - p.at > 250;

    for (const e of this.eyes) {
      let tx: number;
      let ty: number;
      if (this.gazeOn && p.known) {
        const ex = this.x + this.cos * e.lx - this.sin * e.ly;
        const ey = this.y + this.sin * e.lx + this.cos * e.ly;
        const dx = p.x - ex;
        const dy = p.y - ey;
        const lx = this.cos * dx + this.sin * dy;
        const ly = -this.sin * dx + this.cos * dy;
        const dist = Math.hypot(lx, ly) || 1;
        const f = dist / (dist + 170);
        tx = (lx / dist) * f * MAX_X * w * 1.15;
        ty = (ly / dist) * f * (ly < 0 ? MAX_UP : MAX_DOWN) * w * 1.5;
      } else {
        const sp = reduced ? 0.00012 : 0.00028;
        tx = Math.sin(now * sp + this.wander) * 0.03 * w;
        ty = 0.01 * w + Math.sin(now * sp * 0.7 + this.wander * 2) * 0.012 * w;
      }
      const k = pursuitK * e.stiff;
      const c = 2 * Math.sqrt(k) * pursuitZeta;
      for (let s = 0; s < steps; s++) {
        e.vx += (k * (tx - e.ox) - c * e.vx) * h;
        e.vy += (k * (ty - e.oy) - c * e.vy) * h;
        e.ox += e.vx * h;
        e.oy += e.vy * h;
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
      // Startle: they widen for an instant before they shut.
      if (this.phase === 'retreating' && !reduced && t < 45) up = this.env0 * e.droop * (1 + 0.14 * (t / 45));
      e.up = up;
      e.lo = clamp01(lerp(0.68, 1, Math.min(1, env * b)) - 0.46 * squint);

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
      return e0 * 1.14 * (1 - easeInQuad(clamp01((t - 45) / this.closeMs)));
    }
    if (this.closeKind === 'stop') return e0 * (1 - easeInOut(clamp01(t / this.closeMs)));
    // Final: narrow to a last long look, hold it, then close slowly.
    const look = Math.min(e0, 0.42);
    if (t < 550) return lerp(e0, look, easeInOut(t / 550));
    if (t < 1350) return look;
    return look * (1 - easeInOut(clamp01((t - 1350) / 1150)));
  }

  // --- drawing -----------------------------------------------------------------

  /** Draw if anything changed; when calm, a lower frame rate is plenty for slow breathing. */
  draw(now: number): void {
    if (!this.visible) return;
    if (this.calm && now - this.lastDraw < 42) return;
    this.lastDraw = now;
    const g = this.g;
    const dpr = this.host.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(dpr * this.cos, dpr * this.sin, -dpr * this.sin, dpr * this.cos, (dpr * this.cw) / 2, (dpr * this.ch) / 2);
    this.drawPool(now);
    const A = this.alpha * smooth(clamp01((this.pool - 0.5) / 0.42));
    if (A <= 0.003) return;
    for (const e of this.eyes) this.drawEye(e, A);
    // A faint warm eyeshine spilling into the dark around each eye.
    g.globalCompositeOperation = 'lighter';
    const w = this.w;
    for (const e of this.eyes) {
      const open = clamp01(e.up / 0.9);
      if (open <= 0.01) continue;
      g.globalAlpha = A * 0.2 * open;
      g.drawImage(this.glow, e.lx + e.ix * 0.5 - 1.15 * w, e.ly - 0.75 * w, 2.3 * w, 1.5 * w);
    }
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
  }

  private drawPool(now: number): void {
    const g = this.g;
    const p = this.pool;
    if (p <= 0.002) return;
    const dissolving = this.phase === 'retreating' || this.phase === 'closing';
    const breathe = 1 + 0.035 * Math.sin(now / 2100 + this.wander);
    const strength = this.poolAlpha * (this.main ? 1 : 0.9);
    const calm = this.host.reduced ? 0.5 : 1;
    for (const b of this.blobs) {
      const gi = smooth(clamp01((p - b.delay) / (1 - b.delay)));
      if (gi <= 0.002) continue;
      const spread = 1 + (1 - gi) * (dissolving ? 0.3 : 0.4);
      const sc = dissolving ? 1 + (1 - gi) * 0.35 : 0.55 + 0.45 * gi;
      const bx = b.x * spread + Math.sin(now * b.fx + b.ph) * b.drift * calm;
      const by = b.y * spread + Math.cos(now * b.fy + b.ph) * b.drift * 0.6 * calm;
      const rx = b.rx * sc * breathe;
      const ry = b.ry * sc * breathe;
      g.globalAlpha = strength * b.a * gi;
      g.drawImage(this.smoke[b.sprite], bx - rx, by - ry, rx * 2, ry * 2);
    }
    g.globalAlpha = 1;
  }

  private drawEye(e: Eye, A: number): void {
    const g = this.g;
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

    g.save();
    g.translate(e.lx, e.ly);
    g.scale(m * e.size, e.size);

    // The faint shape of a face: a socket, lit only by the eyes.
    g.globalAlpha = A * 0.5;
    g.drawImage(this.socket, -0.9 * w, -0.62 * w, 1.8 * w, 1.2 * w);

    const openH = lowerY - upperY;
    if (openH > 0.004 * w) {
      g.save();
      g.beginPath();
      g.moveTo(p0x, p0y);
      g.bezierCurveTo(c1x, upperY, c2x, upperY, p3x, p3y);
      g.bezierCurveTo(c2x, lowerY, c1x, lowerY, p0x, p0y);
      g.closePath();
      g.clip();

      g.globalAlpha = A;
      if (e.sclera) g.drawImage(e.sclera, SCLERA_BOX.x * w, SCLERA_BOX.y * w, SCLERA_BOX.w * w, SCLERA_BOX.h * w);

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
      g.drawImage(this.pupil, -pr, -pr, pr * 2, pr * 2);
      g.restore();
      // Eyeshine scattering into the white around the iris.
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = A * 0.3;
      g.drawImage(this.glow, ix - R * 1.6, iy - R * 1.6, R * 3.2, R * 3.2);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = A;

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
      g.globalAlpha = A * 0.95;
      const hs = 0.3 * R;
      const hx = ix * 0.55 - m * 0.36 * R;
      const hy = iy * 0.55 - 0.4 * R;
      g.drawImage(this.highlight, hx - hs, hy - hs * 0.8, hs * 2, hs * 1.6);
      g.globalAlpha = A * 0.4;
      const hs2 = 0.11 * R;
      g.drawImage(this.highlight, ix * 0.55 + m * 0.34 * R - hs2, iy * 0.55 + 0.3 * R - hs2, hs2 * 2, hs2 * 2);
      g.restore();
    }

    g.globalAlpha = A;
    // Eyelid skin, sliding over the eye.
    if (e.up < 0.985 && this.lidFill) {
      g.beginPath();
      g.moveTo(p0x, p0y);
      g.bezierCurveTo(c1x, UPPER_OPEN * w, c2x, UPPER_OPEN * w, p3x, p3y);
      g.bezierCurveTo(c2x, upperY, c1x, upperY, p0x, p0y);
      g.fillStyle = this.lidFill;
      g.fill();
    }
    if (e.lo < 0.985) {
      g.beginPath();
      g.moveTo(p0x, p0y);
      g.bezierCurveTo(c1x, lowerY, c2x, lowerY, p3x, p3y);
      g.bezierCurveTo(c2x, LOWER_OPEN * w, c1x, LOWER_OPEN * w, p0x, p0y);
      g.fillStyle = 'rgb(24,17,16)';
      g.fill();
    }

    // Crease above the lid, deeper when the eye is wide.
    const creaseY = lerp(-0.3, -0.41, clamp01(e.up)) * w;
    g.beginPath();
    g.moveTo(-0.44 * w, -0.02 * w);
    g.bezierCurveTo(-0.2 * w, creaseY, 0.24 * w, creaseY, 0.5 * w, -0.08 * w);
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.lineWidth = 0.032 * w;
    g.stroke();
    g.translate(0, 0.03 * w);
    g.strokeStyle = 'rgba(120,88,74,0.12)';
    g.lineWidth = 0.022 * w;
    g.stroke();
    g.translate(0, -0.03 * w);

    // Lid margins.
    g.beginPath();
    g.moveTo(p0x, p0y);
    g.bezierCurveTo(c1x, upperY, c2x, upperY, p3x, p3y);
    g.strokeStyle = 'rgba(10,5,4,0.92)';
    g.lineWidth = 0.034 * w;
    g.stroke();
    g.beginPath();
    g.moveTo(p0x, p0y);
    g.bezierCurveTo(c1x, lowerY, c2x, lowerY, p3x, p3y);
    g.strokeStyle = 'rgba(26,15,13,0.6)';
    g.lineWidth = 0.018 * w;
    g.stroke();

    // Lashes: up and out when open, down and out as the lid falls.
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
    g.strokeStyle = 'rgba(6,4,4,0.72)';
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
    g.strokeStyle = 'rgba(8,5,5,0.45)';
    g.lineWidth = Math.max(hair, 0.01 * w);
    g.stroke();
    g.restore();
  }
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
  private paused = false;
  private raf = 0;
  private wakeTimer: number | undefined;
  private stopTimer: number | undefined;
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
    this.overlay = createOverlay(this.name, CSS);

    const first = new Watcher(this, true, 1, 1);
    first.wakeAt = 1300 + this.rand() * 700;
    this.watchers = [first];
    if (this.stage >= 4) this.addSecondary();

    addEventListener('pointermove', this.onPointer, { capture: true, passive: true });
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
    for (const w of this.watchers) w.close('stop');
    clearTimeout(this.stopTimer);
    this.stopTimer = window.setTimeout(() => this.destroy(), 1500);
    this.schedule();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    clearTimeout(this.wakeTimer);
    clearTimeout(this.stopTimer);
    this.wakeTimer = this.stopTimer = undefined;
    removeEventListener('pointermove', this.onPointer, { capture: true });
    removeEventListener('resize', this.onResize);
    document.removeEventListener('scroll', this.onScroll, { capture: true });
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const w of this.watchers) w.remove();
    this.watchers = [];
    this.overlay?.remove();
    this.overlay = null;
    this.stopping = false;
  }

  // --- Host ----------------------------------------------------------------------

  findSpot(w: Watcher): { x: number; y: number; w: number; dark: boolean } {
    const vw = innerWidth;
    const vh = innerHeight;
    const map = scanViewport();
    const baseW = Math.min(58, Math.max(30, Math.min(vw, vh * 1.6) * 0.036)) * w.scale;
    const p = this.pointer;
    const avoid = this.history.slice(-3).map((h) => ({ x: h.x, y: h.y, r: 280 }));
    let far: { x: number; y: number } | undefined;
    for (const o of this.watchers) {
      if (o === w || !o.visible) continue;
      avoid.push({ x: o.x, y: o.y, r: 460 });
      far = { x: o.x, y: o.y };
    }
    const spot = chooseSpot(map, {
      baseW,
      cursorX: p.known ? p.x : vw / 2,
      cursorY: p.known ? p.y : vh / 2,
      cursorR: p.known ? 420 : 260,
      cursorWeight: p.known ? 1.6 : 0.7,
      avoid,
      far: w.main ? undefined : far,
      rand: this.rand,
    });
    return { ...spot, dark: pageIsDark(spot.x, spot.y) };
  }

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

  // --- loop ------------------------------------------------------------------------

  private addSecondary(): void {
    if (this.watchers.some((w) => !w.main)) return;
    const second = new Watcher(this, false, 0.62, 0.7);
    const main = this.watchers[0];
    second.wakeAt = main && main.phase === 'watching' ? this.clock + 4000 + this.rand() * 3000 : Infinity;
    this.watchers.push(second);
  }

  private anyVisible(): boolean {
    for (const w of this.watchers) if (w.visible) return true;
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
    this.wakeTimer = undefined;
    if (!this.overlay || this.paused) return;
    const prev = this.clock;
    const now = this.advance();
    const dt = Math.min(0.05, Math.max(0, (now - prev) / 1000));
    const p = this.pointer;
    if (performance.now() - p.at > 120) p.vx = p.vy = 0;
    if (!this.ending && !this.stopping && now > LIFETIME) {
      this.ending = true;
      for (const w of this.watchers) w.close('final');
    }
    for (const w of this.watchers) w.update(now, dt);
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

  /** Animate while anything is on screen; otherwise sleep until the next pair is due. */
  private schedule(): void {
    if (!this.overlay || this.paused) return;
    if (this.anyVisible()) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
      if (!this.raf) this.raf = requestAnimationFrame(this.frame);
      return;
    }
    if (this.raf) return;
    let next = this.ending || this.stopping ? this.clock : LIFETIME;
    for (const w of this.watchers) if (w.phase === 'waiting') next = Math.min(next, w.wakeAt);
    if (this.allDone()) next = this.clock;
    clearTimeout(this.wakeTimer);
    this.wakeTimer = window.setTimeout(this.frame, Math.max(16, next - this.clock));
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
    }
    p.x = e.clientX;
    p.y = e.clientY;
    p.known = true;
    p.at = t;
  };

  private onScroll = (e: Event): void => {
    const t = e.target;
    if (t === document || t === document.documentElement || t === document.body || t === document.scrollingElement) {
      for (const w of this.watchers) w.follow(scrollX, scrollY);
      return;
    }
    // Something inside the page scrolled: if it moved under the eyes, they slip away.
    if (!(t instanceof Element) || !this.anyVisible()) return;
    const r = t.getBoundingClientRect();
    for (const w of this.watchers) if (w.overlaps(r)) w.retreat(false);
  };

  private onResize = (): void => {
    this.dpr = Math.min(2, devicePixelRatio || 1);
    for (const w of this.watchers) w.retreat(false);
  };

  private onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      this.advance();
      this.paused = true;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    } else if (this.paused) {
      this.lastReal = performance.now();
      this.paused = false;
      this.schedule();
    }
  };
}

