// Fogged glass: frost creeps in from the edges; moving the mouse wipes clear streaks that slowly mist over again.
//
// How it works: a low-resolution density grid (one cell per 4-6 CSS px) says how
// much fog is where. A full-viewport fog texture (haze, grain, droplets, frost) is
// drawn once, then each frame it is masked by the grid, upscaled smoothly. The
// pointer wipes the grid with a soft, streaky brush; wiped cells stay wet for a
// moment, then breathe back in along a logistic curve. Beads of water collect on
// the rims of wiped areas, and now and then one runs down, leaving a clear trail.
// Wiping warms the glass: wipe enough and the fog gives up and fades away.
// The animation sleeps whenever nothing is changing and while the tab is hidden.

import type { Effect, EffectContext } from './types';
import { createCanvas, createOverlay, seeded, type Overlay } from './overlay';
import {
  buildHand, buildWord, clamp01, dropSprite, Noise, renderFogTexture, smoothstep,
  type Grid, type Imprint, type Palette, type Rand,
} from './fog-art';

const MAX_BEADS = 720;
const MAX_RUNNERS = 10;
const QUEUE = 256;
/** How long fresh wipes stay clear before fog starts to come back, in seconds. */
const WET_HOLD = 0.9;
/** Regrowth rate: with the logistic curve below, a fully wiped cell is back in ~8-15 s. */
const REGROW = 0.45;
/** How much the glass warms per fog-load wiped away. About four loads clear it. */
const WARM_GAIN = 0.22;

/** Per stage: how far the fog reaches in (fraction of the short side) and how thick the middle gets. */
const REACH = [0, 0.2, 0.27, 0.36, 0.47];
const CENTRE = [0, 0, 0.035, 0.11, 0.2];

interface Look {
  palette: Palette;
  edgeCap: number;
  bloom: number;
}

export class Fog implements Effect {
  readonly name = 'fog' as const;

  private overlay: Overlay | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private g: CanvasRenderingContext2D | null = null;
  private resizeCanvas: (() => void) | null = null;
  private tex: HTMLCanvasElement | null = null;
  private sprite: HTMLCanvasElement | null = null;
  private mask: HTMLCanvasElement | null = null;
  private maskCtx: CanvasRenderingContext2D | null = null;
  private maskImg: ImageData | null = null;

  private stage = 2;
  private seed = 0;
  private reduced = false;
  private look: Look | null = null;
  private rand: Rand = Math.random;
  private noise: Noise | null = null;

  // The grid.
  private grid: Grid = { cols: 0, rows: 0, cell: 4 };
  private vw = 0;
  private vh = 0;
  private T = new Float32Array(0); // target opacity per cell
  private order = new Float32Array(0); // when the creeping front reaches the cell (0..1)
  private rate = new Float32Array(0); // regrowth rate per cell
  private dens = new Float32Array(0); // 0 = wiped clear, 1 = fogged, up to ~1.25 on pushed rims
  private wet = new Float32Array(0); // sim time until which a wiped cell stays clear
  private bloomMap: Float32Array | null = null;
  private targetMass = 1;

  // Time and state.
  private simT = 0;
  private creepT = 0;
  private creepDur = 4.5;
  private warmth = 0;
  private warmthShown = 0;
  private disturb = 0;
  private raf = 0;
  private lastFrame = 0;
  private lastUpdate = 0;
  private stopping = false;
  private stopTimer: number | undefined;
  private appTimer: number | undefined;
  private ambientTimer: number | undefined;
  private resizeTimer: number | undefined;
  private texTimer: number | undefined;
  private visible = true;
  private ageStarted = 0;

  // Pointer path, queued by events and consumed by the frame loop.
  private queue = new Float64Array(QUEUE * 3);
  private qHead = 0;
  private qTail = 0;
  private hasPrev = false;
  private p0x = 0;
  private p0y = 0;
  private p1x = 0;
  private p1y = 0;
  private p1t = 0;
  private speed = 0;
  private radius = 16;
  private travel = 0;
  private lastPointer = -1e9;
  private runnerCooldown = 0;
  private streakPhase = 0;

  // Beads of water (ring buffer) and drops running down the glass.
  private bx = new Float32Array(MAX_BEADS);
  private by = new Float32Array(MAX_BEADS);
  private br = new Float32Array(MAX_BEADS);
  private bt = new Float32Array(MAX_BEADS);
  private bl = new Float32Array(MAX_BEADS);
  private bLive = new Uint8Array(MAX_BEADS);
  private bNext = 0;
  private beadCount = 0;
  private rx = new Float32Array(MAX_RUNNERS);
  private ry = new Float32Array(MAX_RUNNERS);
  private rr = new Float32Array(MAX_RUNNERS);
  private rv = new Float32Array(MAX_RUNNERS);
  private rPhase = new Float32Array(MAX_RUNNERS);
  private rLeft = new Float32Array(MAX_RUNNERS);
  private rLive = new Uint8Array(MAX_RUNNERS);
  private runnerCount = 0;
  // The part of the screen that needs redrawing this frame, in CSS px.
  private dx0 = Infinity;
  private dy0 = Infinity;
  private dx1 = -Infinity;
  private dy1 = -Infinity;

