// Dust and decay: film grain, a yellowing vignette, and motes drifting in a shaft of light. Thickens with the stage and settles as you interact.
//
// Layers, bottom to top, all inside our own shadow root and all click-through:
//   tone   mix-blend-mode: color  a faint sepia wash that drains the page's colour, never its contrast
//   paper  on light pages mix-blend-mode: multiply: cream paper, edges browning inward, lifted where
//          the light falls. On dark pages a plain veil does the same job (multiply would barely show):
//          edges sinking into brown-black and the shaft as warm light. Film grain lives inside it, a
//          pre-rendered tile jumped around at ~18fps.
//   motes  a canvas: dust in the light, film specks, hairs and scratches
// Blend layers are kept to two, because every canvas frame makes the browser re-blend them.
// The mouse stirs a small velocity grid (advected, diffused, decaying) that the motes ride on.
// Moving and scrolling wear the whole thing away; left alone it slowly settles back.

import type { Effect, EffectContext } from './types';
import { createCanvas, createOverlay, seeded, Z, type Overlay } from './overlay';

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Depth: 0 far behind the focus plane, 1 right in front of the lens. */
  z: number;
  /** Parallax: how strongly drift and air move it on screen. */
  par: number;
  sprite: number;
  /** Full sprite size on screen, in CSS px. */
  draw: number;
  alpha: number;
  /** Fades out once the overall intensity drops below this. */
  th: number;
  tumbleW: number;
  tumbleP: number;
  glintAt: number;
  glintDur: number;
  /** Time it (re)appeared, for a soft fade in. */
  born: number;
}

const BLUR_LEVELS = 6;
const SPRITE_PX = 64;
/** Fraction of a sprite's width that is the visible disc, per blur level. */
const CORE = [0.2, 0.26, 0.34, 0.44, 0.56, 0.66];

const STAGE_TONE = [0, 0.1, 0.15, 0.2, 0.26];
const STAGE_AGE = [0, 0.6, 0.74, 0.87, 1];
const STAGE_GRAIN = [0, 0.6, 0.72, 0.86, 1];
const STAGE_MOTES = [0, 80, 110, 140, 170];

const INTRO_MS = 3200;
const FADE_OUT_MS = 1200;
const GRAIN_TILE = 256;
const GRAIN_FPS = 18;
const FIELD_CELL = 44;
/** Viewport diagonals of mouse travel that wear the effect away completely. */
const WEAR_MOUSE = 11;
/** Viewport heights of scrolling that wear the effect away completely. */
const WEAR_SCROLL = 5;
/** Seconds of stillness before it starts settling back, and how long a full return takes. */
const CREEP_DELAY = 3;
const CREEP_SECONDS = 75;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};

/**
 * Any CSS colour as RGBA bytes. Computed styles can come back as oklch(), lab(), color() and so
 * on, so let the browser resolve it by painting one pixel rather than parsing the string.
 */
function makeColorReader(): (css: string) => Uint8ClampedArray | null {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const g = c.getContext('2d', { willReadFrequently: true });
  return (css) => {
    if (!g) return null;
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = '#000';
    g.fillStyle = css;
    g.fillRect(0, 0, 1, 1);
    return g.getImageData(0, 0, 1, 1).data;
  };
}

/** Luminance (0..1) of the first opaque background colour behind a viewport point, if any. */
function backgroundAt(x: number, y: number, read: (css: string) => Uint8ClampedArray | null): number | null {
  let el: Element | null = document.elementFromPoint(x, y);
  while (el) {
    const css = getComputedStyle(el).backgroundColor;
    // Transparent, or a background image with no colour behind it: unknown, keep walking up.
    const px = css && css !== 'transparent' ? read(css) : null;
    if (px && px[3] >= 128) return (0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]) / 255;
    el = el.parentElement;
  }
  return null;
}

/** Is the page mostly dark? Sampled once at start, before our overlay exists. */
function pageIsDark(): boolean {
  const read = makeColorReader();
  let dark = 0;
  let seen = 0;
  for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.35], [0.75, 0.35], [0.3, 0.75], [0.7, 0.75]]) {
    const l = backgroundAt(innerWidth * fx, innerHeight * fy, read);
    if (l === null) continue;
    seen++;
    if (l < 0.42) dark++;
  }
  if (seen) return dark * 2 > seen;
  // Nothing painted a background: the canvas default, which follows the page's colour scheme.
  return getComputedStyle(document.documentElement).colorScheme.includes('dark') && matchMedia('(prefers-color-scheme: dark)').matches;
}

const CSS = `
  .fx { position: fixed; inset: 0; pointer-events: none; overflow: hidden; z-index: ${Z.dust}; opacity: 0; }
  .tone { mix-blend-mode: color; background: rgb(168, 128, 78); }
  .paper.light { mix-blend-mode: multiply; background: rgb(250, 240, 218); }
  .paper.dark { background: rgba(84, 58, 24, .12); }
  .vig { position: absolute; inset: -14%;
    background: radial-gradient(ellipse 72% 68% at 50% 47%, rgba(255,255,255,0) 38%, rgba(226,196,148,.5) 70%, rgba(170,124,70,.92) 100%); }
  .dark .vig { background: radial-gradient(ellipse 72% 68% at 50% 47%, rgba(16,10,4,0) 45%, rgba(20,12,4,.26) 74%, rgba(8,5,2,.56) 100%); }
  .haze { position: absolute; inset: 0; }
  .beam { position: absolute; left: 0; top: 0; transform-origin: 50% 0;
    -webkit-mask-image: linear-gradient(180deg, #000 0%, rgba(0,0,0,.75) 35%, rgba(0,0,0,.25) 70%, transparent 95%);
    mask-image: linear-gradient(180deg, #000 0%, rgba(0,0,0,.75) 35%, rgba(0,0,0,.25) 70%, transparent 95%); }
  .grain { position: absolute; left: 0; top: 0; will-change: transform; }
`;

