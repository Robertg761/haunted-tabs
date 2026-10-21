// Fogged glass: frost creeps in from the edges; moving the mouse wipes clear streaks that slowly mist over again.
//
// How it works: a low-resolution density grid (one cell per 4-8 CSS px) says how
// much fog is where. A fog texture (haze, grain, droplets, rime, ice crystals) is
// drawn once at CSS pixel size, in small tasks, then masked by the grid and upscaled
// smoothly. The screen is split into canvas tiles and only the changed part of the
// changed tiles is redrawn, so a wipe or a creeping front never repaints the whole
// viewport. Global fades (the fog appearing, the glass warming, the final fade) are
// CSS opacity on the layer, which the compositor does for free.
// The pointer wipes the grid with a soft, streaky brush; wiped cells stay wet for a
// moment, then breathe back in along a logistic curve, and a darker wet edge marks
// where the fog was pushed aside. Beads of water collect on the rims of wiped areas,
// and now and then one runs down, leaving a clear, wandering trail.
// Wiping (and, more slowly, working on the page) warms the glass: the fog thins and
// lifts. The animation sleeps whenever nothing is changing and while the tab is hidden.

import type { Effect, EffectContext } from './types';
import { createOverlay, OUR_ATTR, seeded, type Overlay } from './overlay';
import {
  buildHand, buildWord, clamp01, coarseField, dropSprite, fogTextureJob, Noise, smoothstep,
  type Grid, type Imprint, type Palette, type Rand,
} from './fog-art';

const TILE = 256;
/** At most this many tiles are repainted per frame; the rest wait their turn, oldest first. */
const TILE_BUDGET = 10;
/** Full tiles redrawn off-screen per frame while a batch is under way (batches continue every frame). */
const BATCH_BUDGET = 5;
const MAX_BEADS = 720;
const MAX_RUNNERS = 10;
const QUEUE = 256;
/** How long fresh wipes stay clear before fog starts to come back, in seconds. */
const WET_HOLD = 0.9;
/** Regrowth rate: with the logistic curve below, a fully wiped cell is back in ~8-15 s. */
const REGROW = 0.45;
/** How much the glass warms per fog-load wiped away. About four loads clear it. */
const WARM_GAIN = 0.22;
/** Frame spacing: slow processes (creep, re-fog) at ~20 fps, drops and apparitions at ~30. */
const SLOW_MS = 48;
const MID_MS = 31;
/** Left alone, the fog starts lifting after this long and is gone about 70 s later. */
const LIFT_AFTER_MS = 40_000;
const LIFT_STEP = 5 / 78;

/** Per stage: how far the fog reaches in from the bottom (fraction of the short side) and how thick the middle gets. */
const REACH = [0, 0.2, 0.27, 0.36, 0.47];
const CENTRE = [0, 0, 0.035, 0.09, 0.14];
/**
 * The top of the pane frosts least (warm air rises), and that is where sticky headers
 * and navigation live: below a thin rime line, fog in the top band is capped so header
 * text keeps at least 3:1 contrast, feathering back to full strength further down.
 */
const TOP_BAND = 64;
const TOP_FEATHER = 64;
const RIME_LINE = 6;

/** The most fog allowed at height y (CSS px) for a page whose band cap is `cap`. */
function topCap(y: number, cap: number): number {
  if (y < RIME_LINE) return Math.max(cap, 0.6 - (0.6 - cap) * smoothstep(0, RIME_LINE, y));
  if (y < TOP_BAND) return cap;
  return cap + (1 - cap) * smoothstep(TOP_BAND, TOP_BAND + TOP_FEATHER, y);
}

interface Look {
  palette: Palette;
  edgeCap: number;
  /** Fog cap over the header band: light pages need far less fog for the same contrast loss. */
  topCap: number;
  bloom: number;
  rim: string;
  rimAlpha: number;
}

/** A tile has two canvases: the one on show, and a hidden one for batched redraws that flip in all at once. */
interface Tile {
  cv: [HTMLCanvasElement, HTMLCanvasElement];
  gs: [CanvasRenderingContext2D, CanvasRenderingContext2D];
  cur: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

// Cheap 1D value noise for the streaks a hand leaves on glass.
const N1 = (() => {
  const r = seeded(0x5eed);
  return Float32Array.from({ length: 256 }, () => r());
})();
function noise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = N1[i & 255];
  return a + (N1[(i + 1) & 255] - a) * f * f * (3 - 2 * f);
}

export class Fog implements Effect {
  readonly name = 'fog' as const;

  private overlay: Overlay | null = null;
  private tiles: Tile[] = [];
  private tcols = 0;
  private trows = 0;
  private tdirty = new Float32Array(0); // per tile: x0, y0, x1, y1 in CSS px
  private tcell = new Int32Array(0); // per tile: changed cell box this frame
  private tileOfCol = new Uint16Array(0);
  private tileOfRow = new Uint16Array(0);
  private tex: HTMLCanvasElement | null = null;
  private texJob: { canvas: HTMLCanvasElement; steps: (() => void)[] } | null = null;
  private sprite: HTMLCanvasElement | null = null;
  private mask: HTMLCanvasElement | null = null;
  private maskCtx: CanvasRenderingContext2D | null = null;
  private maskImg: ImageData | null = null;
  private rimCanvas: HTMLCanvasElement | null = null;
  private rimCtx: CanvasRenderingContext2D | null = null;
  private rimImg: ImageData | null = null;

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
  private T: Float32Array = new Float32Array(0); // target opacity per cell
  private order: Float32Array = new Float32Array(0); // when the creeping front reaches the cell (0..1)
  private rate: Float32Array = new Float32Array(0); // regrowth rate per cell
  private dens = new Float32Array(0); // 0 = wiped clear, 1 = fogged, up to ~1.22 on pushed rims
  private wet = new Float32Array(0); // sim time until which a wiped cell stays clear
  private bloomMap: Float32Array | null = null;
  private Tfrom: Float32Array | null = null; // stage change: blend from these targets...
  private Tto: Float32Array | null = null; // ...to these
  private blendT = 0;
  private targetMass = 1;