  // The visitor on the other side of the glass (stage 3+, at most once).
  private app: Imprint | null = null;
  private appT = 0;
  private appRelease = 0;
  private appBead = 0;
  private appDrip = 0;
  private appUsed = false;
  private appTries = 0;

  get active(): boolean {
    return !!this.overlay;
  }

  start(ctx: EffectContext): void {
    const stage = Math.max(2, Math.min(4, ctx.stage));
    this.reduced = ctx.reduced;
    if (this.overlay) {
      // Coming back to a tab that is already fogged: thicken it again, never duplicate.
      this.cancelStop();
      this.warmth = Math.min(this.warmth, 0.2);
      if (stage > this.stage) {
        this.stage = stage;
        this.build(true);
        if (stage >= 3 && !this.appUsed && this.appTimer === undefined) this.scheduleApparition(9000);
      }
      this.wake();
      return;
    }
    this.stage = stage;
    this.seed = ctx.seed >>> 0;
    this.rand = seeded(this.seed ^ 0x0f06f06);
    this.noise = new Noise(seeded(this.seed ^ 0x51a7e));
    this.creepDur = this.reduced ? 5.5 : 3.6 + this.rand() * 2.2;
    this.look = pickLook();
    this.simT = this.creepT = this.warmth = this.warmthShown = this.disturb = 0;
    this.qHead = this.qTail = this.appTries = 0;
    this.hasPrev = this.appUsed = this.stopping = false;
    this.lastPointer = -1e9;
    this.ageStarted = performance.now();

    this.overlay = createOverlay(this.name, '.layer { transition: opacity 1.2s ease-in-out; }');
    const { canvas, ctx: g, resize } = createCanvas(this.overlay.layer, 1.5);
    this.canvas = canvas;
    this.g = g;
    this.resizeCanvas = resize;
    this.sprite = dropSprite();
    this.mask = document.createElement('canvas');
    this.maskCtx = this.mask.getContext('2d');
    this.build(false);

    addEventListener('pointermove', this.onPointer, { passive: true });
    addEventListener('wheel', this.onWheel, { passive: true });
    addEventListener('resize', this.onResize, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibility);
    this.visible = document.visibilityState === 'visible';

    // Left alone, the glass slowly warms up and the fog lifts by itself after a few minutes.
    this.ambientTimer = window.setInterval(() => {
      if (!this.visible || this.stopping) return;
      if (performance.now() - this.ageStarted < 45_000) return;
      this.warmth = Math.min(1, this.warmth + 0.035);
      this.wake();
    }, 15_000);

    if (this.stage >= 3 && this.rand() < (this.stage >= 4 ? 0.8 : 0.55)) {
      this.scheduleApparition((this.creepDur + 7 + this.rand() * 12) * 1000);
    }
    this.wake();
  }

  stop(): void {
    if (!this.overlay || this.stopping) return;
    this.stopping = true;
    this.overlay.layer.style.opacity = '0';
    clearTimeout(this.stopTimer);
    this.stopTimer = window.setTimeout(() => this.destroy(), 1300);
  }

  destroy(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    clearTimeout(this.stopTimer);
    clearTimeout(this.appTimer);
    clearTimeout(this.resizeTimer);
    clearTimeout(this.texTimer);
    clearInterval(this.ambientTimer);
    this.stopTimer = this.appTimer = this.resizeTimer = this.texTimer = this.ambientTimer = undefined;
    removeEventListener('pointermove', this.onPointer);
    removeEventListener('wheel', this.onWheel);
    removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.overlay?.remove();
    this.overlay = null;
    this.canvas = this.g = this.tex = this.sprite = this.mask = this.maskCtx = null;
    this.maskImg = null;
    this.resizeCanvas = null;
    this.app = null;
    this.bloomMap = null;
    this.stopping = false;
    this.bLive.fill(0);
    this.rLive.fill(0);
    this.beadCount = this.runnerCount = 0;
  }

  private cancelStop(): void {
    if (!this.stopping || !this.overlay) return;
    this.stopping = false;
    clearTimeout(this.stopTimer);
    this.stopTimer = undefined;
    this.overlay.layer.style.opacity = '1';
  }

  // --- building ----------------------------------------------------------------