export class Dust implements Effect {
  readonly name = 'dust' as const;

  private overlay: Overlay | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private resizeCanvas: (() => void) | null = null;
  private tone: HTMLDivElement | null = null;
  private paper: HTMLDivElement | null = null;
  private vig: HTMLDivElement | null = null;
  private haze: HTMLDivElement | null = null;
  private beams: HTMLDivElement[] = [];
  private grain: HTMLCanvasElement | null = null;
  private grainTile: HTMLCanvasElement | null = null;
  private grainShifts: string[] = [];
  private grainIndex = 0;
  private nextGrain = 0;
  private sprites: HTMLCanvasElement[] = [];
  private glintSprite: HTMLCanvasElement | null = null;
  private scratchSprite: HTMLCanvasElement | null = null;

  private rng: () => number = Math.random;
  private stage = 1;
  private reduced = false;
  private dark = false;

  private W = 0;
  private H = 0;
  private motes: Mote[] = [];

  // Air: a coarse velocity grid in px/frame.
  private cols = 0;
  private rows = 0;
  private fvx = new Float32Array(0);
  private fvy = new Float32Array(0);
  private tvx = new Float32Array(0);
  private tvy = new Float32Array(0);
  private airAwake = false;

  // The shaft of light, in viewport px.
  private beamSide = 1;
  private beamAngle = 0;
  private beamOX = 0;
  private beamOY = 0;
  private beamDX = 0;
  private beamDY = 1;
  private beamHalf = 100;
  private beamLen = 1000;
  private beamPhase = 0;
  private beamWidth = 0.3;
  private beamOffset = 0.25;

  // Wind: a slow drift shared by every mote.
  private windX = 0;
  private windY = 0;

  /** How much of the haunting is left (0..1). Interaction wears it down, stillness brings it back. */
  private level = 1;
  /** `level` eased, so nothing steps. */
  private shown = 1;
  private intro = 0;
  private fade = 1;
  private stopping = false;
  private dissolving = false;
  private lastInteract = 0;

  private hasPointer = false;
  private ptrX = 0;
  private ptrY = 0;
  private lastScrollY = 0;

  // One film artifact at a time: 0 none, 1 speck, 2 hair, 3 scratch.
  private art = 0;
  private artBorn = 0;
  private artLife = 0;
  private artX = 0;
  private artY = 0;
  private artA = 0;
  private artLen = 0;
  private artC1 = 0;
  private artC2 = 0;
  private artAlpha = 0;
  private artJX = 0;
  private artJY = 0;
  private artNextJitter = 0;
  private nextArt = 0;
  private readonly artShape = new Float32Array(8);

  private raf = 0;
  private lastDraw = 0;
  private vigScale = 0;
  private last = 0;
  private stopTimer: number | undefined;
  private needsResize = false;
  private listening = false;
  private readonly opacity = new Map<HTMLElement, number>();

  get active(): boolean {
    return !!this.overlay;
  }

  start(ctx: EffectContext): void {
    const stage = Math.max(1, Math.min(4, ctx.stage || 1));
    if (this.overlay) {
      // Already here: come back if we were leaving, and thicken if the tab decayed further.
      clearTimeout(this.stopTimer);
      this.stopTimer = undefined;
      this.stopping = false;
      this.dissolving = false;
      if (stage > this.stage) {
        this.stage = stage;
        if (this.grain) this.grain.style.opacity = String(STAGE_GRAIN[stage]);
        this.fillMotes();
      }
      this.level = 1;
      this.wake();
      return;
    }
    this.stage = stage;
    this.reduced = ctx.reduced;
    this.rng = seeded(ctx.seed ^ 0x5eed_d057);
    this.dark = pageIsDark();
    this.level = 1;
    this.shown = 1;
    this.intro = 0;
    this.fade = 1;
    this.stopping = false;
    this.dissolving = false;
    this.lastInteract = performance.now();
    this.lastScrollY = scrollY;
    this.hasPointer = false;
    this.vigScale = 0;
    this.build();
    this.listen(true);
    this.wake();
  }

  stop(): void {
    if (!this.overlay || this.stopping) return;
    this.stopping = true;
    clearTimeout(this.stopTimer);
    // Hidden tabs get no animation frames, so make sure it goes either way.
    this.stopTimer = window.setTimeout(() => this.destroy(), FADE_OUT_MS + 300);
    this.wake();
  }

  destroy(): void {
    clearTimeout(this.stopTimer);
    this.stopTimer = undefined;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.listen(false);
    this.overlay?.remove();
    this.overlay = null;
    this.ctx = this.resizeCanvas = null;
    this.tone = this.paper = this.vig = this.haze = null;
    this.grain = this.grainTile = this.scratchSprite = this.glintSprite = null;
    this.beams = [];
    this.sprites = [];
    this.motes = [];
    this.opacity.clear();
    this.art = 0;
  }

  // --- building --------------------------------------------------------------

