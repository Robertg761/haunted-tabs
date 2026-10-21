// Dust and decay: film grain, a yellowing vignette, and motes drifting in a shaft of light. Thickens with the stage and settles as you interact.
//
// Layers, bottom to top, all inside our own shadow root and all click-through:
//   tone   mix-blend-mode: color  a faint sepia wash that drains the page's colour, never its contrast
//   paper  on light pages mix-blend-mode: multiply: cream paper, edges browning inward, lifted where
//          the light falls. On dark pages a light-touch veil instead (multiply would barely show):
//          a soft brown vignette at the very edges and the shaft as faint warm light. Film grain
//          lives inside it.
//   motes  a small canvas over the shaft only: dust in the light, film specks, hairs, a scratch
//
// Performance is the design constraint. Blend layers cost nothing while nothing moves, but every
// change above or below them makes the browser re-blend them (in software that is a large share of
// a core). So the blend layers never animate on their own, and the dust itself goes to sleep: after
// the intro and a few seconds of stillness the motes settle out of the air and the animation loop
// stops completely, leaving a static aged page. Moving the mouse kicks the dust back up for a
// while; scrolling and moving also wear the whole effect away. Total animated time is capped.
// Other effects (fog, eyes, cobwebs) animate above dust all the time, which would keep the blend
// layers re-blending however still the dust is. So while any other effect shares the page, dust
// crossfades to a plain tint and vignette with ordinary compositing, and back when it is alone.

import type { Effect, EffectContext } from './types';
import { createOverlay, OUR_ATTR, seeded, Z, type Overlay } from './overlay';

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
const STAGE_PAPER_LIGHT = [0, 0.74, 0.82, 0.9, 1];
const STAGE_PAPER_DARK = [0, 0.6, 0.74, 0.87, 1];
const STAGE_GRAIN = [0, 0.6, 0.72, 0.86, 1];
const STAGE_MOTES = [0, 60, 85, 110, 135];

const INTRO_MS = 3200;
const FADE_OUT_MS = 1200;
/** How long the dust keeps drifting after the intro before it settles and the loop sleeps. */
const ALIVE_MS = 6000;
/** After the air goes still following a stir, how long before the dust settles again. */
const STIR_LINGER_MS = 3500;
const SETTLE_MS = 2500;
const RISE_MS = 600;
/**
 * Scrolling moves the whole page under the blend layers, which forces a full re-blend on every
 * frame. So while the page scrolls they step aside quickly, and seep back once it has rested.
 */
const GATE_OUT_MS = 450;
const GATE_REST_MS = 2500;
const GATE_IN_MS = 3000;
/** Crossfade between the blend look (alone) and the plain look (other effects present). */
const COMPANY_FADE_MS = 600;
/** Total time the dust may spend animating while visible; after that the page only stays aged. */
const ANIM_BUDGET_MS = 120_000;
/** A hidden tab is not being welcomed back: let go of everything after this long. */
const HIDDEN_LINGER_MS = 30_000;
const GRAIN_TILE = 256;
const GRAIN_FPS = 8;
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

/**
 * A root filtered with invert() (Dark Reader's filter mode, "night mode" sites) shows the
 * opposite of its colours. Our host is lifted out of that filter, so judge what is on screen.
 */
function rootInverted(): boolean {
  try {
    const m = /invert\(\s*([\d.]+)(%?)\s*\)/.exec(getComputedStyle(document.documentElement).filter);
    return !!m && Number(m[1]) / (m[2] ? 100 : 1) > 0.5;
  } catch {
    return false;
  }
}

/** Is the page, as it shows on screen, mostly dark? */
function pageIsDark(): boolean {
  return pageIsDarkRaw() !== rootInverted();
}

/** Is the page mostly dark, by its own background colours? Our layers never take hits, so they are not sampled. */
function pageIsDarkRaw(): boolean {
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

/**
 * A playing video that fills a good part of the window. Blend layers over it would tint the video
 * and re-blend on every one of its frames, so the dust stays off such pages.
 */
function isBigPlayingVideo(v: Element): boolean {
  if (!(v instanceof HTMLVideoElement) || v.paused || v.ended) return false;
  const r = v.getBoundingClientRect();
  const w = Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left));
  const h = Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top));
  return w * h > innerWidth * innerHeight * 0.2;
}