  /** Size the grid to the viewport and work out where the fog wants to be. */
  private build(keep: boolean): void {
    const noise = this.noise!;
    const look = this.look!;
    const vw = Math.max(1, innerWidth);
    const vh = Math.max(1, innerHeight);
    const cell = Math.max(4, Math.min(8, Math.round(Math.sqrt((vw * vh) / 60000))));
    const cols = Math.ceil(vw / cell) + 1;
    const rows = Math.ceil(vh / cell) + 1;
    const n = cols * rows;
    const old = keep ? { dens: this.dens, wet: this.wet, cols: this.grid.cols, rows: this.grid.rows } : null;

    this.vw = vw;
    this.vh = vh;
    this.grid = { cols, rows, cell };
    this.T = new Float32Array(n);
    this.order = new Float32Array(n);
    this.rate = new Float32Array(n);
    this.dens = new Float32Array(n).fill(1);
    this.wet = new Float32Array(n);
    this.bloomMap = null;
    this.app = null;

    const short = Math.min(vw, vh);
    const reach = REACH[this.stage] * short + 40;
    const centre = CENTRE[this.stage] * (look.palette.dark ? 0.85 : 1);
    const cap = look.edgeCap;
    let mass = 0;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const px = (x + 0.5) * cell;
        const py = (y + 0.5) * cell;
        const ex = Math.max(1, Math.min(px, vw - px));
        const ey = Math.max(1, Math.min(py, vh - py));
        // Distance to the frame, rounded off at the corners; corners also reach further in.
        const d = Math.pow(ex ** -4 + ey ** -4, -0.25);
        const corner = (1 - clamp01(ex / (reach * 1.8))) * (1 - clamp01(ey / (reach * 1.8)));
        const low = noise.fbm(px / 340, py / 340, 3);
        const mid = noise.fbm(px / 90 + 11, py / 90 - 7, 2);
        const r = reach * (0.62 + 0.8 * low) * (1 + 0.7 * corner);
        const f = clamp01(1 - d / r);
        const edge = Math.pow(f * f * (3 - 2 * f), 1.25);
        const i = y * cols + x;
        const t = (centre + (cap - centre) * edge) * (0.82 + 0.3 * mid);
        this.T[i] = Math.min(cap, t);
        mass += this.T[i];
        this.order[i] = clamp01(d / (r * 1.1)) * 0.86 + mid * 0.14;
        this.rate[i] = REGROW * (0.7 + 0.6 * noise.at(px / 60 - 50, py / 60 + 20));
      }
    }
    this.targetMass = Math.max(1, mass);

    if (old) {
      // Carry the wiped state across a resize or stage change.
      for (let y = 0; y < rows; y++) {
        const oy = Math.min(old.rows - 1, Math.floor((y * old.rows) / rows));
        for (let x = 0; x < cols; x++) {
          const ox = Math.min(old.cols - 1, Math.floor((x * old.cols) / cols));
          const j = oy * old.cols + ox;
          if (j < old.dens.length) {
            this.dens[y * cols + x] = old.dens[j];
            this.wet[y * cols + x] = old.wet[j];
          }
        }
      }
    }

    this.mask!.width = cols;
    this.mask!.height = rows;
    this.maskImg = this.maskCtx!.createImageData(cols, rows);
    const md = this.maskImg.data;
    for (let i = 0; i < md.length; i += 4) md[i] = md[i + 1] = md[i + 2] = 255;

    this.resizeCanvas?.();
    clearTimeout(this.texTimer);
    if (keep) {
      this.renderTexture();
    } else {
      // A fresh start paints nothing for the first moments anyway: draw the texture in its own task.
      this.tex = null;
      this.texTimer = window.setTimeout(() => {
        this.texTimer = undefined;
        if (!this.overlay) return;
        this.renderTexture();
        this.wake();
      }, 0);
    }
  }

  private renderTexture(): void {
    const vw = this.vw;
    const vh = this.vh;
    const scale = this.canvas ? this.canvas.width / vw : 1;
    this.tex = renderFogTexture({
      w: vw, h: vh, scale, stage: this.stage, rand: seeded(this.seed ^ 0x7e57), noise: this.noise!,
      palette: this.look!.palette, sprite: this.sprite!,
    });
    this.markDirty(0, 0, vw, vh);
  }

  // --- events ------------------------------------------------------------------

  private onPointer = (e: PointerEvent): void => {
    if (this.stopping) return;
    const now = performance.now();
    const events = e.getCoalescedEvents?.() ?? [];
    if (events.length > 1) for (const c of events) this.enqueue(c.clientX, c.clientY, now);
    else this.enqueue(e.clientX, e.clientY, now);
    this.lastPointer = now;
    this.wake();
  };

  private enqueue(x: number, y: number, t: number): void {
    const next = (this.qTail + 1) % QUEUE;
    if (next === this.qHead) return; // full: the frame loop is behind, drop the point
    const k = this.qTail * 3;
    this.queue[k] = x;
    this.queue[k + 1] = y;
    this.queue[k + 2] = t;
    this.qTail = next;
  }

  private onWheel = (e: WheelEvent): void => {
    if (this.stopping) return;
    this.disturb += Math.min(400, Math.abs(e.deltaY) + Math.abs(e.deltaX));
    this.wake();
  };

  private onResize = (): void => {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      if (!this.overlay) return;
      this.build(true);
      this.wake();
    }, 250);
  };

  private onVisibility = (): void => {
    this.visible = document.visibilityState === 'visible';
    if (!this.visible) {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.hasPrev = false;
    } else {
      this.wake();
    }
  };

  private wake(): void {
    if (this.raf || !this.overlay || !this.visible) return;
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  // --- the frame loop ----------------------------------------------------------

  private tick = (now: number): void => {
    this.raf = 0;
    if (!this.overlay || !this.g || !this.tex) return; // the texture task wakes us when it is ready
    const input = this.qHead !== this.qTail;
    const creeping = this.creepT < this.creepDur;
    const lively = input || this.runnerCount > 0 || !!this.app || this.disturb > 0;
    // Fog creeping in or breathing back is slow: half the frame rate is plenty.
    if (!lively && now - this.lastUpdate < 31) {
      this.raf = requestAnimationFrame(this.tick);
      return;
    }
    const dt = Math.min(0.05, Math.max(0.001, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.lastUpdate = now;
    this.simT += dt;
    if (creeping) this.creepT = Math.min(this.creepDur, this.creepT + dt);

    this.consumePointer();
    this.updateRunners(dt);
    this.updateApparition(dt);
    const busy = this.updateGrid(dt);
    this.draw();

    if (this.warmthShown > 0.86 && !this.stopping) {
      this.stop(); // the glass has warmed: the fog lets go
      return;
    }
    const settling = Math.abs(this.warmth - this.warmthShown) > 0.002 || this.beadCount > 0;
    if (busy || settling || this.qHead !== this.qTail || this.creepT < this.creepDur || this.runnerCount > 0 || this.app) {
      this.raf = requestAnimationFrame(this.tick);
    }
  };

  /** Advance the fog grid one step and write the mask. Returns true while anything is still changing. */
  private updateGrid(dt: number): boolean {
    const { T, order, rate, dens, wet } = this;
    const data = this.maskImg!.data;
    const simT = this.simT;
    const creeping = this.creepT < this.creepDur;
    const ce = smoothstep(0, 1, this.creepT / this.creepDur);
    const c = ce * 1.3 - 0.1;
    const reach = this.reduced ? 2.5 : 5.5; // front sharpness
    this.warmthShown += (this.warmth - this.warmthShown) * Math.min(1, dt * 0.6);
    const keep = 1 - smoothstep(0, 0.88, this.warmthShown);
    const shake = this.disturb > 0 ? Math.min(0.04, this.disturb * 0.00005) : 0;
    if (shake) {
      this.warmth = Math.min(1, this.warmth + shake * 0.25);
      this.disturb = 0;
    }
    const bloom = this.bloomMap;
    const benv = bloom ? this.bloomEnvelope() : 0;
    const bstr = this.look!.bloom;
    const { cols, rows, cell } = this.grid;
    let busy = 0;
    let mass = 0;
    let gx0 = cols;
    let gy0 = rows;
    let gx1 = -1;
    let gy1 = -1;
    for (let y = 0, i = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++, i++) {
        let d = dens[i];
        if (shake && d > 0.05) d = dens[i] = d * (1 - shake);
        if (d !== 1) {
          busy++;
          if (simT >= wet[i]) {
            if (d < 1) {
              // Logistic: condensation nucleates slowly, spreads, then settles. It breathes back in.
              d += rate[i] * (0.035 + d) * (1 - d) * dt;
              if (d > 0.997) d = 1;
            } else {
              d -= (d - 1) * 0.35 * dt;
              if (d < 1.004) d = 1;
            }
            dens[i] = d;
          }
        }
        let t = T[i];
        if (creeping) {
          let m = (c - order[i]) * reach;
          m = m <= 0 ? 0 : m >= 1 ? 1 : m * m * (3 - 2 * m);
          t *= m;
        }
        if (bloom) {
          const b = bloom[i] * benv * bstr;
          if (b > t) t = b;
        }
        let a = t * d * keep;
        if (a > 1) a = 1;
        mass += a;
        const v = (a * 255 + 0.5) | 0;
        const j = i * 4 + 3;
        if (data[j] !== v) {
          data[j] = v;
          if (x < gx0) gx0 = x;
          if (x > gx1) gx1 = x;
          if (y < gy0) gy0 = y;
          if (y > gy1) gy1 = y;
        }
      }
    }
    if (gx1 >= 0) {
      // Only the cells that changed go up, and only their part of the screen is redrawn.
      this.maskCtx!.putImageData(this.maskImg!, 0, 0, gx0, gy0, gx1 - gx0 + 1, gy1 - gy0 + 1);
      // The mask is upscaled with a cubic filter, so a cell reaches about two cells around it.
      this.markDirty((gx0 - 3) * cell, (gy0 - 3) * cell, (gx1 + 4) * cell, (gy1 + 4) * cell);
    }
    // Wiped nearly everything away at once: that counts as clearing the glass.
    if (!creeping && !this.app && mass < this.targetMass * 0.1 * keep && this.warmth < 0.95) {
      this.warmth = Math.max(this.warmth, 0.95);
    }
    return busy > 0;
  }

  private markDirty(x0: number, y0: number, x1: number, y1: number): void {
    if (x0 < this.dx0) this.dx0 = x0;
    if (y0 < this.dy0) this.dy0 = y0;
    if (x1 > this.dx1) this.dx1 = x1;
    if (y1 > this.dy1) this.dy1 = y1;
  }

  /** Redraw the dirty part of the screen: texture, masked by the fog grid, then the water on top. */
  private draw(): void {
    const g = this.g!;
    const vw = this.vw;
    const vh = this.vh;
    const { cols, rows, cell } = this.grid;
    this.prepareBeads();
    if (this.dx1 > this.dx0 && this.dy1 > this.dy0) {
      // Snap the clip to device pixels so the edges of a partial redraw never show.
      const s = this.canvas!.width / vw;
      const x0 = Math.floor(Math.max(0, this.dx0) * s) / s;
      const y0 = Math.floor(Math.max(0, this.dy0) * s) / s;
      const x1 = Math.ceil(Math.min(vw, this.dx1) * s) / s;
      const y1 = Math.ceil(Math.min(vh, this.dy1) * s) / s;
      g.save();
      g.beginPath();
      g.rect(x0, y0, x1 - x0, y1 - y0);
      g.clip();
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
      g.clearRect(x0, y0, x1 - x0, y1 - y0);
      g.drawImage(this.tex!, 0, 0, vw, vh);
      g.globalCompositeOperation = 'destination-in';
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'medium';
      g.drawImage(this.mask!, 0, 0, cols * cell, rows * cell);
      g.globalCompositeOperation = 'source-over';
      this.drawBeads(g);
      g.restore();
    }
    this.dx0 = this.dy0 = Infinity;
    this.dx1 = this.dy1 = -Infinity;
  }

  // --- wiping --------------------------------------------------------------------

  private consumePointer(): void {
    const q = this.queue;
    while (this.qHead !== this.qTail) {
      const k = this.qHead * 3;
      const x = q[k];
      const y = q[k + 1];
      const t = q[k + 2];
      this.qHead = (this.qHead + 1) % QUEUE;
      if (!this.hasPrev || t - this.p1t > 250) {
        // A new stroke: start here without connecting to wherever the pointer last was.
        this.hasPrev = true;
        this.p0x = this.p1x = x;
        this.p0y = this.p1y = y;
        this.p1t = t;
        this.speed = 0;
        this.streakPhase = this.rand() * 6.28;
        continue;
      }
      const step = Math.hypot(x - this.p1x, y - this.p1y);
      if (step < 0.5) continue;
      const v = step / Math.max(4, t - this.p1t) * 1000;
      this.speed += (v - this.speed) * 0.35;
      const want = 15 + 31 * smoothstep(150, 2600, this.speed);
      this.radius += (want - this.radius) * 0.3;
      // Smooth curve through the pointer path: midpoint to midpoint, the last point as control.
      const ax = (this.p0x + this.p1x) / 2;
      const ay = (this.p0y + this.p1y) / 2;
      const bx = (this.p1x + x) / 2;
      const by = (this.p1y + y) / 2;
      this.wipeCurve(ax, ay, this.p1x, this.p1y, bx, by);
      this.p0x = this.p1x;
      this.p0y = this.p1y;
      this.p1x = x;
      this.p1y = y;
      this.p1t = t;
    }
  }

  private wipeCurve(ax: number, ay: number, cx: number, cy: number, bx: number, by: number): void {
    const len = Math.hypot(cx - ax, cy - ay) + Math.hypot(bx - cx, by - cy);
    if (len < 0.01) return;
    const R = this.radius;
    const spacing = Math.max(this.grid.cell * 0.75, R * 0.22);
    const steps = Math.max(1, Math.ceil(len / spacing));
    let px = ax;
    let py = ay;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const u = 1 - t;
      const x = u * u * ax + 2 * u * t * cx + t * t * bx;
      const y = u * u * ay + 2 * u * t * cy + t * t * by;
      const dx = x - px;
      const dy = y - py;
      const dl = Math.hypot(dx, dy) || 1;
      this.stamp(x, y, R, dx / dl, dy / dl);
      this.afterStamp(x, y, R, dx / dl, dy / dl, dl);
      px = x;
      py = y;
    }
  }

  /** One dab of a fingertip: clears the middle in streaks, pushes fog into a rim around it. */
  private stamp(cx: number, cy: number, R: number, dirx: number, diry: number): void {
    const { cols, rows, cell } = this.grid;
    const { dens, wet, T } = this;
    const outer = R * 1.3;
    const x0 = Math.max(0, Math.floor((cx - outer) / cell));
    const x1 = Math.min(cols - 1, Math.ceil((cx + outer) / cell));
    const y0 = Math.max(0, Math.floor((cy - outer) / cell));
    const y1 = Math.min(rows - 1, Math.ceil((cy + outer) / cell));
    const hold = this.simT + WET_HOLD;
    const phase = this.streakPhase;
    let removed = 0;
    for (let gy = y0; gy <= y1; gy++) {
      const dy = (gy + 0.5) * cell - cy;
      for (let gx = x0; gx <= x1; gx++) {
        const dx = (gx + 0.5) * cell - cx;
        const r = Math.sqrt(dx * dx + dy * dy) / R;
        if (r >= 1.3) continue;
        const i = gy * cols + gx;
        const d = dens[i];
        if (r < 1) {
          const e = r < 0.66 ? 1 : 1 - smoothstep(0.66, 1, r);
          // Skin leaves streaks along the direction of the stroke.
          const perp = -dx * diry + dy * dirx;
          const streak = 0.78 + 0.22 * Math.sin(perp * 0.62 + phase);
          // A thin film survives in some of the streaks, so a wipe never looks painted on.
          const film = 0.5 + 0.5 * Math.sin(perp * 0.29 + phase * 1.7);
          const nd = Math.min(d, Math.max(Math.min(1, d) * (1 - 0.6 * e * streak), e * 0.22 * film * film));
          if (nd < d) {
            removed += (d - nd) * T[i];
            dens[i] = nd;
          }
          if (e > 0.15 && wet[i] < hold) wet[i] = hold;
        } else if (d > 0.6 && d < 1.22) {
          const k = 1 - (r - 1) / 0.3;
          dens[i] = Math.min(1.22, d + 0.035 * k * k);
        }
      }
    }
    if (removed > 0) this.warmth = Math.min(1, this.warmth + (removed / this.targetMass) * WARM_GAIN);
  }

  /** Water squeezed to the sides of a wipe: beads along the rims, the odd drop that runs. */
  private afterStamp(x: number, y: number, R: number, dirx: number, diry: number, dl: number): void {
    if (this.fogAt(x, y) < 0.08) return;
    this.travel += dl;
    while (this.travel > 4.5) {
      this.travel -= 4.5;
      if (this.rand() < 0.5) {
        const side = this.rand() < 0.5 ? 1 : -1;
        const nx = -diry * side;
        const ny = dirx * side;
        const off = R * (0.96 + this.rand() * 0.26);
        const along = (this.rand() - 0.5) * 6;
        const below = ny > 0.3 ? 1.35 : 1; // gravity: bigger beads gather on the lower rim
        this.addBead(x + nx * off + dirx * along, y + ny * off + diry * along, (0.6 + this.rand() ** 3 * 2.3) * below);
      }
    }
    this.runnerCooldown -= 1;
    if (!this.reduced && Math.abs(dirx) > 0.45 && this.runnerCooldown <= 0 && this.rand() < 0.012) {
      this.addRunner(x + (this.rand() - 0.5) * R, y + R * 0.98, 1.7 + this.rand() * 1.1);
      this.runnerCooldown = 30;
    }
  }

  private fogAt(x: number, y: number): number {
    const { cols, rows, cell } = this.grid;
    const gx = Math.min(cols - 1, Math.max(0, (x / cell) | 0));
    const gy = Math.min(rows - 1, Math.max(0, (y / cell) | 0));
    const i = gy * cols + gx;
    const bloom = this.bloomMap ? this.bloomMap[i] * this.look!.bloom : 0;
    return Math.max(this.T[i], bloom);
  }

  // --- beads and runners -------------------------------------------------------------

  private addBead(x: number, y: number, r: number): void {
    const i = this.bNext;
    this.bNext = (i + 1) % MAX_BEADS;
    if (!this.bLive[i]) this.beadCount++;
    this.bx[i] = x;
    this.by[i] = y;
    this.br[i] = r;
    this.bt[i] = this.simT;
    this.bl[i] = 8 + this.rand() * 8;
    this.bLive[i] = 1;
  }

  private addRunner(x: number, y: number, r: number): void {
    for (let i = 0; i < MAX_RUNNERS; i++) {
      if (this.rLive[i]) continue;
      this.rx[i] = x;
      this.ry[i] = y;
      this.rr[i] = r;
      this.rv[i] = 22 + this.rand() * 30;
      this.rPhase[i] = this.rand() * 6;
      this.rLeft[i] = 50 + this.rand() * 220;
      this.rLive[i] = 1;
      this.runnerCount++;
      return;
    }
  }

  private updateRunners(dt: number): void {
    if (!this.runnerCount) return;
    for (let i = 0; i < MAX_RUNNERS; i++) {
      if (!this.rLive[i]) continue;
      // Stick and slip: a drop hesitates, gathers, then lurches on.
      this.rPhase[i] += dt * (2.2 + this.rr[i] * 0.4);
      const s = Math.sin(this.rPhase[i]);
      const v = this.rv[i] * (0.15 + 0.85 * (s > 0 ? s * s : 0));
      const dy = v * dt;
      this.ry[i] += dy;
      this.rx[i] += (this.rand() - 0.5) * dy * 0.25;
      this.rLeft[i] -= dy;
      this.trail(this.rx[i], this.ry[i], this.rr[i]);
      if (this.rLeft[i] <= 0 || this.ry[i] > this.vh + 10) {
        this.rLive[i] = 0;
        this.runnerCount--;
        if (this.ry[i] < this.vh) this.addBead(this.rx[i], this.ry[i], this.rr[i] * 1.15);
      }
    }
  }

  /** The thin clear channel a running drop leaves behind. */
  private trail(x: number, y: number, r: number): void {
    const { cols, rows, cell } = this.grid;
    const { dens, wet } = this;
    const hold = this.simT + WET_HOLD * 2.5;
    const reachPx = Math.max(cell * 0.9, r * 1.6);
    const gx0 = Math.max(0, Math.floor((x - reachPx) / cell));
    const gx1 = Math.min(cols - 1, Math.floor((x + reachPx) / cell));
    const gy0 = Math.max(0, Math.floor((y - reachPx) / cell));
    const gy1 = Math.min(rows - 1, Math.floor((y + reachPx) / cell));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const dx = (gx + 0.5) * cell - x;
        const dy = (gy + 0.5) * cell - y;
        const k = 1 - Math.hypot(dx, dy * 0.7) / reachPx;
        if (k <= 0) continue;
        const i = gy * cols + gx;
        const target = 1 - Math.min(1, k * 1.6) * 0.92;
        if (dens[i] > target) dens[i] = target;
        if (wet[i] < hold) wet[i] = hold;
      }
    }
  }

  /** Retire dried-up beads and mark where water changed, so that part gets redrawn. */
  private prepareBeads(): void {
    if (this.beadCount) {
      for (let i = 0; i < MAX_BEADS; i++) {
        if (!this.bLive[i]) continue;
        const age = this.simT - this.bt[i];
        const life = this.bl[i];
        const changing = age < 0.4 || age > life * 0.55;
        if (age > life) {
          this.bLive[i] = 0;
          this.beadCount--;
        }
        if (changing) {
          const r = this.br[i] + 2;
          this.markDirty(this.bx[i] - r, this.by[i] - r, this.bx[i] + r, this.by[i] + r);
        }
      }
    }
    for (let i = 0; i < MAX_RUNNERS; i++) {
      if (!this.rLive[i]) continue;
      const r = this.rr[i] + 3;
      this.markDirty(this.rx[i] - r - 2, this.ry[i] - r * 1.2 - 12, this.rx[i] + r + 2, this.ry[i] + r * 1.2 + 2);
    }
  }

  private drawBeads(g: CanvasRenderingContext2D): void {
    const sprite = this.sprite!;
    const keep = 1 - smoothstep(0.2, 0.88, this.warmthShown);
    if (this.beadCount) {
      for (let i = 0; i < MAX_BEADS; i++) {
        if (!this.bLive[i]) continue;
        const age = this.simT - this.bt[i];
        const x = this.bx[i];
        const y = this.by[i];
        const life = this.bl[i];
        // Beads well out in clear glass slowly dry; the rest are misted over as the fog returns.
        const grow = age < 0.35 ? age / 0.35 : 1;
        const a = grow * (1 - smoothstep(life * 0.55, life, age)) * keep;
        if (a < 0.02) continue;
        const r = this.br[i] * (0.6 + 0.4 * grow);
        g.globalAlpha = a;
        g.drawImage(sprite, x - r, y - r, r * 2, r * 2);
      }
    }
    for (let i = 0; i < MAX_RUNNERS; i++) {
      if (!this.rLive[i]) continue;
      const r = this.rr[i];
      g.globalAlpha = 0.95 * keep;
      g.drawImage(sprite, this.rx[i] - r, this.ry[i] - r * 1.2, r * 2, r * 2.4);
    }
    g.globalAlpha = 1;
  }

  // --- the visitor -------------------------------------------------------------------

  private scheduleApparition(ms: number): void {
    clearTimeout(this.appTimer);
    this.appTimer = window.setTimeout(() => {
      this.appTimer = undefined;
      if (!this.overlay || this.stopping || this.appUsed) return;
      const idle = performance.now() - this.lastPointer > 2500;
      if (!this.visible || !idle || this.creepT < this.creepDur || this.warmth > 0.5) {
        if (++this.appTries < 12) this.scheduleApparition(2500);
        return;
      }
      this.beginApparition();
    }, ms);
  }

  private beginApparition(): void {
    this.appUsed = true;
    const vw = this.vw;
    const vh = this.vh;
    const short = Math.min(vw, vh);
    const word = this.rand() < 0.5;
    const size = word ? Math.max(54, Math.min(96, short * 0.1)) : Math.max(150, Math.min(250, short * 0.32));
    const halfW = word ? size * 2.3 : size * 0.45;
    const halfH = word ? size * 0.6 : size * 0.55;
    // Somewhere in the fog, away from the pointer.
    const spots: [number, number][] = [
      [0.24, 0.28], [0.76, 0.28], [0.25, 0.72], [0.75, 0.72],
    ];
    let best: [number, number] = spots[0];
    let bestScore = -1;
    for (const [fx, fy] of spots) {
      const x = fx * vw;
      const y = fy * vh;
      // Thick fog shows the mark best; a spot right under the pointer would give it away.
      const score = (200 + Math.hypot(x - this.p1x, y - this.p1y)) * (0.3 + this.fogAt(x, y)) * (0.75 + this.rand() * 0.5);
      if (score > bestScore) {
        bestScore = score;
        best = [x, y];
      }
    }
    const cx = Math.max(halfW + 24, Math.min(vw - halfW - 24, best[0]));
    const cy = Math.max(halfH + 24, Math.min(vh - halfH - 24, best[1]));
    const grid = this.grid;
    const imp = word
      ? buildWord(this.rand() < 0.5 ? 'LEAVE' : 'HERE', cx, cy, size, grid, this.rand)
      : buildHand(cx, cy + size * 0.1, size, grid, this.rand);
    if (this.reduced) {
      // No tracing or pressing motion: the mark simply fades into view.
      imp.D.fill(0);
      imp.maxD = 0;
      imp.press = 3;
      imp.drips = [];
      for (let i = 2; i < imp.beads.length; i += 4) imp.beads[i] = 1 + (i % 7) * 0.2;
    }
    this.app = imp;
    this.appT = 0;
    this.appBead = 0;
    this.appDrip = 0;
    // Breath on the other side of the glass blooms first, so the mark has fog to show in.
    const bloom = new Float32Array(this.T.length);
    const noise = this.noise!;
    const rx = imp.rx + 70;
    const ry = imp.ry + 60;
    const { cols, rows, cell } = grid;
    const gx0 = Math.max(0, Math.floor((imp.cx - rx * 1.3) / cell));
    const gx1 = Math.min(cols - 1, Math.ceil((imp.cx + rx * 1.3) / cell));
    const gy0 = Math.max(0, Math.floor((imp.cy - ry * 1.3) / cell));
    const gy1 = Math.min(rows - 1, Math.ceil((imp.cy + ry * 1.3) / cell));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const px = (gx + 0.5) * cell;
        const py = (gy + 0.5) * cell;
        const q = Math.hypot((px - imp.cx) / rx, (py - imp.cy) / ry) * (0.8 + 0.4 * noise.fbm(px / 70, py / 70, 3));
        bloom[gy * cols + gx] = (1 - smoothstep(0.5, 1.05, q)) * (0.85 + 0.15 * noise.at(px / 25, py / 25));
      }
    }
    this.bloomMap = bloom;
    this.appRelease = 2.6 + imp.maxD + imp.press + 3.2;
    this.wake();
  }

  private bloomEnvelope(): number {
    const t = this.appT;
    const rise = this.reduced ? 4 : 2.6;
    if (t < this.appRelease + 2) return smoothstep(0, rise, t);
    return 1 - smoothstep(this.appRelease + 2, this.appRelease + 12, t);
  }

  private updateApparition(dt: number): void {
    const imp = this.app;
    if (!imp) return;
    this.appT += dt;
    const t = this.appT - 2.6; // press begins once the breath has bloomed
    if (t > 0 && this.appT < this.appRelease) {
      const { cols } = this.grid;
      const { dens, wet } = this;
      const hold = this.simT + 1.2;
      for (let y = 0; y < imp.h; y++) {
        for (let x = 0; x < imp.w; x++) {
          const j = y * imp.w + x;
          const s = imp.S[j];
          if (s <= 0) continue;
          let p = (t - imp.D[j]) / imp.press;
          if (p <= 0) continue;
          p = p >= 1 ? 1 : p * p * (3 - 2 * p);
          const i = (imp.y0 + y) * cols + imp.x0 + x;
          const target = 1 - s * p * 0.96;
          if (dens[i] > target) dens[i] = target;
          if (wet[i] < hold) wet[i] = hold;
        }
      }
      const b = imp.beads;
      while (this.appBead < b.length && b[this.appBead + 2] <= t) {
        this.addBead(b[this.appBead], b[this.appBead + 1], b[this.appBead + 3]);
        this.appBead += 4;
      }
      const dr = imp.drips;
      while (this.appDrip < dr.length && dr[this.appDrip + 2] <= t) {
        this.addRunner(dr[this.appDrip], dr[this.appDrip + 1], dr[this.appDrip + 3]);
        this.appDrip += 4;
      }
    }
    if (this.appT > this.appRelease + 12.5) {
      this.app = null;
      this.bloomMap = null;
    }
  }
}