  private build(): void {
    const rng = this.rng;
    const overlay = createOverlay(this.name, CSS);
    this.overlay = overlay;
    const div = (cls: string, parent: Node) => {
      const el = document.createElement('div');
      el.className = cls;
      parent.appendChild(el);
      return el;
    };
    // Blending layers go beside the overlay's own layer, not inside it: the layer is
    // its own stacking context, so anything blended inside it would never reach the page.
    const tone = document.createElement('div');
    tone.className = 'fx tone';
    const paper = document.createElement('div');
    paper.className = `fx paper ${this.dark ? 'dark' : 'light'}`;
    for (const el of [tone, paper]) overlay.root.insertBefore(el, overlay.layer);
    this.tone = tone;
    this.paper = paper;
    this.vig = div('vig', paper);
    if (this.dark) this.haze = div('haze', paper);

    // The shaft comes from above, off to one side, and slants in across the page.
    // beamSide 1: it enters left of centre and leans right; -1 the mirror image.
    this.beamSide = rng() < 0.5 ? -1 : 1;
    this.beamAngle = -this.beamSide * (14 + rng() * 12);
    this.beamPhase = rng() * 1000;
    this.beamWidth = 0.3 + rng() * 0.08;
    this.beamOffset = 0.22 + rng() * 0.1;
    const streaks = (r: number, g: number, b: number, a: number) => {
      // Uneven bands across the shaft, so it reads as light through dusty air.
      const stops: string[] = [];
      const n = 11;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const env = Math.sin(Math.PI * t) ** 1.6;
        const k = i === 0 || i === n ? 0 : env * (0.62 + 0.38 * rng());
        stops.push(`rgba(${r},${g},${b},${(a * k).toFixed(3)}) ${(t * 100).toFixed(1)}%`);
      }
      return `linear-gradient(90deg, ${stops.join(', ')})`;
    };
    // Light pages: the shaft lifts the paper tint. Dark pages: it is warm light in the air.
    const beam = div('beam', paper);
    beam.style.background = this.dark ? streaks(255, 214, 158, 0.17) : streaks(255, 255, 255, 0.85);
    this.beams = [beam];
    const grain = document.createElement('canvas');
    grain.className = 'grain';
    grain.style.opacity = String(STAGE_GRAIN[this.stage]);
    paper.appendChild(grain);
    this.grain = grain;

    this.sprites = makeSprites(this.dark);
    this.glintSprite = makeGlint(this.dark);
    this.grainTile = makeGrainTile(rng, this.dark);
    this.scratchSprite = makeScratch(rng, this.dark);
    this.grainShifts = [];
    for (let i = 0; i < 24; i++) {
      const x = Math.floor(rng() * GRAIN_TILE);
      const y = Math.floor(rng() * GRAIN_TILE);
      this.grainShifts.push(`translate3d(${-x}px, ${-y}px, 0)`);
    }

    const wind = (this.beamSide * (10 + rng() * 20) * Math.PI) / 180;
    this.windX = Math.sin(wind) * 0.07;
    this.windY = 0.045 + rng() * 0.03;