const CSS = `
  .fx { position: fixed; inset: 0; pointer-events: none; overflow: hidden; z-index: ${Z.dust}; opacity: 0; }
  .tone { mix-blend-mode: color; background: rgb(168, 128, 78); }
  .paper.light { mix-blend-mode: multiply; background: rgb(250, 240, 218); }
  /* Plain compositing lifts dark text as well as tinting the page, so the middle stays clear. */
  .flat { background: radial-gradient(ellipse 74% 70% at 50% 47%, rgba(236,214,172,0) 45%, rgba(214,176,120,.11) 76%, rgba(160,116,66,.24) 100%); }
  .vig { position: absolute; inset: -14%;
    background: radial-gradient(ellipse 72% 68% at 50% 47%, rgba(255,255,255,0) 38%, rgba(226,196,148,.5) 70%, rgba(170,124,70,.92) 100%); }
  .dark .vig { background: radial-gradient(ellipse 72% 68% at 50% 47%, rgba(16,10,4,0) 62%, rgba(18,11,4,.14) 80%, rgba(8,5,2,.3) 100%); }
  .haze { position: absolute; inset: 0; }
  .beam { position: absolute; left: 0; top: 0; transform-origin: 50% 0;
    -webkit-mask-image: linear-gradient(180deg, #000 0%, rgba(0,0,0,.75) 35%, rgba(0,0,0,.25) 70%, transparent 95%);
    mask-image: linear-gradient(180deg, #000 0%, rgba(0,0,0,.75) 35%, rgba(0,0,0,.25) 70%, transparent 95%); }
  .grain { position: absolute; left: 0; top: 0; }
  .motes { position: absolute; left: 0; top: 0; }
`;

export class Dust implements Effect {
  readonly name = 'dust' as const;

  private overlay: Overlay | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private canvasLive = false;
  private tone: HTMLDivElement | null = null;
  private paper: HTMLDivElement | null = null;
  private vig: HTMLDivElement | null = null;
  private haze: HTMLDivElement | null = null;
  private beam: HTMLDivElement | null = null;
  private grain: HTMLCanvasElement | null = null;
  private grainTile: HTMLCanvasElement | null = null;
  private nextGrain = 0;
  private sprites: HTMLCanvasElement[] = [];
  private glintSprite: HTMLCanvasElement | null = null;
  private scratchSprite: HTMLCanvasElement | null = null;

  private rng: () => number = Math.random;
  private seed = 0;
  private stage = 1;
  private reduced = false;
  private dark = false;

  private W = 0;
  private H = 0;
  /** The motes canvas covers only the shaft's bounding box, in viewport px. */
  private bx = 0;
  private by = 0;
  private bw = 0;
  private bh = 0;
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

  /** How present the airborne dust is (0 settled .. 1 drifting). The loop sleeps once it is 0. */
  private settle = 0;
  /** The dust stays up until this time (performance.now()), unless the air is still moving. */
  private aliveUntil = 0;
  /** Animated time spent so far, against ANIM_BUDGET_MS. */
  private animMs = 0;
  private asleep = false;
  /** Scroll gate for the blend layers (0 stepped aside .. 1 fully present). */
  private gate = 1;
  private blendHidden = false;
  /** Plain stand-in for the blend layers while other effects share the page (light pages only). */
  private flat: HTMLDivElement | null = null;
  private flatHidden = false;
  /** 1: the full blend look (dust alone); 0: the plain look (company). */
  private mix = 1;
  private company = false;
  private hostObserver: MutationObserver | null = null;
  private themeObserver: MutationObserver | null = null;
  private scheme: MediaQueryList | null = null;
  private themeTimer: number | undefined;
  private lastScrollAt = -Infinity;
  private restTimer: number | undefined;

  private hasPointer = false;
  private ptrX = 0;
  private ptrY = 0;
  private lastScrollTop = 0;
  private scrollPending = false;
  private elementScroll = 0;

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
  /** Inside a frame: a wake from within (scroll read, wear) must not start a second loop. */
  private inFrame = false;
  private lastDraw = 0;
  private last = 0;
  private stopTimer: number | undefined;
  private hiddenTimer: number | undefined;
  private resizeTimer: number | undefined;
  private creepTimer: number | undefined;
  private needsResize = false;
  private listening = false;
  private vigScale = 0;
  private readonly opacity = new Map<HTMLElement, number>();

  get active(): boolean {
    return !!this.overlay;
  }