  // Time and state.
  private simT = 0;
  private creepT = 0;
  private creepDur = 4.5;
  private warmth = 0;
  private opacityNow = -1;
  private revealed = false;
  private raf = 0;
  private lastFrame = 0;
  private lastUpdate = 0;
  private stopping = false;
  private stopTimer: number | undefined;
  private appTimer: number | undefined;
  private ambientTimer: number | undefined;
  private resizeTimer: number | undefined;
  private texTimer: number | undefined;
  private jobTimer: number | undefined;
  private themeTimer: number | undefined;
  private themeObserver: MutationObserver | null = null;
  private scheme: MediaQueryList | null = null;
  private jobId = 0;
  private tilesPending = false;
  private rimCount = new Int32Array(0);
  // A batch: tiles being redrawn off-screen from a frozen copy of the masks, shown together when done.
  private batch = new Int32Array(0);
  private batchLen = 0;
  private batchPos = 0;
  private snapMask: HTMLCanvasElement | null = null;
  private snapRim: HTMLCanvasElement | null = null;
  private visible = true;
  private ageStarted = 0;
  private lastWork = 0;

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
  private strokeLen = 0;
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
  private rx0 = new Float32Array(MAX_RUNNERS);
  private rr = new Float32Array(MAX_RUNNERS);
  private rr0 = new Float32Array(MAX_RUNNERS);
  private rv = new Float32Array(MAX_RUNNERS);
  private rPhase = new Float32Array(MAX_RUNNERS);
  private rLen = new Float32Array(MAX_RUNNERS);
  private rTrav = new Float32Array(MAX_RUNNERS);
  private rWander = new Float32Array(MAX_RUNNERS);
  private rFreq = new Float32Array(MAX_RUNNERS);
  private rWph = new Float32Array(MAX_RUNNERS);
  private rNextBead = new Float32Array(MAX_RUNNERS);
  private rLive = new Uint8Array(MAX_RUNNERS);
  private runnerCount = 0;

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
      // Coming back while fogged, or while the fog is fading out: carry on from here, never duplicate.
      this.cancelStop();
      this.warmth = Math.min(this.warmth, 0.2);
      this.applyOpacity(1.2);
      if (stage > this.stage) this.raiseStage(stage);
      this.wake();
      return;
    }
    this.stage = stage;
    this.seed = ctx.seed >>> 0;
    this.rand = seeded(this.seed ^ 0x0f06f06);
    this.noise = new Noise(seeded(this.seed ^ 0x51a7e));
    this.creepDur = this.reduced ? 5.5 : 3.6 + this.rand() * 2.2;
    this.look = pickLook();
    this.simT = this.creepT = this.warmth = 0;
    this.qHead = this.qTail = this.appTries = 0;
    this.hasPrev = this.appUsed = this.stopping = this.revealed = false;
    this.lastPointer = -1e9;
    this.opacityNow = -1;
    this.ageStarted = this.lastWork = performance.now();

    this.overlay = createOverlay(this.name, '.layer { opacity: 0; } canvas { position: absolute; }');
    this.sprite = dropSprite();
    this.mask = document.createElement('canvas');
    this.maskCtx = this.mask.getContext('2d');
    this.rimCanvas = document.createElement('canvas');
    this.rimCtx = this.rimCanvas.getContext('2d');
    this.snapMask = document.createElement('canvas');
    this.snapRim = document.createElement('canvas');
    this.build(false);

    addEventListener('pointermove', this.onPointer, { passive: true });
    addEventListener('pointerdown', this.onWork, { passive: true });
    addEventListener('keydown', this.onWork, { passive: true });
    addEventListener('wheel', this.onWheel, { passive: true });
    addEventListener('resize', this.onResize, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibility);
    this.visible = document.visibilityState === 'visible';
    // Follow the page if it switches between light and dark: pale fog on a page gone dark would bury its text.
    this.themeObserver = new MutationObserver(this.onTheme);
    const themeOpts = { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'data-bs-theme'] };
    this.themeObserver.observe(document.documentElement, themeOpts);
    if (document.body) this.themeObserver.observe(document.body, themeOpts);
    this.scheme = matchMedia('(prefers-color-scheme: dark)');
    this.scheme.addEventListener('change', this.onTheme);

    // Left alone, the glass slowly warms up and the fog lifts by itself within a couple of minutes.
    this.ambientTimer = window.setInterval(() => {
      if (!this.visible || this.stopping || this.app) return;
      if (performance.now() - this.ageStarted < LIFT_AFTER_MS) return;
      this.warm(LIFT_STEP);
    }, 5000);

    if (this.stage >= 3) this.rollApparition();
    this.wake();
  }

  stop(): void {
    if (!this.overlay || this.stopping) return;
    this.stopping = true;
    const s = this.overlay.layer.style;
    s.transition = 'opacity 1.2s ease-in-out';
    s.opacity = '0';
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
    clearTimeout(this.jobTimer);
    clearTimeout(this.themeTimer);
    clearInterval(this.ambientTimer);
    this.stopTimer = this.appTimer = this.resizeTimer = this.texTimer = this.jobTimer = this.ambientTimer = this.themeTimer = undefined;
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    this.scheme?.removeEventListener('change', this.onTheme);
    this.scheme = null;
    this.jobId++;
    removeEventListener('pointermove', this.onPointer);
    removeEventListener('pointerdown', this.onWork);
    removeEventListener('keydown', this.onWork);
    removeEventListener('wheel', this.onWheel);
    removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    // Release the bitmaps now rather than whenever the garbage collector gets to them.
    for (const t of this.tiles) for (const c of t.cv) c.width = c.height = 0;
    for (const c of [this.tex, this.texJob?.canvas, this.mask, this.rimCanvas, this.snapMask, this.snapRim]) if (c) c.width = c.height = 0;
    this.overlay?.remove();
    this.overlay = null;
    this.tiles = [];
    this.tex = this.sprite = this.mask = this.rimCanvas = this.snapMask = this.snapRim = null;
    this.maskCtx = this.rimCtx = null;
    this.texJob = null;
    this.maskImg = this.rimImg = null;
    this.app = null;
    this.bloomMap = this.Tfrom = this.Tto = null;
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
    this.opacityNow = -1;
  }

  /** The layer's opacity carries every global fade: fog appearing, the glass warming. */
  private applyOpacity(seconds: number, ease = 'ease-in-out'): void {
    if (!this.overlay || this.stopping || !this.revealed) return;
    const target = 1 - 0.62 * smoothstep(0, 0.9, this.warmth);
    if (Math.abs(target - this.opacityNow) < 0.02) return;
    this.opacityNow = target;
    const s = this.overlay.layer.style;
    s.transition = `opacity ${seconds}s ${ease}`;
    s.opacity = target.toFixed(3);
  }

  private warm(amount: number): void {
    this.warmth = Math.min(1, this.warmth + amount);
    if (this.warmth >= 0.9) this.stop(); // the glass has warmed: the fog lets go
    else this.applyOpacity(2.5);
  }

  // --- building ----------------------------------------------------------------

  /** Size the grid and the tiles to the viewport and work out where the fog wants to be. */
  private build(keep: boolean): void {
    const vw = Math.max(1, innerWidth);
    const vh = Math.max(1, innerHeight);
    const cell = Math.max(4, Math.min(8, Math.round(Math.sqrt((vw * vh) / 60000))));
    const cols = Math.ceil(vw / cell) + 1;
    const rows = Math.ceil(vh / cell) + 1;
    const n = cols * rows;
    const old = keep ? { dens: this.dens, wet: this.wet, cols: this.grid.cols, rows: this.grid.rows, vw: this.vw, vh: this.vh } : null;

    const oldT = keep ? { T: this.T, order: this.order, rate: this.rate } : null;
    this.vw = vw;
    this.vh = vh;
    this.grid = { cols, rows, cell };
    this.dens = new Float32Array(n).fill(1);
    this.wet = new Float32Array(n);
    this.bloomMap = this.Tfrom = this.Tto = null;
    this.app = null;
    // Until the new targets are worked out (in short slices), stand in with the old ones or nothing.
    this.T = new Float32Array(n);
    this.order = new Float32Array(n).fill(1);
    this.rate = new Float32Array(n).fill(REGROW);

    if (old) {
      // Carry the wiped state and the water across a resize.
      for (let y = 0; y < rows; y++) {
        const oy = Math.min(old.rows - 1, Math.floor((y * old.rows) / rows));
        for (let x = 0; x < cols; x++) {
          const j = oy * old.cols + Math.min(old.cols - 1, Math.floor((x * old.cols) / cols));
          if (j < old.dens.length) {
            const i = y * cols + x;
            this.dens[i] = old.dens[j];
            this.wet[i] = old.wet[j];
            if (oldT && j < oldT.T.length) {
              this.T[i] = oldT.T[j];
              this.order[i] = oldT.order[j];
              this.rate[i] = oldT.rate[j];
            }
          }
        }
      }
      const sx = vw / Math.max(1, old.vw);
      const sy = vh / Math.max(1, old.vh);
      for (let i = 0; i < MAX_BEADS; i++) {
        this.bx[i] *= sx;
        this.by[i] *= sy;
      }
      for (let i = 0; i < MAX_RUNNERS; i++) {
        this.rx[i] *= sx;
        this.rx0[i] *= sx;
        this.ry[i] *= sy;
      }
    }

    this.mask!.width = this.rimCanvas!.width = this.snapMask!.width = this.snapRim!.width = cols;
    this.mask!.height = this.rimCanvas!.height = this.snapMask!.height = this.snapRim!.height = rows;
    this.maskImg = this.maskCtx!.createImageData(cols, rows);
    this.rimImg = this.rimCtx!.createImageData(cols, rows);
    const [rr, rg, rb] = this.look!.rim.split(',').map(Number);
    const md = this.maskImg.data;
    const rd = this.rimImg.data;
    for (let i = 0; i < md.length; i += 4) {
      md[i] = md[i + 1] = md[i + 2] = 255;
      rd[i] = rr;
      rd[i + 1] = rg;
      rd[i + 2] = rb;
    }
    this.layoutTiles();
    this.targetsJob(this.stage, (T, order, rate, mass) => {
      this.T = T;
      this.order = order;
      this.rate = rate;
      this.targetMass = mass;
      this.runTexture();
    });
  }

  /**
   * Target opacity per cell: thick in the corners and along the bottom, thinner at the
   * top (condensation gathers low on a pane, and the page's navigation lives up there),
   * never more than ~22% of the width in from the sides. Also the creep order and the
   * regrowth rates. Noise is sampled on a coarse lattice and interpolated, and the work
   * runs in ~8 ms slices so arriving on the tab never stalls.
   */
  private targetsJob(stage: number, done: (T: Float32Array, order: Float32Array, rate: Float32Array, mass: number) => void): void {
    clearTimeout(this.jobTimer);
    const id = ++this.jobId;
    const noise = this.noise!;
    const look = this.look!;
    const { cols, rows, cell } = this.grid;
    const vw = this.vw;
    const vh = this.vh;
    const n = cols * rows;
    const short = Math.min(vw, vh);
    const reachBottom = REACH[stage] * short + 40;
    const reachTop = reachBottom * 0.6;
    const reachSide = Math.min(reachBottom, 0.22 * vw + 20);
    const centre = CENTRE[stage] * (look.palette.dark ? 0.85 : 1);
    const cap = look.edgeCap;
    const T = new Float32Array(n);
    const order = new Float32Array(n);
    const rate = new Float32Array(n);
    let low: Float32Array | null = null;
    let mid: Float32Array | null = null;
    let rnd: Float32Array | null = null;
    let mass = 0;
    let y = 0;
    const work = (): boolean => {
      if (!low) low = coarseField(cols, rows, 8, (x, y) => noise.fbm((x * cell) / 340, (y * cell) / 340, 3));
      else if (!mid) mid = coarseField(cols, rows, 3, (x, y) => noise.fbm((x * cell) / 90 + 11, (y * cell) / 90 - 7, 2));
      else if (!rnd) rnd = coarseField(cols, rows, 3, (x, y) => noise.at((x * cell) / 60 - 50, (y * cell) / 60 + 20));
      else {
        const end = Math.min(rows, y + 8);
        for (; y < end; y++) {
          const py = (y + 0.5) * cell;
          const ny = Math.max(0.004, Math.min(py / reachTop, (vh - py) / reachBottom));
          const ay = 1 / (ny * ny);
          const capY = Math.min(cap, topCap(py, look.topCap));
          for (let x = 0, i = y * cols; x < cols; x++, i++) {
            const px = (x + 0.5) * cell;
            const nx = Math.max(0.004, Math.min(px, vw - px) / reachSide);
            // Distance to the frame in units of reach, rounded off at the corners; corners also reach further in.
            const ax = 1 / (nx * nx);
            const d = 1 / Math.sqrt(Math.sqrt(ax * ax + ay * ay));
            const corner = (1 - clamp01(nx / 1.8)) * (1 - clamp01(ny / 1.8));
            const lim = (0.62 + 0.8 * low[i]) * (1 + 0.6 * corner);
            const f = clamp01(1 - d / lim);
            const s0 = f * f * (3 - 2 * f);
            const t = Math.min(capY, (centre + (cap - centre) * s0 * Math.sqrt(Math.sqrt(s0))) * (0.86 + 0.2 * mid[i]));
            T[i] = t;
            mass += t;
            order[i] = clamp01(d / (lim * 1.1)) * 0.86 + mid[i] * 0.14;
            rate[i] = REGROW * (0.7 + 0.6 * rnd[i]);
          }
        }
        if (y >= rows) {
          done(T, order, rate, Math.max(1, mass));
          return true;
        }
      }
      return false;
    };
    const run = () => {
      this.jobTimer = undefined;
      if (!this.overlay || id !== this.jobId) return;
      const t0 = performance.now();
      do {
        if (work()) return;
      } while (performance.now() - t0 < 8);
      this.jobTimer = window.setTimeout(run, 0);
    };
    this.jobTimer = window.setTimeout(run, 0);
  }

  /** Split the overlay into canvas tiles at CSS pixel size, so a change repaints only its own tiles. */
  private layoutTiles(): void {
    const layer = this.overlay!.layer;
    for (const t of this.tiles) {
      for (const c of t.cv) {
        c.width = c.height = 0;
        c.remove();
      }
    }
    this.tiles = [];
    const vw = this.vw;
    const vh = this.vh;
    this.tcols = Math.ceil(vw / TILE);
    this.trows = Math.ceil(vh / TILE);
    for (let ty = 0; ty < this.trows; ty++) {
      for (let tx = 0; tx < this.tcols; tx++) {
        const x = tx * TILE;
        const y = ty * TILE;
        const w = Math.min(TILE, vw - x);
        const h = Math.min(TILE, vh - y);
        const make = (shown: boolean) => {
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          c.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;visibility:${shown ? 'visible' : 'hidden'};`;
          layer.appendChild(c);
          return c;
        };
        const a = make(true);
        const b = make(false);
        this.tiles.push({ cv: [a, b], gs: [a.getContext('2d')!, b.getContext('2d')!], cur: 0, x, y, w, h });
      }
    }
    const nt = this.tiles.length;
    this.tdirty = new Float32Array(nt * 4);
    this.tcell = new Int32Array(nt * 4);
    this.rimCount = new Int32Array(nt);
    this.batch = new Int32Array(nt);
    this.batchLen = this.batchPos = 0;
    for (let k = 0; k < nt; k++) this.clearTileDirty(k);
    const { cols, rows, cell } = this.grid;
    this.tileOfCol = new Uint16Array(cols);
    this.tileOfRow = new Uint16Array(rows);
    for (let x = 0; x < cols; x++) this.tileOfCol[x] = Math.min(this.tcols - 1, Math.floor((x * cell) / TILE));
    for (let y = 0; y < rows; y++) this.tileOfRow[y] = Math.min(this.trows - 1, Math.floor((y * cell) / TILE));
    this.tcell.fill(-1);
  }

  /** Draw the fog texture in a handful of short tasks, then swap it in. Until then the old one (if any) stands in. */
  private runTexture(): void {
    clearTimeout(this.texTimer);
    if (this.texJob) this.texJob.canvas.width = this.texJob.canvas.height = 0;
    const job = fogTextureJob({
      w: this.vw, h: this.vh, stage: this.stage, rand: seeded(this.seed ^ 0x7e57), noise: this.noise!,
      palette: this.look!.palette, sprite: this.sprite!,
    });
    this.texJob = job;
    let i = 0;
    const step = () => {
      this.texTimer = undefined;
      if (!this.overlay || this.texJob !== job) return;
      job.steps[i++]();
      if (i < job.steps.length) {
        this.texTimer = window.setTimeout(step, 0);
        return;
      }
      if (this.tex) this.tex.width = this.tex.height = 0;
      this.tex = job.canvas;
      this.texJob = null;
      this.markDirty(0, 0, this.vw, this.vh);
      this.wake();
    };
    this.texTimer = window.setTimeout(step, 0);
  }

  /** A higher stage while running: blend the targets over a few seconds instead of popping. */
  private raiseStage(stage: number): void {
    this.stage = stage;
    if (stage >= 3 && !this.appUsed && this.appTimer === undefined) this.rollApparition();
    if (this.jobTimer !== undefined || !this.tex) {
      this.build(true); // still building: start over with the new stage
      return;
    }
    this.targetsJob(stage, (T, order, rate, mass) => {
      this.Tfrom = this.T.slice();
      this.Tto = T;
      this.T = this.Tfrom.slice();
      this.order = order;
      this.rate = rate;
      this.targetMass = mass;
      this.blendT = 0;
      this.wake();
    });
  }

  // --- events ------------------------------------------------------------------

  private onPointer = (e: PointerEvent): void => {
    if (this.stopping) return;
    // Coalesced points keep strokes smooth when frames are slow; each carries its own time.
    const events = e.getCoalescedEvents?.();
    if (events && events.length > 1) for (const c of events) this.enqueue(c.clientX, c.clientY, c.timeStamp);
    else this.enqueue(e.clientX, e.clientY, e.timeStamp);
    this.lastPointer = performance.now();
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

  /** Clicking and typing: someone is working here, and the glass warms a little faster. */
  private onWork = (): void => {
    const now = performance.now();
    if (this.stopping || now - this.lastWork < 700) return;
    this.lastWork = now;
    this.warm(0.02);
  };

  /** Fog is on the glass, not the page: scrolling only warms it, very slightly. */
  private onWheel = (e: WheelEvent): void => {
    if (this.stopping) return;
    this.warmth = Math.min(0.89, this.warmth + Math.min(0.004, (Math.abs(e.deltaY) + Math.abs(e.deltaX)) * 0.00002));
    this.applyOpacity(2.5);
  };

  private onResize = (): void => {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      if (!this.overlay) return;
      this.build(true);
      this.wake();
    }, 250);
  };

  private onTheme = (): void => {
    // At most a few checks a second, however busily the page rewrites its classes.
    if (this.themeTimer !== undefined || !this.overlay) return;
    this.themeTimer = window.setTimeout(() => {
      this.themeTimer = undefined;
      if (!this.overlay || this.stopping) return;
      const look = pickLook();
      if (look.palette.dark === this.look!.palette.dark) return;
      // Same wiped state and water, redrawn in the new page's colours.
      this.look = look;
      this.build(true);
      this.wake();
    }, 300);
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
    if (!this.overlay || !this.tex) return; // the texture task wakes us when it is ready
    const input = this.qHead !== this.qTail;
    const creeping = this.creepT < this.creepDur;
    const gap = input ? 0 : this.runnerCount > 0 || this.app ? MID_MS : SLOW_MS;
    if (now - this.lastUpdate < gap - 2) {
      // Between simulation steps, keep a batched redraw moving so each frame stays light.
      if (this.batchLen > 0) this.draw();
      this.raf = requestAnimationFrame(this.tick);
      return;
    }
    // Slow frames still advance the clock (up to a quarter second), so timing holds on slow machines.
    const dt = Math.min(0.25, Math.max(0.001, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.lastUpdate = now;
    this.simT += dt;
    if (creeping) this.creepT = Math.min(this.creepDur, this.creepT + dt);
    if (this.Tfrom) this.blendT += dt;

    this.consumePointer();
    this.updateRunners(dt);
    this.updateApparition(dt);
    if (this.creepT < this.creepDur * 0.7) this.sprinkle();
    const busy = this.updateGrid(dt);
    this.draw();

    if (!this.revealed) {
      // The first frame is down: fade the layer in while the front creeps.
      this.revealed = true;
      void getComputedStyle(this.overlay.layer).opacity; // start the transition from 0
      this.applyOpacity(this.creepDur * 0.8, 'ease-out');
    }
    if (this.warmth >= 0.9) this.stop();
    if (
      busy || this.qHead !== this.qTail || this.creepT < this.creepDur || this.runnerCount > 0 || this.app ||
      this.beadCount > 0 || this.Tfrom || this.tilesPending
    ) {
      this.raf = requestAnimationFrame(this.tick);
    }
  };

  /** Advance the fog grid one step, write the masks, and mark what changed. Returns true while anything is still changing. */
  private updateGrid(dt: number): boolean {
    const { order, rate, dens, wet } = this;
    let T: Float32Array = this.T;
    const data = this.maskImg!.data;
    const rim = this.rimImg!.data;
    const { cols, rows, cell } = this.grid;
    const simT = this.simT;
    const creeping = this.creepT < this.creepDur;
    const c = smoothstep(0, 1, this.creepT / this.creepDur) * 1.5 - 0.25;
    const sharp = this.reduced ? 2.2 : 3.4; // a soft front (and the layer fades in), never a hard picture frame
    const bloom = this.bloomMap;
    const benv = bloom ? this.bloomEnvelope() : 0;
    const bstr = this.look!.bloom;
    const from = this.Tfrom;
    const to = this.Tto;
    const blend = from && to ? smoothstep(0, 3, this.blendT) : 0;
    const tcols = this.tcols;
    const tcell = this.tcell;
    const toc = this.tileOfCol;
    const tor = this.tileOfRow;
    let busy = 0;
    let mass = 0;
    let gx0 = cols;
    let gy0 = rows;
    let gx1 = -1;
    let gy1 = -1;
    for (let y = 0, i = 0; y < rows; y++) {
      const trow = tor[y] * tcols;
      for (let x = 0; x < cols; x++, i++) {
        let d = dens[i];
        if (d !== 1) {
          busy++;
          if (simT >= wet[i]) {
            if (d < 1) {
              // Logistic: condensation nucleates slowly, spreads, then settles. It breathes back in.
              d += rate[i] * (0.035 + d) * (1 - d) * dt;
              if (d > 0.985) d = 1;
            } else {
              d -= (d - 1) * 0.35 * dt;
              if (d < 1.015) d = 1;
            }
            dens[i] = d;
          }
        }
        let t: number;
        if (from && to) t = T[i] = from[i] + (to[i] - from[i]) * blend;
        else t = T[i];
        if (creeping) {
          let m = (c - order[i]) * sharp;
          m = m <= 0 ? 0 : m >= 1 ? 1 : m * m * (3 - 2 * m);
          t *= m;
        }
        if (bloom) {
          const b = bloom[i] * benv * bstr;
          if (b > t) t = b;
        }
        let a = t * d;
        if (a > 1) a = 1;
        mass += a;
        // The wet edge: where density changes sharply the pushed water darkens the glass a little.
        let w = 0;
        if (x > 0 && x < cols - 1 && y > 0 && y < rows - 1) {
          const g =
            Math.abs(Math.min(1, dens[i + 1]) - Math.min(1, dens[i - 1])) +
            Math.abs(Math.min(1, dens[i + cols]) - Math.min(1, dens[i - cols]));
          w = g * 1.1;
          if (w > 1) w = 1;
          w *= t > 0.6 ? 1 : t / 0.6;
        }
        const v = (a * 255 + 0.5) | 0;
        const rv = (w * 255 + 0.5) | 0;
        const j = i * 4 + 3;
        if (data[j] !== v || rim[j] !== rv) {
          data[j] = v;
          if ((rim[j] === 0) !== (rv === 0)) this.rimCount[trow + toc[x]] += rv ? 1 : -1;
          rim[j] = rv;
          if (x < gx0) gx0 = x;
          if (x > gx1) gx1 = x;
          if (y < gy0) gy0 = y;
          if (y > gy1) gy1 = y;
          const k = (trow + toc[x]) * 4;
          if (tcell[k] < 0) {
            tcell[k] = tcell[k + 2] = x;
            tcell[k + 1] = tcell[k + 3] = y;
          } else {
            if (x < tcell[k]) tcell[k] = x;
            if (x > tcell[k + 2]) tcell[k + 2] = x;
            if (y > tcell[k + 3]) tcell[k + 3] = y;
          }
        }
      }
    }
    if (from && to && blend >= 1) {
      T = this.T = to;
      this.Tfrom = this.Tto = null;
    }
    if (gx1 >= 0) {
      const w = gx1 - gx0 + 1;
      const h = gy1 - gy0 + 1;
      this.maskCtx!.putImageData(this.maskImg!, 0, 0, gx0, gy0, w, h);
      this.rimCtx!.putImageData(this.rimImg!, 0, 0, gx0, gy0, w, h);
      // Each tile's changed cells, widened by the reach of the smooth upscale.
      for (let k = 0; k < tcell.length; k += 4) {
        if (tcell[k] < 0) continue;
        this.markDirty((tcell[k] - 3) * cell, (tcell[k + 1] - 3) * cell, (tcell[k + 2] + 4) * cell, (tcell[k + 3] + 4) * cell);
        tcell[k] = -1;
      }
    }
    // Wiped nearly everything away at once: that counts as clearing the glass.
    if (!creeping && !this.app && !from && mass < this.targetMass * 0.1) this.warmth = 1;
    return busy > 0;
  }

  private clearTileDirty(k: number): void {
    this.tdirty[k * 4] = this.tdirty[k * 4 + 1] = Infinity;
    this.tdirty[k * 4 + 2] = this.tdirty[k * 4 + 3] = -Infinity;
  }

  private markDirty(x0: number, y0: number, x1: number, y1: number): void {
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > this.vw) x1 = this.vw;
    if (y1 > this.vh) y1 = this.vh;
    if (x1 <= x0 || y1 <= y0) return;
    const tx0 = Math.floor(x0 / TILE);
    const ty0 = Math.floor(y0 / TILE);
    const tx1 = Math.min(this.tcols - 1, Math.floor((x1 - 0.001) / TILE));
    const ty1 = Math.min(this.trows - 1, Math.floor((y1 - 0.001) / TILE));
    const d = this.tdirty;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const k = (ty * this.tcols + tx) * 4;
        if (x0 < d[k]) d[k] = x0;
        if (y0 < d[k + 1]) d[k + 1] = y0;
        if (x1 > d[k + 2]) d[k + 2] = x1;
        if (y1 > d[k + 3]) d[k + 3] = y1;
      }
    }
  }

  /**
   * Repaint what changed. When the changed tiles fit the per-frame budget they are
   * repainted in place, just their dirty part. When more changed at once (the creeping
   * front, a stage change), the masks are frozen and the tiles are redrawn off-screen
   * over a few frames, then all flip into view together, so tiles never disagree.
   */
  private draw(): void {
    this.prepareBeads();
    const d = this.tdirty;
    const nt = this.tiles.length;
    if (this.batchLen === 0) {
      let dirty = 0;
      for (let k = 0; k < nt; k++) if (d[k * 4 + 2] > d[k * 4]) dirty++;
      if (dirty <= TILE_BUDGET) {
        for (let k = 0; k < nt; k++) {
          const q = k * 4;
          if (d[q + 2] <= d[q]) continue;
          const t = this.tiles[k];
          const x0 = Math.max(t.x, Math.floor(d[q]));
          const y0 = Math.max(t.y, Math.floor(d[q + 1]));
          const x1 = Math.min(t.x + t.w, Math.ceil(d[q + 2]));
          const y1 = Math.min(t.y + t.h, Math.ceil(d[q + 3]));
          this.clearTileDirty(k);
          if (x1 > x0 && y1 > y0) this.paintTile(k, t.gs[t.cur], x0, y0, x1, y1, this.mask!, this.rimCanvas!);
        }
        this.tilesPending = false;
        return;
      }
      // Start a batch from a frozen copy of the masks.
      for (const [src, dst] of [[this.mask!, this.snapMask!], [this.rimCanvas!, this.snapRim!]] as const) {
        const g = dst.getContext('2d')!;
        g.globalCompositeOperation = 'copy';
        g.drawImage(src, 0, 0);
      }
      for (let k = 0; k < nt; k++) {
        if (d[k * 4 + 2] <= d[k * 4]) continue;
        this.batch[this.batchLen++] = k;
        this.clearTileDirty(k);
      }
      this.batchPos = 0;
    }
    for (let n = 0; n < BATCH_BUDGET && this.batchPos < this.batchLen; n++) {
      const k = this.batch[this.batchPos++];
      const t = this.tiles[k];
      this.paintTile(k, t.gs[1 - t.cur], t.x, t.y, t.x + t.w, t.y + t.h, this.snapMask!, this.snapRim!);
    }
    if (this.batchPos >= this.batchLen) {
      for (let i = 0; i < this.batchLen; i++) {
        const t = this.tiles[this.batch[i]];
        t.cv[1 - t.cur].style.visibility = 'visible';
        t.cv[t.cur].style.visibility = 'hidden';
        t.cur = 1 - t.cur;
      }
      this.batchLen = 0;
    }
    let left = this.batchLen > 0;
    for (let k = 0; k < nt && !left; k++) if (d[k * 4 + 2] > d[k * 4]) left = true;
    this.tilesPending = left;
  }

  /** Paint one tile's region: the texture, masked by the fog grid, the wet edge, then the water. */
  private paintTile(k: number, g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, mask: HTMLCanvasElement, rim: HTMLCanvasElement): void {
    const t = this.tiles[k];
    const { cols, rows, cell } = this.grid;
    g.save();
    g.setTransform(1, 0, 0, 1, -t.x, -t.y);
    g.beginPath();
    g.rect(x0, y0, x1 - x0, y1 - y0);
    g.clip();
    g.clearRect(x0, y0, x1 - x0, y1 - y0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'medium';
    g.drawImage(this.tex!, 0, 0, this.vw, this.vh);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(mask, 0, 0, cols * cell, rows * cell);
    g.globalCompositeOperation = 'source-over';
    if (this.rimNear(k)) {
      g.globalAlpha = this.look!.rimAlpha;
      g.drawImage(rim, 0, 0, cols * cell, rows * cell);
    }
    this.drawBeads(g, x0, y0, x1, y1);
    g.restore();
  }

  /** Is there any wet edge in this tile or its neighbours (the smooth upscale reaches across tile borders)? */
  private rimNear(k: number): boolean {
    const tx = k % this.tcols;
    const ty = (k / this.tcols) | 0;
    for (let y = Math.max(0, ty - 1); y <= Math.min(this.trows - 1, ty + 1); y++) {
      for (let x = Math.max(0, tx - 1); x <= Math.min(this.tcols - 1, tx + 1); x++) {
        if (this.rimCount[y * this.tcols + x] > 0) return true;
      }
    }
    return false;
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
      const gap = t - this.p1t;
      const step = Math.hypot(x - this.p1x, y - this.p1y);
      // A new stroke only after a real pause far from the last point (the pointer left and came back).
      if (!this.hasPrev || gap > 1500 || (gap > 120 && step > this.radius * 3)) {
        this.hasPrev = true;
        this.p0x = this.p1x = x;
        this.p0y = this.p1y = y;
        this.p1t = t;
        this.speed = 0;
        this.strokeLen = 0;
        this.streakPhase = this.rand() * 200;
        continue;
      }
      if (step < 0.5) continue;
      const v = (step / Math.max(1, gap)) * 1000;
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
      this.strokeLen += dl;
      this.stamp(x, y, R, dx / dl, dy / dl);
      this.afterStamp(x, y, R, dx / dl, dy / dl, dl);
      px = x;
      py = y;
    }
  }

  /** One dab of a fingertip: clears the middle in irregular streaks, pushes fog into a rim around it. */
  private stamp(cx: number, cy: number, R: number, dirx: number, diry: number): void {
    const { cols, rows, cell } = this.grid;
    const { dens, wet, T } = this;
    const outer = R * 1.3;
    const x0 = Math.max(0, Math.floor((cx - outer) / cell));
    const x1 = Math.min(cols - 1, Math.ceil((cx + outer) / cell));
    const y0 = Math.max(0, Math.floor((cy - outer) / cell));
    const y1 = Math.min(rows - 1, Math.ceil((cy + outer) / cell));
    const hold = this.simT + WET_HOLD;
    // Streaks follow the skin across the stroke and drift slowly along it.
    const phase = this.streakPhase + this.strokeLen * 0.004;
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
          const perp = -dx * diry + dy * dirx;
          const streak = 0.7 + 0.3 * noise1(perp * 0.17 + phase);
          // A thin film survives in some streaks, so a wipe never looks painted on.
          const film = smoothstep(0.55, 0.95, noise1(perp * 0.09 + phase * 1.7 + 91));
          const nd = Math.min(d, Math.max(Math.min(1, d) * (1 - 0.6 * e * streak), e * 0.24 * film));
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
    if (removed > 0) this.warm((removed / this.targetMass) * WARM_GAIN);
  }

  /** Water squeezed to the sides of a wipe: beads along the rims, the odd drop that runs. */
  private afterStamp(x: number, y: number, R: number, dirx: number, diry: number, dl: number): void {
    this.travel += dl;
    while (this.travel > 4.5) {
      this.travel -= 4.5;
      if (this.rand() < 0.5) {
        const side = this.rand() < 0.5 ? 1 : -1;
        const nx = -diry * side;
        const ny = dirx * side;
        const off = R * (0.96 + this.rand() * 0.26);
        const along = (this.rand() - 0.5) * 6;
        const px = x + nx * off + dirx * along;
        const py = y + ny * off + diry * along;
        if (this.fogNow(px, py) < 0.08) continue; // no fog there, no water to push aside
        const below = ny > 0.3 ? 1.35 : 1; // gravity: bigger beads gather on the lower rim
        this.addBead(px, py, (0.6 + this.rand() ** 3 * 2.3) * below, 8 + this.rand() * 8);
      }
    }
    this.runnerCooldown -= 1;
    if (!this.reduced && Math.abs(dirx) > 0.45 && this.runnerCooldown <= 0 && this.rand() < 0.012 && this.fogNow(x, y + R) > 0.15) {
      this.addRunner(x + (this.rand() - 0.5) * R, y + R * 0.98, 1.7 + this.rand() * 1.1);
      this.runnerCooldown = 30;
    }
  }

  private cellAt(x: number, y: number): number {
    const { cols, rows, cell } = this.grid;
    const gx = Math.min(cols - 1, Math.max(0, (x / cell) | 0));
    const gy = Math.min(rows - 1, Math.max(0, (y / cell) | 0));
    return gy * cols + gx;
  }

  /** How much fog this spot is meant to hold (ignoring wipes). */
  private fogAt(x: number, y: number): number {
    const i = this.cellAt(x, y);
    const bloom = this.bloomMap ? this.bloomMap[i] * this.look!.bloom : 0;
    return Math.max(this.T[i], bloom);
  }

  /** How much fog is on this spot right now. */
  private fogNow(x: number, y: number): number {
    return this.fogAt(x, y) * Math.min(1, this.dens[this.cellAt(x, y)]);
  }

  // --- beads and runners -------------------------------------------------------------

  private addBead(x: number, y: number, r: number, life: number): void {
    const i = this.bNext;
    this.bNext = (i + 1) % MAX_BEADS;
    if (!this.bLive[i]) this.beadCount++;
    this.bx[i] = x;
    this.by[i] = y;
    this.br[i] = r;
    this.bt[i] = this.simT;
    this.bl[i] = life;
    this.bLive[i] = 1;
  }

  /** Droplets condensing just ahead of the creeping front. */
  private sprinkle(): void {
    const c = smoothstep(0, 1, this.creepT / this.creepDur) * 1.5 - 0.25;
    const n = this.T.length;
    const { cols, cell } = this.grid;
    for (let k = 0, made = 0; k < 16 && made < 2; k++) {
      const j = (this.rand() * n) | 0;
      const ahead = this.order[j] - c;
      if (ahead < 0 || ahead > 0.25 || this.T[j] < 0.3) continue;
      this.addBead(((j % cols) + this.rand()) * cell, (((j / cols) | 0) + this.rand()) * cell, 0.4 + this.rand() * 0.9, 1.4 + this.rand() * 1.4);
      made++;
    }
  }

  private addRunner(x: number, y: number, r: number, len = 50 + this.rand() * 220): void {
    for (let i = 0; i < MAX_RUNNERS; i++) {
      if (this.rLive[i]) continue;
      this.rx[i] = this.rx0[i] = x;
      this.ry[i] = y;
      this.rr[i] = this.rr0[i] = r;
      this.rv[i] = 22 + this.rand() * 30;
      this.rPhase[i] = this.rand() * 6;
      this.rLen[i] = len;
      this.rTrav[i] = 0;
      this.rWander[i] = 1 + this.rand() * 3;
      this.rFreq[i] = 1 / (30 + this.rand() * 40);
      this.rWph[i] = this.rand() * 6.28;
      this.rNextBead[i] = 12 + this.rand() * 20;
      this.rLive[i] = 1;
      this.runnerCount++;
      return;
    }
  }

  private updateRunners(dt: number): void {
    if (!this.runnerCount) return;
    // Small substeps, so a slow frame does not leave gaps in the trail.
    for (let left = dt; left > 1e-4; left -= 0.04) {
      const sdt = Math.min(0.04, left);
      for (let i = 0; i < MAX_RUNNERS; i++) {
        if (!this.rLive[i]) continue;
        // Stick and slip: a drop hesitates, gathers, then lurches on.
        this.rPhase[i] += sdt * (2.2 + this.rr0[i] * 0.4);
        const s = Math.sin(this.rPhase[i]);
        const dy = this.rv[i] * (0.15 + 0.85 * (s > 0 ? s * s : 0)) * sdt;
        const trav = (this.rTrav[i] += dy);
        this.ry[i] += dy;
        // It wanders as it finds its way, and thins as it leaves water behind.
        this.rx[i] = this.rx0[i] + this.rWander[i] * Math.sin(trav * this.rFreq[i] + this.rWph[i]) + trav * 0.02 * Math.sin(this.rWph[i] * 3);
        const left2 = 1 - trav / this.rLen[i];
        this.rr[i] = this.rr0[i] * (0.4 + 0.6 * left2);
        if (trav > this.rNextBead[i]) {
          this.rNextBead[i] += 16 + this.rand() * 26;
          if (this.rand() < 0.45) this.addBead(this.rx[i] + (this.rand() - 0.5) * 3, this.ry[i] - 3, this.rr[i] * 0.55, 6 + this.rand() * 6);
        }
        this.trail(this.rx[i], this.ry[i], this.rr[i], 0.45 + 0.55 * left2);
        if (left2 <= 0 || this.ry[i] > this.vh + 10) {
          this.rLive[i] = 0;
          this.runnerCount--;
          if (this.ry[i] < this.vh) this.addBead(this.rx[i], this.ry[i], this.rr[i] * 1.1, 8 + this.rand() * 6);
        }
      }
    }
  }

  /** The thin clear channel a running drop leaves behind, narrowing as the drop shrinks. */
  private trail(x: number, y: number, r: number, strength: number): void {
    const { cols, rows, cell } = this.grid;
    const { dens, wet } = this;
    const hold = this.simT + WET_HOLD * 2.5;
    const reachPx = Math.max(cell * 0.75, r * 1.6);
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
        const target = 1 - Math.min(1, k * 1.6) * 0.92 * strength;
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
        const changing = age < 0.5 || age > life * 0.55;
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
      const r = this.rr0[i] + 3;
      this.markDirty(this.rx[i] - r - 4, this.ry[i] - r * 1.2 - 12, this.rx[i] + r + 4, this.ry[i] + r * 1.2 + 2);
    }
  }

  private drawBeads(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
    const sprite = this.sprite!;
    if (this.beadCount) {
      for (let i = 0; i < MAX_BEADS; i++) {
        if (!this.bLive[i]) continue;
        const x = this.bx[i];
        const y = this.by[i];
        const r0 = this.br[i];
        if (x + r0 < x0 || x - r0 > x1 || y + r0 < y0 || y - r0 > y1) continue;
        const age = this.simT - this.bt[i];
        const life = this.bl[i];
        // Beads swell in, then slowly dry or are misted over as the fog returns.
        const grow = age < 0.5 ? age / 0.5 : 1;
        const a = grow * (1 - smoothstep(life * 0.55, life, age));
        if (a < 0.02) continue;
        const r = r0 * (0.6 + 0.4 * grow);
        g.globalAlpha = a;
        g.drawImage(sprite, x - r, y - r, r * 2, r * 2);
      }
    }
    for (let i = 0; i < MAX_RUNNERS; i++) {
      if (!this.rLive[i]) continue;
      const r = this.rr[i];
      g.globalAlpha = 0.95;
      g.drawImage(sprite, this.rx[i] - r, this.ry[i] - r * 1.2, r * 2, r * 2.4);
    }
    g.globalAlpha = 1;
  }

  // --- the visitor -------------------------------------------------------------------

  private rollApparition(): void {
    if (this.rand() < (this.stage >= 4 ? 0.8 : 0.55)) this.scheduleApparition((this.creepDur + 7 + this.rand() * 12) * 1000);
  }

  private scheduleApparition(ms: number): void {
    clearTimeout(this.appTimer);
    this.appTimer = window.setTimeout(() => {
      this.appTimer = undefined;
      if (!this.overlay || this.stopping || this.appUsed) return;
      const idle = performance.now() - this.lastPointer > 2500;
      if (!this.visible || !idle || this.creepT < this.creepDur || this.warmth > 0.5 || this.Tfrom) {
        if (++this.appTries < 12) this.scheduleApparition(2500);
        return;
      }
      this.beginApparition();
    }, ms);
  }

  /**
   * How free of text and controls a rectangle of the page is (1 = empty). One coarse
   * round of hit tests, only when an apparition is about to appear.
   */
  private emptiness(cx: number, cy: number, hw: number, hh: number, imagesOk: boolean): number {
    let busy = 0;
    let n = 0;
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 5; i++) {
        const x = cx + hw * ((i / 4) * 2 - 1) * 0.92;
        const y = cy + hh * ((j / 2) * 2 - 1) * 0.85;
        busy += busyAt(x, y, imagesOk);
        n++;
      }
    }
    return 1 - busy / n;
  }

  /** The best spot for a mark of this size: in thick fog, on nothing the user needs to read, away from the pointer. */
  private placeMark(hw: number, hh: number, imagesOk: boolean): [number, number] | null {
    const vw = this.vw;
    const vh = this.vh;
    const m = 20;
    if (hw * 2 + m * 2 > vw || hh * 2 + m * 2 > vh) return null;
    const cands: [number, number, number][] = [];
    for (let j = 0; j < 5; j++) {
      for (let i = 0; i < 7; i++) {
        const x = hw + m + ((vw - 2 * (hw + m)) * i) / 6;
        const y = hh + m + ((vh - 2 * (hh + m)) * j) / 4;
        let fog = 0;
        for (let k = 0; k < 5; k++) fog += this.fogAt(x + hw * (k / 2 - 1) * 0.8, y + hh * ((k % 3) - 1) * 0.6);
        const away = Math.min(1, (120 + Math.hypot(x - this.p1x, y - this.p1y)) / 600);
        cands.push([x, y, (fog / 5) * (0.5 + 0.5 * away) * (0.85 + 0.3 * this.rand())]);
      }
    }
    cands.sort((a, b) => b[2] - a[2]);
    let best: [number, number] | null = null;
    let bestScore = 0;
    for (const [x, y, score] of cands.slice(0, 10)) {
      if (score < 0.12) break;
      const empty = this.emptiness(x, y, hw, hh, imagesOk);
      if (empty < 0.9) continue;
      const s = score * empty;
      if (s > bestScore) {
        bestScore = s;
        best = [x, y];
      }
    }
    return best;
  }

  private beginApparition(): void {
    this.appUsed = true;
    const short = Math.min(this.vw, this.vh);
    const wordSize = Math.max(54, Math.min(96, short * 0.1));
    const handSize = Math.max(150, Math.min(250, short * 0.32));
    const word = this.rand() < 0.5 ? 'LEAVE' : 'HERE';
    const wordHalf = (s: number) => s * (word === 'LEAVE' ? 2.15 : 1.75);
    // Try what the dice chose first, then the other, then a smaller word; if nothing fits, nobody comes.
    const tries: ['word' | 'hand', number][] = this.rand() < 0.5
      ? [['word', wordSize], ['hand', handSize], ['word', wordSize * 0.72]]
      : [['hand', handSize], ['word', wordSize], ['word', wordSize * 0.72]];
    let imp: Imprint | null = null;
    for (const [kind, size] of tries) {
      const at = kind === 'word' ? this.placeMark(wordHalf(size), size * 0.62, true) : this.placeMark(size * 0.42, size * 0.48, true);
      if (!at) continue;
      imp = kind === 'word'
        ? buildWord(word, at[0], at[1], size, this.grid, this.rand)
        : buildHand(at[0], at[1] + size * 0.08, size, this.grid, this.rand, this.noise!);
      break;
    }
    if (!imp) return;
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
    const rx = imp.rx + 46;
    const ry = imp.ry + 40;
    const { cols, rows, cell } = this.grid;
    const gx0 = Math.max(0, Math.floor((imp.cx - rx * 1.3) / cell));
    const gx1 = Math.min(cols - 1, Math.ceil((imp.cx + rx * 1.3) / cell));
    const gy0 = Math.max(0, Math.floor((imp.cy - ry * 1.3) / cell));
    const gy1 = Math.min(rows - 1, Math.ceil((imp.cy + ry * 1.3) / cell));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const px = (gx + 0.5) * cell;
        const py = (gy + 0.5) * cell;
        const q = Math.hypot((px - imp.cx) / rx, (py - imp.cy) / ry) * (0.8 + 0.4 * noise.fbm(px / 70, py / 70, 3));
        const b = (1 - smoothstep(0.5, 1.05, q)) * (0.85 + 0.15 * noise.at(px / 25, py / 25));
        bloom[gy * cols + gx] = Math.min(b, topCap(py, this.look!.topCap) / this.look!.bloom);
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
        this.addBead(b[this.appBead], b[this.appBead + 1], b[this.appBead + 3], 10 + this.rand() * 6);
        this.appBead += 4;
      }
      const dr = imp.drips;
      while (this.appDrip < dr.length && dr[this.appDrip + 2] <= t) {
        this.addRunner(dr[this.appDrip], dr[this.appDrip + 1], dr[this.appDrip + 3], 30 + this.rand() * 70);
        this.appDrip += 4;
      }
    }
    if (this.appT > this.appRelease + 12.5) {
      this.app = null;
      this.bloomMap = null;
    }
  }
}

const INTERACTIVE = /^(A|BUTTON|INPUT|TEXTAREA|SELECT|LABEL|SUMMARY|OPTION|VIDEO|IFRAME)$/;
const MEDIA = /^(IMG|PICTURE|CANVAS|SVG)$/;

/** Is there something to read or click at this point? 1 yes, 0 no, in between for images. */
function busyAt(x: number, y: number, imagesOk: boolean): number {
  const el = document.elementsFromPoint(x, y).find((e) => !e.closest(`[${OUR_ATTR}]`));
  if (!el || el === document.body || el === document.documentElement) return 0;
  for (let e: Element | null = el, k = 0; e && k < 4; e = e.parentElement, k++) {
    if (INTERACTIVE.test(e.tagName.toUpperCase()) || (e as HTMLElement).isContentEditable || e.getAttribute('role') === 'button') return 1;
  }
  if (MEDIA.test(el.tagName.toUpperCase())) return imagesOk ? 0.15 : 0.6;
  for (const n of Array.from(el.childNodes)) if (n.nodeType === Node.TEXT_NODE && n.nodeValue && n.nodeValue.trim()) return 1;
  return 0;
}

/** Fog is lighter than a dark page and a touch greyer and cooler than a white one, so it shows on both. */
function pickLook(): Look {
  const dark = pageIsDark();
  return dark
    ? { palette: { dark, lo: [104, 114, 126], hi: [196, 204, 214] }, edgeCap: 0.7, topCap: 0.3, bloom: 0.66, rim: '214,224,234', rimAlpha: 0.1 }
    : { palette: { dark, lo: [178, 189, 203], hi: [236, 241, 247] }, edgeCap: 0.9, topCap: 0.12, bloom: 0.92, rim: '58,74,94', rimAlpha: 0.14 };
}

/**
 * Sample what is actually on screen at a few points and walk up to the first opaque
 * background. Colours are resolved by painting them into a 1x1 canvas, so oklch(),
 * lab() and friends work. Transparent or image-only backgrounds count as unknown.
 */
function pageIsDark(): boolean {
  const probe = document.createElement('canvas');
  probe.width = probe.height = 1;
  const pg = probe.getContext('2d', { willReadFrequently: true });
  const lumOf = (el: Element | null): number | null => {
    for (let e = el; e && pg; e = e.parentElement) {
      pg.clearRect(0, 0, 1, 1);
      pg.fillStyle = 'rgba(0,0,0,0)';
      pg.fillStyle = getComputedStyle(e).backgroundColor;
      pg.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = pg.getImageData(0, 0, 1, 1).data;
      if (a >= 128) return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }
    return null;
  };
  const votes: number[] = [];
  for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.25], [0.8, 0.25], [0.2, 0.8], [0.8, 0.8]]) {
    const el = document.elementsFromPoint(fx * innerWidth, fy * innerHeight).find((e) => !e.closest(`[${OUR_ATTR}]`));
    const l = lumOf(el ?? null);
    if (l !== null) votes.push(l);
  }
  if (!votes.length) {
    const l = lumOf(document.body) ?? lumOf(document.documentElement);
    if (l !== null) votes.push(l);
  }
  probe.width = probe.height = 0;
  if (votes.length) {
    votes.sort((a, b) => a - b);
    return votes[votes.length >> 1] < 0.45;
  }
  const scheme = getComputedStyle(document.documentElement).colorScheme || '';
  return scheme.includes('dark') && matchMedia('(prefers-color-scheme: dark)').matches;
}