    const c = createCanvas(overlay.layer, 2);
    this.ctx = c.ctx;
    this.resizeCanvas = c.resize;
    this.layout();
    this.motes = [];
    this.fillMotes();
    this.nextArt = performance.now() + this.artInterval() * 0.5;
  }

  /** Size everything to the viewport. Only on start and resize. */
  private layout(): void {
    this.W = innerWidth;
    this.H = innerHeight;
    const { W, H } = this;
    this.resizeCanvas?.();

    // Grain canvas: one tile's worth bigger than the viewport so it can jump around.
    if (this.grain && this.grainTile) {
      const gw = W + GRAIN_TILE;
      const gh = H + GRAIN_TILE;
      this.grain.width = gw;
      this.grain.height = gh;
      this.grain.style.width = `${gw}px`;
      this.grain.style.height = `${gh}px`;
      const g = this.grain.getContext('2d');
      if (g) {
        g.fillStyle = g.createPattern(this.grainTile, 'repeat') ?? 'transparent';
        g.fillRect(0, 0, gw, gh);
      }
    }

    // Light shaft geometry, shared by the CSS beams and the mote lighting.
    const diag = Math.hypot(W, H);
    const width = Math.max(W, H) * this.beamWidth;
    this.beamOX = W * (0.5 - this.beamSide * this.beamOffset);
    this.beamOY = -H * 0.12;
    const rad = (this.beamAngle * Math.PI) / 180;
    // rotate(θ) turns the beam's downward axis (0, 1) into (-sin θ, cos θ).
    this.beamDX = -Math.sin(rad);
    this.beamDY = Math.cos(rad);
    this.beamHalf = width * 0.26;
    this.beamLen = diag * 1.35;
    for (const b of this.beams) {
      b.style.width = `${width}px`;
      b.style.height = `${diag * 1.6}px`;
      b.style.transform = `translate(${this.beamOX - width / 2}px, ${this.beamOY}px) rotate(${this.beamAngle}deg)`;
    }
    if (this.haze) {
      this.haze.style.background = `radial-gradient(circle at ${this.beamOX}px 0px, rgba(255,206,146,.08) 0, rgba(255,206,146,0) ${Math.round(diag * 0.45)}px)`;
    }

    // Air grid.
    this.cols = Math.ceil(W / FIELD_CELL) + 2;
    this.rows = Math.ceil(H / FIELD_CELL) + 2;
    const n = this.cols * this.rows;
    this.fvx = new Float32Array(n);
    this.fvy = new Float32Array(n);
    this.tvx = new Float32Array(n);
    this.tvy = new Float32Array(n);
    this.airAwake = false;

    for (const m of this.motes) {
      if (m.x > W + 40 || m.y > H + 40) {
        m.x = this.rng() * W;
        m.y = this.rng() * H;
      }
    }
  }

  /** Add motes up to the count this stage and viewport call for. */
  private fillMotes(): void {
    const area = (this.W * this.H) / (1280 * 800);
    const want = Math.round(STAGE_MOTES[this.stage] * Math.min(1.8, Math.max(0.6, area)));
    const now = performance.now();
    const rng = this.rng;
    while (this.motes.length < want) {
      const z = rng() ** 2.1;
      const focus = 0.3;
      const blur = z < focus ? ((focus - z) / focus) * 0.3 : (z - focus) / (1 - focus);
      const sprite = Math.min(BLUR_LEVELS - 1, Math.round(blur * (BLUR_LEVELS - 1)));
      const disc = (1.1 + rng() * 1.7) * (1 + 7 * z * z * z);
      // Nearly half start inside the shaft, where the light will find them.
      let x = rng() * this.W;
      let y = rng() * this.H;
      if (rng() < 0.45) {
        const along = rng() * this.beamLen * 0.7;
        const across = (rng() + rng() - 1) * this.beamHalf * 1.4;
        x = this.beamOX + this.beamDX * along - this.beamDY * across;
        y = this.beamOY + this.beamDY * along + this.beamDX * across;
        if (x < 0 || x > this.W || y < 0 || y > this.H) {
          x = rng() * this.W;
          y = rng() * this.H;
        }
      }
      this.motes.push({
        x,
        y,
        vx: 0,
        vy: 0,
        z,
        par: 0.35 + 1.1 * z,
        sprite,
        draw: disc / CORE[sprite],
        alpha: (0.55 + rng() * 0.45) * (1 - 0.8 * z * z),
        th: 0.03 + rng() * 0.97,
        tumbleW: 0.0006 + rng() * 0.0014,
        tumbleP: rng() * Math.PI * 2,
        glintAt: now + 1500 + rng() * 14000,
        glintDur: this.reduced ? 2400 + rng() * 1200 : 450 + rng() * 500,
        born: now + rng() * INTRO_MS * 0.9,
      });
    }
  }

  // --- events ----------------------------------------------------------------

  private listen(on: boolean): void {
    if (on === this.listening) return;
    this.listening = on;
    const f = on ? addEventListener : removeEventListener;
    const opts: AddEventListenerOptions = { passive: true, capture: true };
    f('pointermove', this.onPointer, opts);
    f('scroll', this.onScroll, opts);
    f('resize', this.onResize, opts);
    const d = on ? document.addEventListener.bind(document) : document.removeEventListener.bind(document);
    d('visibilitychange', this.onVisibility, opts);
  }

  private onPointer = (e: PointerEvent): void => {
    const x = e.clientX;
    const y = e.clientY;
    if (!this.hasPointer) {
      this.hasPointer = true;
      this.ptrX = x;
      this.ptrY = y;
      return;
    }
    const dx = x - this.ptrX;
    const dy = y - this.ptrY;
    this.ptrX = x;
    this.ptrY = y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.5) return;
    this.stir(x - dx, y - dy, dx, dy, dist);
    this.wear(dist / (Math.hypot(this.W, this.H) * WEAR_MOUSE));
  };

  private onScroll = (e: Event): void => {
    // Scrolling inside an element: we cannot cheaply tell how far, so count a modest step.
    let dy = 16;
    if (e.target === document || e.target === document.documentElement) {
      dy = scrollY - this.lastScrollY;
      this.lastScrollY = scrollY;
    }
    if (!dy) return;
    // The page drags the air with it a little.
    if (this.fvy.length) {
      const push = Math.max(-6, Math.min(6, -dy * 0.04)) * (this.reduced ? 0.3 : 1);
      for (let i = 0; i < this.fvy.length; i++) this.fvy[i] += push;
      this.airAwake = true;
    }
    this.wear(Math.abs(dy) / (this.H * WEAR_SCROLL));
  };

  private onResize = (): void => {
    this.needsResize = true;
    this.wake();
  };

  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') this.wake();
    else if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  };

  private wear(amount: number): void {
    if (!this.overlay || this.stopping) return;
    this.lastInteract = performance.now();
    this.level = Math.max(0, this.level - amount);
    if (this.level <= 0.015) this.dissolving = true;
    this.wake();
  }

  /** Mouse movement pushes the air: along the stroke, outward from the cursor, curling at the sides. */
  private stir(x0: number, y0: number, dx: number, dy: number, dist: number): void {
    if (!this.fvx.length) return;
    const R = 120;
    const steps = Math.max(1, Math.ceil(dist / (R * 0.4)));
    const sx = dx / steps;
    const sy = dy / steps;
    const speed = Math.min(60, dist) / steps;
    const k = this.reduced ? 0.25 : 1;
    const inv = 1 / (R * R * 0.32);
    const { cols, rows, fvx, fvy } = this;
    const ux = dx / dist;
    const uy = dy / dist;
    for (let s = 1; s <= steps; s++) {
      const cx = x0 + sx * s;
      const cy = y0 + sy * s;
      const i0 = Math.max(0, Math.floor((cx - R) / FIELD_CELL));
      const i1 = Math.min(cols - 1, Math.ceil((cx + R) / FIELD_CELL));
      const j0 = Math.max(0, Math.floor((cy - R) / FIELD_CELL));
      const j1 = Math.min(rows - 1, Math.ceil((cy + R) / FIELD_CELL));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const rx = i * FIELD_CELL - cx;
          const ry = j * FIELD_CELL - cy;
          const d2 = rx * rx + ry * ry;
          if (d2 > R * R) continue;
          const w = Math.exp(-d2 * inv) * k;
          const d = Math.sqrt(d2) + 1;
          const side = ux * ry - uy * rx > 0 ? 1 : -1;
          const idx = j * cols + i;
          fvx[idx] += w * (sx * 0.22 + (rx / d) * speed * 0.16 + side * (-ry / d) * speed * 0.07);
          fvy[idx] += w * (sy * 0.22 + (ry / d) * speed * 0.16 + side * (rx / d) * speed * 0.07);
        }
      }
    }
    this.airAwake = true;
  }

  // --- animation -------------------------------------------------------------

  private wake(): void {
    if (!this.overlay || this.raf || document.visibilityState === 'hidden') return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    this.raf = 0;
    if (!this.overlay) return;
    // When the air is still, the dust runs at film rate: 24fps is plenty for motes this slow, and
    // every repaint of the canvas makes the browser re-blend the layers beneath it.
    const calm = !this.airAwake && this.intro >= 1 && !this.stopping && !this.dissolving && Math.abs(this.level - this.shown) < 0.002;
    if (calm && now - this.lastDraw < 1000 / 24 - 4) {
      this.raf = requestAnimationFrame(this.frame);
      return;
    }
    this.lastDraw = now;
    // Physics steps in 60fps frames, clamped so a stall never makes things jump. Fades and the
    // creep run on real time, so they keep their pace on a slow machine.
    const dt = Math.min(3, Math.max(0, (now - this.last) / (1000 / 60)));
    const dms = Math.min(250, Math.max(0, now - this.last));
    this.last = now;
    if (this.needsResize) {
      this.needsResize = false;
      this.layout();
    }

    // Overall envelope: ease in, wear down with interaction, settle back when left alone, fade out on stop.
    this.intro = Math.min(1, this.intro + dms / (this.reduced ? INTRO_MS * 1.4 : INTRO_MS));
    if (this.stopping) this.fade = Math.max(0, this.fade - dms / FADE_OUT_MS);
    else this.fade = Math.min(1, this.fade + dms / FADE_OUT_MS);
    if (!this.dissolving && !this.stopping && now - this.lastInteract > CREEP_DELAY * 1000) {
      this.level = Math.min(1, this.level + dms / (CREEP_SECONDS * 1000));
    }
    const target = this.dissolving ? 0 : this.level;
    this.shown += (target - this.shown) * (1 - Math.exp(-dms / (this.dissolving ? 420 : 650)));
    if (this.dissolving && this.shown < 0.004) this.shown = 0;

    if ((this.stopping && this.fade <= 0) || (this.dissolving && this.shown <= 0)) {
      this.destroy();
      return;
    }

    const master = smooth(this.intro) * smooth(this.fade);
    const amount = master * Math.pow(this.shown, 0.85);
    this.paintLayers(now, master, amount);
    this.stepAir(dt);
    this.drawMotes(now, dt, master);

    this.raf = requestAnimationFrame(this.frame);
  };

  private setOpacity(el: HTMLElement | null, v: number): void {
    if (!el) return;
    const prev = this.opacity.get(el) ?? -1;
    if (Math.abs(prev - v) < 0.003 && !(v === 0 && prev !== 0)) return;
    this.opacity.set(el, v);
    el.style.opacity = String(Math.round(v * 1000) / 1000);
  }

  private paintLayers(now: number, master: number, amount: number): void {
    const s = this.stage;
    // A faint, slow unsteadiness in the light, like an old projector lamp. Never a strobe.
    const flick = this.reduced ? 1 : 1 + 0.025 * Math.sin(now * 0.0071) * Math.sin(now * 0.0123 + 1.7);
    const creep = smooth(this.intro);
    this.setOpacity(this.tone, STAGE_TONE[s] * amount);
    this.setOpacity(this.paper, STAGE_AGE[s] * amount * flick);
    if (this.vig) {
      // The browning creeps in from the edges as it arrives, and recedes as it wears off.
      const scale = 1 + 0.3 * (1 - creep) + 0.12 * (1 - this.shown);
      if (Math.abs(scale - this.vigScale) > 0.0008) {
        this.vigScale = scale;
        this.vig.style.transform = `scale(${scale.toFixed(4)})`;
      }
    }
    // The shaft breathes, as if cloud passed the sun. Coarse steps: each change repaints the paper.
    const breathe = 0.84 + 0.16 * Math.sin(now * 0.00042 + this.beamPhase) * Math.sin(now * 0.00017 + this.beamPhase * 0.3);
    for (const b of this.beams) this.setOpacity(b, Math.round(breathe * 60) / 60);
    if (this.grain && !this.reduced && now >= this.nextGrain && master > 0) {
      this.nextGrain = now + 1000 / GRAIN_FPS;
      this.grainIndex = (this.grainIndex + 1 + Math.floor(this.rng() * (this.grainShifts.length - 1))) % this.grainShifts.length;
      this.grain.style.transform = this.grainShifts[this.grainIndex];
    }
  }

  private stepAir(dt: number): void {
    if (!this.airAwake) return;
    const { cols, rows, fvx, fvy, tvx, tvy } = this;
    // Self-advection: the air carries its own motion, which turns pushes into curls.
    const back = dt / FIELD_CELL;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const idx = j * cols + i;
        let x = i - fvx[idx] * back;
        let y = j - fvy[idx] * back;
        x = x < 0 ? 0 : x > cols - 1.001 ? cols - 1.001 : x;
        y = y < 0 ? 0 : y > rows - 1.001 ? rows - 1.001 : y;
        const xi = x | 0;
        const yi = y | 0;
        const fx = x - xi;
        const fy = y - yi;
        const a = yi * cols + xi;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        tvx[idx] = (fvx[a] * (1 - fx) + fvx[b] * fx) * (1 - fy) + (fvx[c] * (1 - fx) + fvx[d] * fx) * fy;
        tvy[idx] = (fvy[a] * (1 - fx) + fvy[b] * fx) * (1 - fy) + (fvy[c] * (1 - fx) + fvy[d] * fx) * fy;
      }
    }
    // Diffuse a little and let it calm down.
    const decay = Math.pow(0.968, dt);
    let peak = 0;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const idx = j * cols + i;
        const l = i > 0 ? idx - 1 : idx;
        const r = i < cols - 1 ? idx + 1 : idx;
        const u = j > 0 ? idx - cols : idx;
        const dn = j < rows - 1 ? idx + cols : idx;
        let vx = ((tvx[idx] * 4 + tvx[l] + tvx[r] + tvx[u] + tvx[dn]) / 8) * decay;
        let vy = ((tvy[idx] * 4 + tvy[l] + tvy[r] + tvy[u] + tvy[dn]) / 8) * decay;
        const sp = vx * vx + vy * vy;
        if (sp > 400) {
          const f = 20 / Math.sqrt(sp);
          vx *= f;
          vy *= f;
        }
        fvx[idx] = vx;
        fvy[idx] = vy;
        if (sp > peak) peak = sp;
      }
    }
    if (peak < 0.0004) {
      fvx.fill(0);
      fvy.fill(0);
      this.airAwake = false;
    }
  }

  private drawMotes(now: number, dt: number, master: number): void {
    const g = this.ctx;
    if (!g) return;
    const { W, H, motes, sprites, cols, rows, fvx, fvy, glintSprite } = this;
    g.clearRect(0, 0, W, H);
    if (master <= 0.001) return;
    g.globalCompositeOperation = 'source-over';

    const slow = this.reduced ? 0.3 : 1;
    const brown = 0.018 * slow;
    const sway = Math.sin(now * 0.00021 + this.beamPhase);
    const windX = (this.windX + 0.05 * sway) * slow;
    const windY = this.windY * slow * (0.8 + 0.2 * Math.sin(now * 0.00013));
    const rng = this.rng;
    const shown = this.dissolving ? this.shown : Math.max(this.shown, 0);
    const ox = this.beamOX;
    const oy = this.beamOY;
    const bdx = this.beamDX;
    const bdy = this.beamDY;
    const invHalf = 1 / this.beamHalf;
    const invLen = 1 / this.beamLen;
    const ambient = this.dark ? 0.16 : 0.3;
    const glintPeak = this.reduced ? 0.7 : 2.4;
    const margin = 40;
    const couple = 1 - Math.pow(0.93, dt);
    const damp = Math.pow(0.985, dt);

    for (let n = 0; n < motes.length; n++) {
      const m = motes[n];
      // Air around the mote (bilinear), plus the shared drift, scaled by parallax.
      let ax = 0;
      let ay = 0;
      if (this.airAwake) {
        let gx = m.x / FIELD_CELL;
        let gy = m.y / FIELD_CELL;
        gx = gx < 0 ? 0 : gx > cols - 1.001 ? cols - 1.001 : gx;
        gy = gy < 0 ? 0 : gy > rows - 1.001 ? rows - 1.001 : gy;
        const xi = gx | 0;
        const yi = gy | 0;
        const fx = gx - xi;
        const fy = gy - yi;
        const a = yi * cols + xi;
        ax = (fvx[a] * (1 - fx) + fvx[a + 1] * fx) * (1 - fy) + (fvx[a + cols] * (1 - fx) + fvx[a + cols + 1] * fx) * fy;
        ay = (fvy[a] * (1 - fx) + fvy[a + 1] * fx) * (1 - fy) + (fvy[a + cols] * (1 - fx) + fvy[a + cols + 1] * fx) * fy;
      }
      const tx = (ax + windX) * m.par;
      const ty = (ay + windY) * m.par;
      m.vx += (tx - m.vx) * couple + (rng() - 0.5) * brown * m.par * dt;
      m.vy += (ty - m.vy) * couple + (rng() - 0.5) * brown * m.par * dt;
      m.vx *= damp;
      m.vy *= damp;
      m.x += m.vx * dt;
      m.y += m.vy * dt;

      // Drifted off one edge: come back in softly at the opposite one.
      if (m.x < -margin || m.x > W + margin || m.y < -margin || m.y > H + margin) {
        if (m.x < -margin) m.x = W + margin * 0.5;
        else if (m.x > W + margin) m.x = -margin * 0.5;
        if (m.y < -margin) m.y = H + margin * 0.5;
        else if (m.y > H + margin) m.y = -margin * 0.5;
        m.born = now;
      }

      if (now < m.born) continue;
      const appear = smooth((now - m.born) / 1400);
      const present = smooth((shown - m.th) / 0.14 + 1);
      if (appear <= 0 || present <= 0) continue;

      // How much of the shaft falls on it.
      const rx = m.x - ox;
      const ry = m.y - oy;
      const along = rx * bdx + ry * bdy;
      const perp = (rx * -bdy + ry * bdx) * invHalf;
      const fall = along < 0 ? 0 : 1 - along * invLen;
      const lit = fall <= 0 ? 0 : Math.exp(-perp * perp) * fall * fall;

      // Turning slowly in the light, and now and then catching it.
      const tumble = 0.6 + 0.4 * Math.sin(now * m.tumbleW + m.tumbleP);
      let glint = 0;
      if (now >= m.glintAt) {
        const t = (now - m.glintAt) / m.glintDur;
        if (t >= 1) {
          m.glintAt = now + 4000 + rng() * 18000;
        } else {
          const s = Math.sin(Math.PI * t);
          glint = s * s;
        }
      }
      // Dust whipped up by the air tumbles and catches stray light wherever it is.
      const sp = Math.abs(m.vx) + Math.abs(m.vy);
      const stirred = sp > 0.5 ? Math.min(1, (sp - 0.5) / 3) : 0;
      const light = ambient + (1 - ambient) * Math.min(1.6, lit * (tumble + glint * glintPeak) + stirred * 0.5 * tumble);
      const alpha = m.alpha * light * appear * present * master;
      if (alpha < 0.006) continue;
      const size = m.draw * (1 + glint * lit * 0.25);
      g.globalAlpha = alpha > 1 ? 1 : alpha;
      g.drawImage(sprites[m.sprite], m.x - size / 2, m.y - size / 2, size, size);
      // The glint itself: a small warm flare, gold enough to read even on white.
      if (glint > 0.02 && lit > 0.05 && m.sprite < 3 && glintSprite) {
        const ga = glint * lit * appear * present * master * (this.reduced ? 0.45 : 0.85);
        if (ga > 0.01) {
          const gs = (5 + m.draw * CORE[m.sprite] * 2.2) * (0.7 + 0.3 * glint);
          g.globalAlpha = ga > 1 ? 1 : ga;
          g.drawImage(glintSprite, m.x - gs / 2, m.y - gs / 2, gs, gs);
        }
      }
    }
    g.globalAlpha = 1;
    this.drawArtifact(g, now, master);
  }

  // --- old film artifacts ------------------------------------------------------

  private artInterval(): number {
    const r = this.rng();
    if (this.stage >= 4) return 3500 + r * 7000;
    if (this.stage === 3) return 6000 + r * 9000;
    return 14000 + r * 16000;
  }

  private drawArtifact(g: CanvasRenderingContext2D, now: number, master: number): void {
    const rng = this.rng;
    if (!this.art) {
      if (now < this.nextArt) return;
      this.nextArt = now + this.artInterval();
      // Only while the page still looks properly old, and not for reduced motion.
      if (this.reduced || this.shown < 0.35 || this.intro < 1 || this.stage < 2) return;
      const roll = rng();
      this.art = this.stage >= 4 && roll < 0.28 ? 3 : this.stage >= 3 && roll < 0.62 ? 2 : 1;
      this.artBorn = now;
      this.artX = this.W * (0.08 + rng() * 0.84);
      this.artY = this.H * (0.1 + rng() * 0.8);
      this.artJX = this.artJY = 0;
      this.artNextJitter = 0;
      if (this.art === 1) {
        this.artLife = 160 + rng() * 260;
        this.artLen = 1.2 + rng() * 2.6;
        this.artAlpha = 0.22 + rng() * 0.2;
        for (let i = 0; i < 8; i++) this.artShape[i] = 0.6 + rng() * 0.6;
      } else if (this.art === 2) {
        this.artLife = 700 + rng() * 1100;
        this.artLen = 26 + rng() * 60;
        this.artA = rng() * Math.PI * 2;
        this.artC1 = (rng() - 0.5) * 0.9;
        this.artC2 = (rng() - 0.5) * 0.9;
        this.artAlpha = 0.18 + rng() * 0.14;
      } else {
        this.artLife = 1400 + rng() * 1800;
        this.artY = 0;
        this.artAlpha = 0.07 + rng() * 0.07;
        this.artA = (rng() - 0.5) * 0.04;
      }
    }
    const t = (now - this.artBorn) / this.artLife;
    if (t >= 1) {
      this.art = 0;
      return;
    }
    // Quick but soft edges: in and out over the first and last slice of its life.
    const edge = this.art === 1 ? 0.3 : 0.18;
    const env = smooth(t / edge) * smooth((1 - t) / edge);
    // Film gate weave: the artifact shivers at roughly projector frame rate.
    if (now >= this.artNextJitter) {
      this.artNextJitter = now + 1000 / 14;
      this.artJX = (rng() - 0.5) * (this.art === 3 ? 2.2 : 1.4);
      this.artJY = (rng() - 0.5) * 1.4;
    }
    const a = this.artAlpha * env * master * Math.min(1, this.shown * 1.4);
    if (a < 0.004) return;
    const ink = this.dark ? 'rgb(236,226,204)' : 'rgb(38,28,18)';
    g.globalAlpha = a;
    if (this.art === 1) {
      const x = this.artX + this.artJX;
      const y = this.artY + this.artJY;
      const r = this.artLen;
      g.fillStyle = ink;
      g.beginPath();
      for (let i = 0; i <= 8; i++) {
        const k = i % 8;
        const ang = (k / 8) * Math.PI * 2;
        const rr = r * this.artShape[k];
        const px = x + Math.cos(ang) * rr;
        const py = y + Math.sin(ang) * rr;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.fill();
    } else if (this.art === 2) {
      // A stray hair: it drifts a little and slowly bends while it is in the gate.
      const drift = t * 10;
      const x0 = this.artX + this.artJX + Math.cos(this.artA + 1.2) * drift;
      const y0 = this.artY + this.artJY + Math.sin(this.artA + 1.2) * drift;
      const ang = this.artA + Math.sin(t * 2.4) * 0.25;
      const L = this.artLen;
      const ux = Math.cos(ang);
      const uy = Math.sin(ang);
      const bend1 = this.artC1 + Math.sin(now * 0.004) * 0.06;
      const bend2 = this.artC2 + Math.cos(now * 0.0033) * 0.06;
      g.strokeStyle = ink;
      g.lineWidth = 1.1;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(x0, y0);
      g.bezierCurveTo(
        x0 + ux * L * 0.33 - uy * L * bend1,
        y0 + uy * L * 0.33 + ux * L * bend1,
        x0 + ux * L * 0.66 - uy * L * bend2,
        y0 + uy * L * 0.66 + ux * L * bend2,
        x0 + ux * L,
        y0 + uy * L,
      );
      g.stroke();
    } else if (this.scratchSprite) {
      // A faint vertical scratch running the height of the frame.
      const x = this.artX + this.artJX + t * this.artA * this.W;
      g.drawImage(this.scratchSprite, x - 1, 0, this.dark ? 1.5 : 1.2, this.H);
    }
    g.globalAlpha = 1;
  }
}