  start(ctx: EffectContext): void {
    const stage = Math.max(1, Math.min(4, ctx.stage || 1));
    this.reduced = ctx.reduced;
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
      this.kickUp(ALIVE_MS);
      this.wake();
      return;
    }
    if (Array.from(document.querySelectorAll('video')).some(isBigPlayingVideo)) return;
    this.stage = stage;
    this.seed = ctx.seed;
    this.rng = seeded(ctx.seed ^ 0x5eed_d057);
    this.dark = pageIsDark();
    this.level = 1;
    this.shown = 1;
    this.intro = 0;
    this.fade = 1;
    this.settle = 0;
    this.animMs = 0;
    this.asleep = false;
    this.gate = 1;
    this.blendHidden = false;
    this.flatHidden = false;
    this.lastScrollAt = -Infinity;
    this.stopping = false;
    this.dissolving = false;
    this.lastInteract = performance.now();
    this.aliveUntil = performance.now() + INTRO_MS + ALIVE_MS;
    this.lastScrollTop = document.scrollingElement?.scrollTop ?? 0;
    this.scrollPending = false;
    this.elementScroll = 0;
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
    clearTimeout(this.hiddenTimer);
    clearTimeout(this.resizeTimer);
    clearInterval(this.creepTimer);
    clearTimeout(this.restTimer);
    clearTimeout(this.themeTimer);
    this.stopTimer = this.hiddenTimer = this.resizeTimer = this.creepTimer = this.restTimer = this.themeTimer = undefined;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.listen(false);
    this.teardown();
    this.fvx = this.fvy = this.tvx = this.tvy = new Float32Array(0);
  }

  /** Remove the overlay and everything drawn in it (the state of the haunting stays). */
  private teardown(): void {
    this.hostObserver?.disconnect();
    this.hostObserver = null;
    // Let go of the bitmaps right away rather than waiting for the collector.
    if (this.canvas) this.canvas.width = this.canvas.height = 0;
    if (this.grain) this.grain.width = this.grain.height = 0;
    this.overlay?.remove();
    this.overlay = null;
    this.canvas = this.ctx = null;
    this.canvasLive = false;
    this.tone = this.paper = this.vig = this.haze = this.beam = this.flat = null;
    this.grain = this.grainTile = this.scratchSprite = this.glintSprite = null;
    this.sprites = [];
    this.motes = [];
    this.opacity.clear();
    this.blendHidden = this.flatHidden = false;
    this.vigScale = 0;
    this.art = 0;
  }

  /**
   * The page switched between light and dark: the look is built for one or the other (multiply
   * paper on light pages, a light veil on dark ones), so build it again for the new background,
   * keeping how worn the haunting is. The same seed puts the shaft of light in the same place.
   */
  private onTheme = (): void => {
    // At most a few checks a second, however busily the page rewrites its classes.
    if (this.themeTimer !== undefined || !this.overlay) return;
    this.themeTimer = window.setTimeout(() => {
      this.themeTimer = undefined;
      if (!this.overlay || this.stopping || this.dissolving) return;
      // A root that gains a transform or filter gets our host lifted into the top layer.
      this.onHosts();
      const dark = pageIsDark();
      if (dark === this.dark) return;
      this.dark = dark;
      this.teardown();
      this.rng = seeded(this.seed ^ 0x5eed_d057);
      this.build();
      this.paintLayers(smooth(this.intro) * smooth(this.fade) * Math.pow(this.shown, 0.85));
      this.kickUp(STIR_LINGER_MS);
      this.wake();
    }, 300);
  };

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
    const layers: HTMLElement[] = [tone, paper];
    if (!this.dark) {
      const flat = document.createElement('div');
      flat.className = 'fx flat';
      layers.push(flat);
      this.flat = flat;
    }
    for (const el of layers) overlay.root.insertBefore(el, overlay.layer);
    this.tone = tone;
    this.paper = paper;
    // Watch for other effects arriving or leaving: their hosts are direct children of <html>.
    this.hostObserver = new MutationObserver(this.onHosts);
    this.hostObserver.observe(document.documentElement, { childList: true });
    this.company = this.hasCompany();
    this.mix = this.company ? 0 : 1;
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
    // Light pages: the shaft lifts the paper tint. Dark pages: faint warm light in the air, kept
    // low so it never lifts the background behind text by much.
    const beam = div('beam', paper);
    beam.style.background = this.dark ? streaks(255, 214, 158, 0.055) : streaks(255, 255, 255, 0.95);
    this.beam = beam;
    const grain = document.createElement('canvas');
    grain.className = 'grain';
    grain.style.opacity = String(STAGE_GRAIN[this.stage]);
    paper.appendChild(grain);
    this.grain = grain;

    this.sprites = makeSprites(this.dark);
    this.glintSprite = makeGlint(this.dark);
    this.grainTile = makeGrainTile(rng, this.dark);
    this.scratchSprite = makeScratch(rng, this.dark);

    const wind = (this.beamSide * (10 + rng() * 20) * Math.PI) / 180;
    this.windX = Math.sin(wind) * 0.07;
    this.windY = 0.045 + rng() * 0.03;

    // The motes canvas: device pixel ratio 1 (the dust is soft anyway) and only as big as the shaft.
    const canvas = document.createElement('canvas');
    canvas.className = 'motes';
    overlay.layer.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.layout();
    this.motes = [];
    this.fillMotes();
    this.nextArt = performance.now() + INTRO_MS + this.artInterval() * 0.4;
  }

  /** Size everything to the viewport. Only on start and (debounced) resize. */
  private layout(): void {
    this.W = innerWidth;
    this.H = innerHeight;
    const { W, H } = this;

    // Light shaft geometry, shared by the CSS beam, the mote lighting and the canvas bounds.
    const diag = Math.hypot(W, H);
    const width = Math.max(W, H) * this.beamWidth;
    this.beamOX = W * (0.5 - this.beamSide * this.beamOffset);
    this.beamOY = -H * 0.12;
    const rad = (this.beamAngle * Math.PI) / 180;
    // rotate(θ) turns the beam's downward axis (0, 1) into (-sin θ, cos θ).
    this.beamDX = -Math.sin(rad);
    this.beamDY = Math.cos(rad);
    this.beamHalf = width * 0.26;
    // The dust hangs in the upper part of the shaft, near where the light comes in; keeping it
    // there keeps the canvas (and what the browser must re-blend each frame) small.
    this.beamLen = diag * 0.46;
    if (this.beam) {
      this.beam.style.width = `${width}px`;
      this.beam.style.height = `${diag * 1.6}px`;
      this.beam.style.transform = `translate(${this.beamOX - width / 2}px, ${this.beamOY}px) rotate(${this.beamAngle}deg)`;
    }
    if (this.haze) {
      this.haze.style.background = `radial-gradient(circle at ${this.beamOX}px 0px, rgba(255,206,146,.025) 0, rgba(255,206,146,0) ${Math.round(diag * 0.45)}px)`;
    }

    // Canvas bounds: the shaft's rectangle (out to where its light has gone), clipped to the window.
    const half = this.beamHalf * 1.7;
    const len = this.beamLen * 0.95;
    const nx = -this.beamDY;
    const ny = this.beamDX;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const t of [0, len]) {
      for (const s of [-half, half]) {
        const x = this.beamOX + this.beamDX * t + nx * s;
        const y = this.beamOY + this.beamDY * t + ny * s;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
    this.bx = Math.max(0, Math.floor(x0));
    this.by = Math.max(0, Math.floor(y0));
    this.bw = Math.max(1, Math.min(W, Math.ceil(x1)) - this.bx);
    this.bh = Math.max(1, Math.min(H, Math.ceil(y1)) - this.by);
    if (this.canvas) {
      this.canvas.style.transform = `translate(${this.bx}px, ${this.by}px)`;
      this.canvas.style.width = `${this.bw}px`;
      this.canvas.style.height = `${this.bh}px`;
      if (this.canvasLive) this.sizeCanvas(true);
    }

    // Grain: viewport-sized at 1x. It jumps (redrawn at a new offset) only during the intro.
    if (this.grain) {
      this.grain.width = W;
      this.grain.height = H;
      this.grain.style.width = `${W}px`;
      this.grain.style.height = `${H}px`;
      this.paintGrain(0, 0);
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
      if (m.x < this.bx - 40 || m.x > this.bx + this.bw + 40 || m.y < this.by - 40 || m.y > this.by + this.bh + 40) {
        this.placeMote(m);
      }
    }
  }

  /** Give the motes canvas its backing store (or drop it while the dust sleeps). */
  private sizeCanvas(on: boolean): void {
    const c = this.canvas;
    if (!c) return;
    if (on) {
      if (c.width !== this.bw || c.height !== this.bh) {
        c.width = this.bw;
        c.height = this.bh;
      }
      this.ctx?.setTransform(1, 0, 0, 1, -this.bx, -this.by);
    } else {
      c.width = c.height = 0;
    }
    this.canvasLive = on;
  }

  private paintGrain(ox: number, oy: number): void {
    const g = this.grain?.getContext('2d');
    if (!g || !this.grainTile) return;
    const pattern = g.createPattern(this.grainTile, 'repeat');
    if (!pattern) return;
    g.setTransform(1, 0, 0, 1, -ox, -oy);
    g.clearRect(ox, oy, this.W, this.H);
    g.fillStyle = pattern;
    g.fillRect(ox, oy, this.W, this.H);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Mostly inside the shaft, where the light will find it; a few loose in the rest of the canvas. */
  private placeMote(m: Mote): void {
    const rng = this.rng;
    if (rng() < 0.78) {
      const along = rng() * this.beamLen * 0.85;
      const across = (rng() + rng() - 1) * this.beamHalf * 1.3;
      m.x = this.beamOX + this.beamDX * along - this.beamDY * across;
      m.y = this.beamOY + this.beamDY * along + this.beamDX * across;
      if (m.x >= this.bx && m.x <= this.bx + this.bw && m.y >= this.by && m.y <= this.by + this.bh) return;
    }
    m.x = this.bx + rng() * this.bw;
    m.y = this.by + rng() * this.bh;
  }

  /** Add motes up to the count this stage and viewport call for. */
  private fillMotes(): void {
    const area = (this.W * this.H) / (1280 * 800);
    const want = Math.round(STAGE_MOTES[this.stage] * (this.dark ? 1 : 1.3) * Math.min(1.8, Math.max(0.6, area)));
    const now = performance.now();
    const rng = this.rng;
    while (this.motes.length < want) {
      const z = rng() ** 2.1;
      const focus = 0.3;
      const blur = z < focus ? ((focus - z) / focus) * 0.3 : (z - focus) / (1 - focus);
      const sprite = Math.min(BLUR_LEVELS - 1, Math.round(blur * (BLUR_LEVELS - 1)));
      // Light pages get slightly bigger dust: a sunlit speck has less contrast against white.
      const disc = (1.1 + rng() * 1.7) * (this.dark ? 1 : 1.35) * (1 + 7 * z * z * z);
      const m: Mote = {
        x: 0,
        y: 0,
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
        glintAt: now + 1500 + rng() * (this.dark ? 10000 : 7000),
        glintDur: this.reduced ? 2400 + rng() * 1200 : 450 + rng() * 500,
        born: now + rng() * INTRO_MS * 0.9,
      };
      this.placeMote(m);
      this.motes.push(m);
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
    d('play', this.onPlay, opts);
    if (on) {
      this.themeObserver = new MutationObserver(this.onTheme);
      const themeOpts = { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'data-bs-theme'] };
      this.themeObserver.observe(document.documentElement, themeOpts);
      if (document.body) this.themeObserver.observe(document.body, themeOpts);
      this.scheme = matchMedia('(prefers-color-scheme: dark)');
      this.scheme.addEventListener('change', this.onTheme);
    } else {
      this.themeObserver?.disconnect();
      this.themeObserver = null;
      this.scheme?.removeEventListener('change', this.onTheme);
      this.scheme = null;
    }
  }

  /**
   * On a page that transforms or filters <html> our host is lifted into the top layer (see
   * attachHost). That is an isolated blend group: the blend layers would mix with nothing and
   * paint solid beige over the whole page. There only the plain look is safe.
   */
  private lifted(): boolean {
    try {
      return !!this.overlay?.host.matches(':popover-open');
    } catch {
      return false;
    }
  }

  private hasCompany(): boolean {
    if (this.lifted()) return true;
    const own = this.overlay?.host;
    for (const el of Array.from(document.documentElement.children)) {
      if (el !== own && el.tagName === 'DIV' && el.hasAttribute(OUR_ATTR)) return true;
    }
    return false;
  }

  private onHosts = (): void => {
    const company = this.hasCompany();
    // Lifted into the top layer: no crossfade, the blend layers must not show for a single frame.
    if (company && this.lifted() && this.mix > 0) {
      this.mix = 0;
      this.paintLayers(smooth(this.intro) * smooth(this.fade) * Math.pow(this.shown, 0.85));
    }
    if (company === this.company) return;
    this.company = company;
    this.wake();
  };

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
    if (this.canAnimate()) this.stir(x - dx, y - dy, dx, dy, dist);
    this.wear(dist / (Math.hypot(this.W, this.H) * WEAR_MOUSE));
  };

  private onScroll = (e: Event): void => {
    // Only note it here; the frame reads the scroll position, so this handler never forces layout.
    // Scrolling inside an element: we cannot cheaply tell how far, so count a modest step.
    if (e.target === document || e.target === document.documentElement) this.scrollPending = true;
    else this.elementScroll += 16;
    this.lastInteract = performance.now();
    this.wake();
  };

  private onResize = (): void => {
    // Dragging a window edge fires this constantly; rebuild once it stops.
    clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = undefined;
      this.needsResize = true;
      this.wake();
    }, 150);
  };

  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') {
      clearTimeout(this.hiddenTimer);
      this.hiddenTimer = undefined;
      this.wake();
      return;
    }
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    clearTimeout(this.hiddenTimer);
    this.hiddenTimer = window.setTimeout(() => this.destroy(), HIDDEN_LINGER_MS);
  };

  private onPlay = (e: Event): void => {
    if (e.target instanceof Element && isBigPlayingVideo(e.target)) this.stop();
  };

  private wear(amount: number): void {
    if (!this.overlay || this.stopping) return;
    this.lastInteract = performance.now();
    this.level = Math.max(0, this.level - amount);
    if (this.level <= 0.015) this.dissolving = true;
    this.wake();
  }

  private canAnimate(): boolean {
    return this.animMs < ANIM_BUDGET_MS;
  }

  /** Lift the dust back into the air for at least `ms`. */
  private kickUp(ms: number): void {
    if (!this.canAnimate()) return;
    this.aliveUntil = Math.max(this.aliveUntil, performance.now() + ms);
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
    this.kickUp(STIR_LINGER_MS);
  }

  // --- animation -------------------------------------------------------------

  private wake(): void {
    if (!this.overlay || this.raf || this.inFrame || document.visibilityState === 'hidden') return;
    if (this.asleep) {
      this.asleep = false;
      clearInterval(this.creepTimer);
      this.creepTimer = undefined;
    }
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Stop the loop entirely. Only a slow timer remains, to let the page age back if it was worn. */
  private sleep(): void {
    this.asleep = true;
    if (this.canvasLive) this.sizeCanvas(false);
    if (this.level < 1 && !this.dissolving) {
      clearInterval(this.creepTimer);
      this.creepTimer = window.setInterval(this.creepTick, 1000);
    }
  }

  private creepTick = (): void => {
    if (!this.overlay || !this.asleep) return;
    if (performance.now() - this.lastInteract < CREEP_DELAY * 1000) return;
    // Small enough steps that a once-a-second change in these faint layers never reads as a step.
    this.level = Math.min(1, this.level + 1 / CREEP_SECONDS);
    this.shown = this.level;
    this.paintLayers(Math.pow(this.shown, 0.85));
    if (this.level >= 1) {
      clearInterval(this.creepTimer);
      this.creepTimer = undefined;
    }
  };

  private frame = (now: number): void => {
    this.raf = 0;
    this.inFrame = true;
    try {
      this.step(now);
    } finally {
      this.inFrame = false;
    }
  };

  private step(now: number): void {
    if (!this.overlay) return;
    // Film rate: 24fps is plenty for dust, even swirling.
    if (now - this.lastDraw < 1000 / 24 - 4) {
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
    this.readScroll();
    const resting = now - this.lastScrollAt > GATE_REST_MS;
    this.gate = resting ? Math.min(1, this.gate + dms / GATE_IN_MS) : Math.max(0, this.gate - dms / GATE_OUT_MS);
    this.mix = this.company ? Math.max(0, this.mix - dms / COMPANY_FADE_MS) : Math.min(1, this.mix + dms / COMPANY_FADE_MS);

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

    // Is the dust up in the air? Only during the intro, a while after it, and while stirred.
    const up = this.canAnimate() && !this.stopping && (this.intro < 1 || this.airAwake || now < this.aliveUntil);
    this.settle = up ? Math.min(1, this.settle + dms / RISE_MS) : Math.max(0, this.settle - dms / SETTLE_MS);
    const flying = this.settle > 0 || this.art !== 0;
    if (flying) this.animMs += dms;

    const master = smooth(this.intro) * smooth(this.fade);
    const amount = master * Math.pow(this.shown, 0.85);
    this.paintLayers(amount);
    if (this.grain && !this.reduced && this.intro < 1 && now >= this.nextGrain) {
      this.nextGrain = now + 1000 / GRAIN_FPS;
      this.paintGrain(Math.floor(this.rng() * GRAIN_TILE), Math.floor(this.rng() * GRAIN_TILE));
    }
    if (this.canAnimate()) this.stepAir(dt);
    else this.airAwake = false;
    if (flying) {
      if (!this.canvasLive) this.sizeCanvas(true);
      this.drawMotes(now, dt, master);
    } else if (this.canvasLive) {
      this.sizeCanvas(false);
    }

    // Nothing left to move: stop the loop until something wakes it.
    const settled =
      !flying &&
      !this.airAwake &&
      this.intro >= 1 &&
      !this.stopping &&
      !this.dissolving &&
      this.fade >= 1 &&
      (this.gate >= 1 || (this.gate <= 0 && !resting)) &&
      this.mix === (this.company ? 0 : 1) &&
      Math.abs(target - this.shown) < 0.01;
    if (settled) {
      if (this.gate <= 0) {
        // Wake again when the page has rested, to bring the layers back.
        clearTimeout(this.restTimer);
        this.restTimer = window.setTimeout(() => {
          this.restTimer = undefined;
          this.wake();
        }, GATE_REST_MS - (now - this.lastScrollAt) + 30);
      }
      this.shown = target;
      this.paintLayers(master * Math.pow(this.shown, 0.85));
      this.sleep();
      return;
    }
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Scroll since the last frame, read here rather than in the scroll handler. */
  private readScroll(): void {
    let dy = 0;
    if (this.scrollPending) {
      this.scrollPending = false;
      const top = document.scrollingElement?.scrollTop ?? 0;
      dy = top - this.lastScrollTop;
      this.lastScrollTop = top;
    }
    if (this.elementScroll) {
      dy += this.elementScroll;
      this.elementScroll = 0;
    }
    if (!dy) return;
    this.lastScrollAt = performance.now();
    // The page drags the air with it a little, if the dust is up (scrolling never lifts it: that
    // would only add work while the page is busy moving).
    if (this.fvy.length && this.settle > 0 && this.canAnimate()) {
      const push = Math.max(-6, Math.min(6, -dy * 0.04)) * (this.reduced ? 0.3 : 1);
      for (let i = 0; i < this.fvy.length; i++) this.fvy[i] += push;
      this.airAwake = true;
    }
    this.wear(Math.abs(dy) / (this.H * WEAR_SCROLL));
  }

  /**
   * Opacity in coarse steps of 1/50. Each change makes the browser re-blend the whole window, and
   * on layers this faint a 0.02 step is under one colour level, so the steps never show.
   */
  private setOpacity(el: HTMLElement | null, v: number): void {
    if (!el) return;
    const q = Math.round(v * 50) / 50;
    if (this.opacity.get(el) === q) return;
    this.opacity.set(el, q);
    el.style.opacity = String(q);
  }

  /** The blend layers. They only change while the effect arrives, wears, creeps back or leaves. */
  private paintLayers(amount: number): void {
    const s = this.stage;
    // The blend layers: colour wash, and on light pages the multiply paper. They step aside for
    // scrolling and for company. Dark pages' paper is plain compositing and needs neither.
    const blend = smooth(this.gate) * smooth(this.mix);
    this.setOpacity(this.tone, STAGE_TONE[s] * amount * blend);
    if (this.dark) this.setOpacity(this.paper, STAGE_PAPER_DARK[s] * amount);
    else this.setOpacity(this.paper, STAGE_PAPER_LIGHT[s] * amount * blend);
    // Fully stepped aside: take them out of compositing altogether.
    const hide = blend <= 0;
    if (hide !== this.blendHidden && this.tone && this.paper) {
      this.blendHidden = hide;
      this.tone.style.visibility = hide ? 'hidden' : '';
      if (!this.dark) this.paper.style.visibility = hide ? 'hidden' : '';
    }
    if (this.flat) {
      const plain = 1 - smooth(this.mix);
      this.setOpacity(this.flat, STAGE_PAPER_LIGHT[s] * amount * plain);
      const flatHide = plain <= 0;
      if (flatHide !== this.flatHidden) {
        this.flatHidden = flatHide;
        this.flat.style.visibility = flatHide ? 'hidden' : '';
      }
    }
    if (this.vig) {
      // The browning creeps in from the edges as it arrives.
      const scale = 1 + 0.3 * (1 - smooth(this.intro));
      if (Math.abs(scale - this.vigScale) > 0.004 || (scale === 1 && this.vigScale !== 1)) {
        this.vigScale = scale;
        this.vig.style.transform = `scale(${scale.toFixed(4)})`;
      }
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
    const { motes, sprites, cols, rows, fvx, fvy, glintSprite, bx, by, bw, bh } = this;
    g.clearRect(bx, by, bw, bh);
    const vis = master * smooth(this.settle);
    if (vis > 0.001) {
      const slow = this.reduced ? 0.3 : 1;
      const brown = 0.018 * slow;
      const sway = Math.sin(now * 0.00021 + this.beamPhase);
      const windX = (this.windX + 0.05 * sway) * slow;
      const windY = this.windY * slow * (0.8 + 0.2 * Math.sin(now * 0.00013));
      const rng = this.rng;
      const shown = this.shown;
      const ox = this.beamOX;
      const oy = this.beamOY;
      const bdx = this.beamDX;
      const bdy = this.beamDY;
      const invHalf = 1 / this.beamHalf;
      const invLen = 1 / this.beamLen;
      const ambient = this.dark ? 0.12 : 0.1;
      const glintPeak = this.reduced ? 0.7 : 2.4;
      const margin = 30;
      const left = bx - margin;
      const right = bx + bw + margin;
      const top = by - margin;
      const bottom = by + bh + margin;
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

        // Drifted out of the canvas: come back in softly at the opposite side.
        if (m.x < left || m.x > right || m.y < top || m.y > bottom) {
          if (m.x < left) m.x = right - margin * 0.5;
          else if (m.x > right) m.x = left + margin * 0.5;
          if (m.y < top) m.y = bottom - margin * 0.5;
          else if (m.y > bottom) m.y = top + margin * 0.5;
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
            m.glintAt = now + 4000 + rng() * (this.dark ? 18000 : 11000);
          } else {
            const s = Math.sin(Math.PI * t);
            glint = s * s;
          }
        }
        // Dust whipped up by the air tumbles and catches stray light wherever it is.
        const sp = Math.abs(m.vx) + Math.abs(m.vy);
        const stirred = sp > 0.5 ? Math.min(1, (sp - 0.5) / 3) : 0;
        const light = ambient + (1 - ambient) * Math.min(1.6, lit * (tumble + glint * glintPeak) + stirred * 0.5 * tumble);
        const alpha = m.alpha * light * appear * present * vis;
        if (alpha < 0.006) continue;
        const size = m.draw * (1 + glint * lit * 0.25);
        g.globalAlpha = alpha > 1 ? 1 : alpha;
        g.drawImage(sprites[m.sprite], m.x - size / 2, m.y - size / 2, size, size);
        // The glint itself: a small warm flare, gold enough to read even on white.
        if (glint > 0.02 && lit > 0.05 && m.sprite < 3 && glintSprite) {
          const ga = glint * lit * appear * present * vis * (this.reduced ? 0.45 : 0.85);
          if (ga > 0.01) {
            const gs = (5 + m.draw * CORE[m.sprite] * 2.2) * (0.7 + 0.3 * glint);
            g.globalAlpha = ga > 1 ? 1 : ga;
            g.drawImage(glintSprite, m.x - gs / 2, m.y - gs / 2, gs, gs);
          }
        }
      }
      g.globalAlpha = 1;
    }
    this.drawArtifact(g, now, master);
  }

  // --- old film artifacts ------------------------------------------------------

  private artInterval(): number {
    const r = this.rng();
    if (this.stage >= 4) return 3500 + r * 6000;
    if (this.stage === 3) return 5000 + r * 8000;
    return 12000 + r * 14000;
  }

  private drawArtifact(g: CanvasRenderingContext2D, now: number, master: number): void {
    const rng = this.rng;
    if (!this.art) {
      if (now < this.nextArt) return;
      this.nextArt = now + this.artInterval();
      // Only while the dust is up and the page still looks properly old, and not for reduced motion.
      if (this.reduced || this.settle < 1 || this.shown < 0.35 || this.intro < 1 || this.stage < 2) return;
      const roll = rng();
      this.art = this.stage >= 4 && roll < 0.28 ? 3 : this.stage >= 3 && roll < 0.62 ? 2 : 1;
      this.artBorn = now;
      this.artX = this.bx + this.bw * (0.1 + rng() * 0.8);
      this.artY = this.by + this.bh * (0.1 + rng() * 0.8);
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
        this.artY = this.by;
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
      g.drawImage(this.scratchSprite, x - 1, this.by, this.dark ? 1.5 : 1.2, this.bh);
    }
    g.globalAlpha = 1;
  }
}

// --- procedural textures -------------------------------------------------------

/**
 * Soft round motes at increasing defocus: a crisp speck through to a wide bokeh disc.
 * Dark pages: dust shines. Light pages: white light cannot show on white, so the dust is sunlit
 * gold with a faint warm rim: it reads as dust catching the light rather than dirt on the screen.
 */
function makeSprites(dark: boolean): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = [];
  const [r, g, b] = dark ? [255, 240, 212] : [250, 200, 120];
  const [er, eg, eb] = dark ? [255, 226, 180] : [176, 128, 64];
  const rgba = (cr: number, cg: number, cb: number, a: number) => `rgba(${cr},${cg},${cb},${a.toFixed(3)})`;
  for (let level = 0; level < BLUR_LEVELS; level++) {
    const c = document.createElement('canvas');
    c.width = c.height = SPRITE_PX;
    const x = c.getContext('2d')!;
    const h = SPRITE_PX / 2;
    const t = level / (BLUR_LEVELS - 1);
    const core = CORE[level];
    const grad = x.createRadialGradient(h, h, 0, h, h, h);
    if (t < 0.25) {
      // In focus: a bright point with a tight falloff and a thin rim.
      grad.addColorStop(0, rgba(r, g, b, 1));
      grad.addColorStop(core * 0.5, rgba(r, g, b, 0.92));
      grad.addColorStop(core * 0.9, rgba(er, eg, eb, dark ? 0.35 : 0.5));
      grad.addColorStop(Math.min(1, core * 1.5), rgba(er, eg, eb, dark ? 0.08 : 0.04));
      grad.addColorStop(1, rgba(er, eg, eb, 0));
    } else {
      // Out of focus: a flat disc with a slightly brighter rim and a soft edge.
      const edge = Math.min(0.98, core + 0.12 + 0.18 * t);
      const k = dark ? 1 : 0.55;
      grad.addColorStop(0, rgba(r, g, b, 0.55 * k));
      grad.addColorStop(core * 0.75, rgba(r, g, b, 0.6 * k));
      grad.addColorStop(core, rgba(r, g, b, 0.72 * k));
      grad.addColorStop(Math.min(0.97, (core + edge) / 2), rgba(er, eg, eb, dark ? 0.22 : 0.12));
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
  const gain = dark ? 0.06 : 0.085;
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