/** Fog is lighter than a dark page and a touch greyer than a white one, so it shows on both. */
function pickLook(): Look {
  let dark: boolean | null = null;
  // Let the browser resolve the colour (it may be oklch(), lab(), color()...) by painting it.
  const probe = document.createElement('canvas');
  probe.width = probe.height = 1;
  const pg = probe.getContext('2d', { willReadFrequently: true });
  for (const el of [document.body, document.documentElement]) {
    if (!el || !pg) continue;
    const value = getComputedStyle(el).backgroundColor;
    pg.clearRect(0, 0, 1, 1);
    pg.fillStyle = 'rgba(0,0,0,0)';
    pg.fillStyle = value;
    pg.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = pg.getImageData(0, 0, 1, 1).data;
    if (a < 128) continue; // transparent (or only a background image): keep looking further out
    dark = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.45;
    break;
  }
  if (dark === null) {
    const scheme = getComputedStyle(document.documentElement).colorScheme || '';
    dark = scheme.includes('dark') && matchMedia('(prefers-color-scheme: dark)').matches;
  }
  return dark
    ? { palette: { dark, lo: [104, 114, 126], hi: [196, 204, 214] }, edgeCap: 0.7, bloom: 0.66 }
    : { palette: { dark, lo: [186, 195, 206], hi: [242, 245, 249] }, edgeCap: 0.9, bloom: 0.94 };
}