// --- procedural textures -------------------------------------------------------

/** Soft round motes at increasing defocus: a crisp speck through to a wide bokeh disc. */
function makeSprites(dark: boolean): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = [];
  // On dark pages dust shines; on light ones it shows as fine warm-grey specks.
  const [r, g, b] = dark ? [255, 240, 212] : [112, 90, 64];
  const [er, eg, eb] = dark ? [255, 226, 180] : [140, 116, 86];
  for (let level = 0; level < BLUR_LEVELS; level++) {
    const c = document.createElement('canvas');
    c.width = c.height = SPRITE_PX;
    const x = c.getContext('2d')!;
    const h = SPRITE_PX / 2;
    const t = level / (BLUR_LEVELS - 1);
    const core = CORE[level];
    const grad = x.createRadialGradient(h, h, 0, h, h, h);
    const rgba = (cr: number, cg: number, cb: number, a: number) => `rgba(${cr},${cg},${cb},${a.toFixed(3)})`;
    if (t < 0.25) {
      // In focus: a bright point with a tight falloff and a darker rim on light pages,
      // so it still reads against white.
      grad.addColorStop(0, rgba(r, g, b, 1));
      grad.addColorStop(core * 0.45, rgba(r, g, b, 0.9));
      grad.addColorStop(core * 0.85, rgba(er, eg, eb, dark ? 0.35 : 0.45));
      grad.addColorStop(Math.min(1, core * 1.5), rgba(er, eg, eb, 0.08));
      grad.addColorStop(1, rgba(er, eg, eb, 0));
    } else {
      // Out of focus: a flat disc with a slightly brighter rim and a soft edge.
      const edge = Math.min(0.98, core + 0.12 + 0.18 * t);
      const k = dark ? 1 : 0.45;
      grad.addColorStop(0, rgba(r, g, b, 0.55 * k));
      grad.addColorStop(core * 0.75, rgba(r, g, b, 0.6 * k));
      grad.addColorStop(core, rgba(r, g, b, 0.72 * k));
      grad.addColorStop(Math.min(0.97, (core + edge) / 2), rgba(er, eg, eb, dark ? 0.22 : 0.18));
      grad.addColorStop(edge, rgba(er, eg, eb, 0));
      grad.addColorStop(1, rgba(er, eg, eb, 0));
    }
    x.fillStyle = grad;
    x.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
    out.push(c);
  }
  return out;
}

/** A tiny warm flare for a mote turning in the light. */
function makeGlint(dark: boolean): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = SPRITE_PX;
  const x = c.getContext('2d')!;
  const h = SPRITE_PX / 2;
  const grad = x.createRadialGradient(h, h, 0, h, h, h);
  grad.addColorStop(0, 'rgba(255,253,244,1)');
  grad.addColorStop(0.1, dark ? 'rgba(255,236,196,0.85)' : 'rgba(255,206,128,0.9)');
  grad.addColorStop(0.32, dark ? 'rgba(255,214,150,0.22)' : 'rgba(240,176,92,0.3)');
  grad.addColorStop(1, 'rgba(255,200,120,0)');
  x.fillStyle = grad;
  x.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
  return c;
}

/** One tile of warm film grain: light and dark flecks around neutral, slightly clumped. */
function makeGrainTile(rng: () => number, dark: boolean): HTMLCanvasElement {
  const S = GRAIN_TILE;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d')!;
  const img = x.createImageData(S, S);
  const d = img.data;
  // Two octaves: fine per-pixel noise plus a coarser clumping, like silver halide.
  const coarse = new Float32Array((S / 2) * (S / 2));
  for (let i = 0; i < coarse.length; i++) coarse[i] = rng() + rng() - 1;
  const gain = dark ? 0.1 : 0.085;
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const fine = rng() + rng() + rng() - 1.5;
      const v = fine * 0.75 + coarse[(py >> 1) * (S / 2) + (px >> 1)] * 0.45;
      const i = (py * S + px) * 4;
      const a = Math.min(1, Math.abs(v) * gain);
      if (v > 0) {
        d[i] = 255;
        d[i + 1] = 244;
        d[i + 2] = 222;
      } else {
        d[i] = 34;
        d[i + 1] = 24;
        d[i + 2] = 12;
      }
      d[i + 3] = Math.round(a * 255);
    }
  }
  x.putImageData(img, 0, 0);
  return c;
}

/** A thin vertical scratch, broken and uneven along its length. */
function makeScratch(rng: () => number, dark: boolean): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 512;
  const x = c.getContext('2d')!;
  let y = 0;
  while (y < 512) {
    const len = 8 + rng() * 90;
    const gap = rng() < 0.3 ? 4 + rng() * 40 : 0;
    x.fillStyle = `rgba(${dark ? '240,230,210' : '40,30,20'},${(0.35 + rng() * 0.65).toFixed(2)})`;
    x.fillRect(0, y, 2, len);
    y += len + gap;
  }
  return c;
}
