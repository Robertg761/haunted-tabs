// Drips: the entombed tab bleeds.
//
// A dark, glossy liquid gathers along the top of the window as a wavy meniscus,
// swells into beads and runs down in fits and starts, leaving trails that thin,
// dry and go matte, and collects in a thin film along the bottom that ripples
// when a drop lands. Drips only run where there is no text: the page is probed
// once (in idle time) and every column that holds text is ruled out. Scrolling
// drags the drips along and sloshes the pool; a fast or long scroll wipes it all
// away in streaks and the effect removes itself. Gentle scrolling only thins it
// for a moment.
//
// How it is drawn: every frame the liquid is rasterised as a metaball field into
// a Float32 grid at half the CSS resolution: soft blobs for heads and drops, soft
// ribbons for trails, ramped bands for the meniscus and the pool. Where shapes
// meet, their fields add and join organically. The field is compressed
// (h = 1 − e^(−1.6 f)) so overlaps never clip, and a second channel carries how
// fresh (glossy) the liquid is. Only 8×8-cell tiles that hold liquid (now or last
// frame) are processed. A WebGL shader then thresholds and lights the field at
// screen resolution; without hardware WebGL a CPU twin does the same at CSS
// resolution inside the dirty tiles. Nothing outside our own overlay is touched.

import type { Effect, EffectContext } from './types';
import { areasTaken, claimAreas, createOverlay, seeded, type Area, type Overlay } from './overlay';

/** Field cells per CSS pixel. */
const FS = 0.5;
/** Field compression, so overlapping shapes saturate smoothly instead of clipping. */
const KC = 1.6;
const comp = (f: number) => 1 - Math.exp(-KC * f);
/** Coverage ramp on the compressed height: below HLO it is dry glass, above HHI liquid. */
const HLO = comp(0.2);
const HHI = comp(0.34);
/** Thickness ramp (thin crimson film to near-black body) and drop-shadow ramp. */
const TLO = comp(0.4);
const THI = comp(1.1);
const SLO = comp(0.45);
const SHI = comp(1.0);
/** Band ramp length in field cells (meniscus and pool edge softness). */
const RAMP = 4.5;
const TILE = 8;
/**
 * CPU path: a tile is shaded again only once its heights or gloss have moved this far
 * from what it was last shaded with (far below a pixel of edge movement).
 */
const EPS_H = 0.003;
const EPS_G = 0.012;
const MAX_DRIPS = 12;
const TRAIL_CAP = 420;
const MAX_DROPS = 16;
const MAX_SPLASH = 40;
const BAND_STEP = 2;
const POOL_STEP = 6;
/** Seconds for a fresh trail to thin to its residue. */
const TRAIL_TAU = 6.5;
const FADE_OUT_S = 1.15;
const WIPE_S = 1.0;
/** Scroll that wipes everything: this fast (px/s over 150 ms), or this much in one gesture (× viewport height). */
const WIPE_SPEED = 2800;
const WIPE_GESTURE = 0.9;
/** Probe grid for text: column width and vertical step, in CSS px. */
const PROBE_BIN = 12;
const PROBE_STEP = 24;
/** A column clear all the way down. */
const NO_STOP = 1e6;
/** A head stops this far above the first text (or another creature) below it. */
const STOP_GAP = 30;
/** The least room a drip needs: a bead hanging under the meniscus. */
const MIN_RUN = 36;
/** Frame rate while only slow things change (trails drying, the film seeping in, the band settling). */
const CALM_FPS = 15;
/** Seconds for a drip stranded over text by a resize to evaporate. */
const EVAPORATE_S = 0.9;
/** Debug: use WebGL even when it is software-rendered. Keep false in builds. */
const FORCE_GL = false;

const WAITING = 0;
const GATHERING = 1;
const RUNNING = 2;
const POOLING = 3;
const RESTING = 4;

/** What the next frame needs: nothing, a calm frame soon, or a full-rate frame. */
const IDLE = 0;
const CALM = 1;
const LIVELY = 2;

/** Whether this machine gives us hardware WebGL; probed once per page. */
let glVerdict: boolean | null = null;

interface Drip {
  phase: number;
  /** Sim time (s) the bead starts gathering. */
  at: number;
  gather: number;
  /** Size factor: 1, or smaller for drips squeezed into the window margins. */
  k: number;
  x0: number;
  x: number;
  y: number;
  v: number;
  /** Head volume, as an area in px². */
  m: number;
  mRelease: number;
  rRelease: number;
  feed: number;
  feedRate: number;
  wobA: number;
  wobF: number;
  wobP: number;
  pins: Float32Array;
  pinK: Float32Array;
  pinIdx: number;
  /** x, y, radius, birth time — per trail point. */
  trail: Float32Array;
  n: number;
  lastX: number;
  lastY: number;
  lastDeposit: number;
  detach: number;
  waver: number;
  bump: number;
  bumpW: number;
  stretch: number;
  /** Seconds the head has been held by surface tension. */
  stuck: number;
  /** 1 while present; falls to 0 as a drip left over text by a resize evaporates. */
  gone: number;
  doomed: boolean;
  /** How far down the head may go (its bottom, CSS px) before text or another creature; NO_STOP for all the way. */
  stopY: number;
  /** A thin drip down the very edge of the window, where text does not count. */
  edge: boolean;
}

interface Bit {
  alive: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  m: number;
  age: number;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const hash = (i: number) => {
  const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
};

// The look, shared by the shader and its CPU twin (shadeTiles, keep them in step).
// Colours are [light page, dark page]. Old blood, not paint: oxblood thinning to a
// rusty brown where it dries. On dark pages the body is lifted and less saturated,
// and the rim light is stronger, so the shape still reads without turning candy red.
const LOOK = {
  bump: 3.0,
  half: [-0.5, -0.35, 1.0],
  fill: [0.3, 0.6, 1.0],
  thin: [
    [0.34, 0.035, 0.03],
    [0.4, 0.1, 0.08],
  ],
  thick: [
    [0.12, 0.012, 0.01],
    [0.19, 0.055, 0.045],
  ],
  edge: [
    [0.04, 0.006, 0.005],
    [0.11, 0.035, 0.03],
  ],
  dry: [
    [0.21, 0.075, 0.045],
    [0.29, 0.12, 0.08],
  ],
  glow: [
    [0.42, 0.06, 0.035],
    [0.42, 0.12, 0.08],
  ],
  rim: [
    [0.42, 0.12, 0.09],
    [0.46, 0.2, 0.16],
  ],
  rimK: [0.1, 0.42],
  shadowK: [0.16, 0.06],
};
type Col = 'thin' | 'thick' | 'edge' | 'dry' | 'glow' | 'rim';
const f3 = (x: number) => x.toFixed(4);
const v3 = (c: number[]) => `vec3(${c.map(f3).join(', ')})`;
const mixd = (k: Col) => `mix(${v3(LOOK[k][0])}, ${v3(LOOK[k][1])}, uDark)`;
const norm3 = (v: number[]) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const HALF = norm3(LOOK.half);
const FILL = norm3(LOOK.fill);

const VERT = `
attribute vec2 aPos;
uniform vec2 uScale;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5) * uScale;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uF;
uniform vec2 uTexel;
uniform vec2 uShadow;
uniform float uOpacity;
uniform float uDark;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uF, vUv);
  float h = c.r;
  float g = c.a;
  float hs = texture2D(uF, vUv - uShadow).r;
  if (h < 0.02 && hs < ${f3(SLO)}) { gl_FragColor = vec4(0.0); return; }
  float cov = smoothstep(${f3(HLO)}, ${f3(HHI)}, h);
  float hl = texture2D(uF, vUv - vec2(uTexel.x, 0.0)).r;
  float hr = texture2D(uF, vUv + vec2(uTexel.x, 0.0)).r;
  float hu = texture2D(uF, vUv - vec2(0.0, uTexel.y)).r;
  float hd = texture2D(uF, vUv + vec2(0.0, uTexel.y)).r;
  vec3 n = normalize(vec3((hl - hr) * ${f3(LOOK.bump)}, (hu - hd) * ${f3(LOOK.bump)}, 1.0));
  float edge = 1.0 - n.z;
  float thick = smoothstep(${f3(TLO)}, ${f3(THI)}, h);
  float edgeK = smoothstep(0.35, 0.8, edge) * 0.4;
  vec3 body = mix(mix(${mixd('thin')}, ${mixd('thick')}, thick), ${mixd('edge')}, edgeK);
  body = mix(body, ${mixd('dry')}, (1.0 - g) * 0.75);
  float glow = clamp(dot(n.xy, vec2(0.45, 0.8)) * 1.8, 0.0, 1.0) * (1.0 - edgeK) * smoothstep(0.55, 0.85, h) * g;
  body += ${mixd('glow')} * glow;
  float a = cov * mix(0.86, 0.97, thick);
  float nh = max(dot(n, ${v3(HALF)}), 0.0);
  float nf = max(dot(n, ${v3(FILL)}), 0.0);
  float spec = (pow(nh, 32.0) * 0.95 + pow(nh, 8.0) * 0.05 + pow(nf, 18.0) * 0.12) * cov * (0.15 + 0.85 * g);
  float rim = edge * edge * cov * mix(${f3(LOOK.rimK[0])}, ${f3(LOOK.rimK[1])}, uDark);
  vec3 col = body * a + vec3(1.0, 0.94, 0.92) * spec + ${mixd('rim')} * rim;
  float sh = smoothstep(${f3(SLO)}, ${f3(SHI)}, hs) * (1.0 - a) * mix(${f3(LOOK.shadowK[0])}, ${f3(LOOK.shadowK[1])}, uDark);
  a = clamp(max(a + sh, max(col.r, max(col.g, col.b))), 0.0, 1.0);
  gl_FragColor = vec4(col, a) * uOpacity;
}`;

/** f → compressed height, as a table (f up to 4; beyond that it is 1 anyway). */
const COMP_N = 2048;
const COMP_MAX = 4;
let compTab: Float32Array | null = null;
const SPEC_N = 1024;
let specTab: Float32Array | null = null;
let fillTab: Float32Array | null = null;
// Ramps of the look, indexed by height (or by n.z for the edge), for the CPU path.
let covTab: Float32Array | null = null;
let thickTab: Float32Array | null = null;
let glowTab: Float32Array | null = null;
let edgeTab: Float32Array | null = null;
let shadowTab: Float32Array | null = null;
let shadowTabK = -1;
function tables(): void {
  if (compTab) return;
  compTab = new Float32Array(COMP_N + 1);
  for (let i = 0; i <= COMP_N; i++) compTab[i] = comp((i / COMP_N) * COMP_MAX);
  specTab = new Float32Array(SPEC_N + 1);
  fillTab = new Float32Array(SPEC_N + 1);
  for (let i = 0; i <= SPEC_N; i++) {
    const x = i / SPEC_N;
    specTab[i] = Math.pow(x, 32) * 0.95 + Math.pow(x, 8) * 0.05;
    fillTab[i] = Math.pow(x, 18) * 0.12;
  }
  covTab = new Float32Array(SPEC_N + 1);
  thickTab = new Float32Array(SPEC_N + 1);
  glowTab = new Float32Array(SPEC_N + 1);
  edgeTab = new Float32Array(SPEC_N + 1);
  shadowTab = new Float32Array(SPEC_N + 1);
  for (let i = 0; i <= SPEC_N; i++) {
    const x = i / SPEC_N;
    covTab[i] = smooth(HLO, HHI, x);
    thickTab[i] = smooth(TLO, THI, x);
    glowTab[i] = smooth(0.55, 0.85, x);
    edgeTab[i] = smooth(0.35, 0.8, 1 - x) * 0.4;
  }
}

export class Drips implements Effect {
  readonly name = 'drips' as const;

  private overlay: Overlay | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGLRenderingContext | null = null;
  private glTex: WebGLTexture | null = null;
  private glU: Record<string, WebGLUniformLocation | null> = {};
  private texW = 0;
  private texH = 0;
  private cpu: CanvasRenderingContext2D | null = null;
  private cpuImg: ImageData | null = null;

  private W = 0;
  private H = 0;
  private fw = 0;
  private fh = 0;
  /** Metaball field; compressed to heights in place before shading. */
  private field = new Float32Array(0);
  /** Freshness-weighted field; turned into a 0–1 gloss in place before shading. */
  private gloss = new Float32Array(0);
  /** GL upload: height and gloss bytes (empty on the CPU path). */
  private bytes = new Uint8Array(0);
  private colTop = new Float32Array(0);
  private colBot = new Float32Array(0);
  private tx = 0;
  private ty = 0;
  private dirty = new Uint8Array(0);
  private prevDirty = new Uint8Array(0);
  private shade = new Uint8Array(0);
  private rects = new Int32Array(0);
  /** Tiles with liquid now, grown by one: the only ones the CPU path shades. */
  private live = new Uint8Array(0);
  private span = new Int32Array((TILE + 5) * 2);
  private out32: Uint32Array | null = null;
  /** CPU path: lit colour per field cell, packed RGBA. */
  private lit = new Uint32Array(0);
  private pal = new Float32Array(20);
  /** CPU path: tiles that hold non-transparent pixels, and tiles to upload this frame. */
  private painted = new Uint8Array(0);
  private upload = new Uint8Array(0);
  /** CPU path: heights and gloss each tile was last shaded with, and the tiles to shade (and light) this frame. */
  private refH = new Float32Array(0);
  private refG = new Float32Array(0);
  private need = new Uint8Array(0);
  private needLit = new Uint8Array(0);
  private shadeAll = true;
  private lastOp = -1;
  private lastDark = -1;
  private paletteDark = -1;

  private drips: Drip[] = [];
  private drops: Bit[] = [];
  private splash: Bit[] = [];
  private band = new Float32Array(0);
  private poolBase = new Float32Array(0);
  private poolU = new Float32Array(0);
  private poolV = new Float32Array(0);

  private rng: () => number = Math.random;
  private seed = 0;
  private reduced = false;
  private dark = 0;
  private t = 0;
  private last = 0;
  private raf = 0;
  /** A calm frame is waiting on this timer (see CALM_FPS). */
  private calmTimer: number | undefined;
  private timer: number | undefined;
  private resizeTimer: number | undefined;
  private themeTimer: number | undefined;
  private themeObserver: MutationObserver | null = null;
  private scheme: MediaQueryList | null = null;
  /** Page darkness to ease towards, when the page changes theme while it bleeds. */
  private darkTarget = 0;
  private stopping = false;
  private opacity = 0;
  /** 1 = full; dips while you scroll gently, and recovers. */
  private wet = 1;
  private wetTarget = 1;
  private wiping = false;
  private wipeT = 0;
  private wipeDir = 1;
  private sag = 0;
  private bandT = 0;
  private act = 1;
  private endT = 0;
  private lastPoolAdd = -99;
  private stirUntil = 0;
  private pendingScroll = 0;
  private velT = new Float64Array(32);
  private velD = new Float32Array(32);
  private velI = 0;
  private gesture = 0;
  private gestureAt = -1e9;
  private pointerX = -1e4;
  private pointerY = -1e4;
  private winScrollY = 0;
  private elScroll = new WeakMap<EventTarget, number>();
  private wavePhase = 0;
  private bandPhase = new Float32Array(6);
  private sizeK = 1;
  private S = 1;

  // Text probe (runs in idle time) and the drips waiting for it.
  /** Per probe column: how far down it is clear before text or a control (NO_STOP if all the way). */
  private reach: Float32Array | null = null;
  private scanRaw: Float32Array | null = null;
  /** Sim time of the next look at what other creatures have claimed. */
  private nextAreaCheck = 0;
  /** The page scrolled gently since the columns were last probed. */
  private moved = false;
  private scanB = 0;
  private idle = 0;
  private idleIsTimeout = false;
  private wantDrips = 0;
  /** The layout changed under the drips: check them against the new text columns. */
  private recheck = false;
  private glPending = false;

  get active(): boolean {
    return !!this.overlay;
  }

  // --- lifecycle -------------------------------------------------------------

  start(ctx: EffectContext): void {
    if (this.overlay) {
      // Already bleeding: cancel any fade and let a few more drips through.
      if (this.stopping) {
        this.stopping = false;
        clearTimeout(this.timer);
        this.timer = undefined;
      }
      if (this.wiping) {
        this.wiping = false;
        this.wipeT = 0;
      }
      this.wetTarget = 1;
      const more = Math.min(3, MAX_DRIPS - this.drips.length);
      if (this.reach) {
        this.addDrips(more, this.t + 0.8, 7);
        this.claim();
      }
      else this.wantDrips = Math.min(MAX_DRIPS, this.wantDrips + more);
      this.wake();
      return;
    }
    tables();
    this.reduced = ctx.reduced;
    this.seed = ctx.seed >>> 0;
    this.rng = seeded(this.seed ^ 0x9e3779b9);
    const shape = seeded(this.seed ^ 0x5eed);
    for (let i = 0; i < this.bandPhase.length; i++) this.bandPhase[i] = shape() * Math.PI * 2;
    this.dark = this.darkTarget = pageDarkness();
    this.overlay = createOverlay(this.name, 'canvas { position: absolute; inset: 0; width: 100%; height: 100%; }');
    // Creating a WebGL context can take tens of ms when it fails: the first time,
    // start on the CPU renderer and try WebGL in idle time (see scanSlice).
    this.glPending = glVerdict === null;
    if (!(glVerdict === true && this.initGl())) this.initCpu();
    // A fresh run: nothing carries over from an earlier one on this instance.
    this.W = this.H = 0;
    this.poolBase = new Float32Array(0);
    this.drips = [];
    this.reach = null;
    this.recheck = this.moved = false;
    this.nextAreaCheck = 0;
    this.measure();
    this.t = 0;
    this.opacity = 0;
    this.wet = this.wetTarget = 1;
    this.wiping = this.stopping = false;
    this.wipeT = this.sag = this.pendingScroll = this.gesture = 0;
    this.velD.fill(0);
    this.act = 1;
    this.bandT = 0;
    this.lastPoolAdd = -99;
    this.stirUntil = 0;
    this.drops = [];
    this.splash = [];
    for (let i = 0; i < MAX_DROPS; i++) this.drops.push({ alive: false, x: 0, y: 0, vx: 0, vy: 0, m: 0, age: 0 });
    for (let i = 0; i < MAX_SPLASH; i++) this.splash.push({ alive: false, x: 0, y: 0, vx: 0, vy: 0, m: 0, age: 0 });

    const idleH = ctx.idleMs / 3_600_000;
    let count = 5 + Math.floor(this.rng() * 3) + Math.round(Math.min(1, idleH / 8) * 4) - (this.W < 1000 ? 1 : 0) - (4 - Math.min(4, ctx.stage));
    count = Math.max(5, Math.min(MAX_DRIPS, count));
    // The meniscus starts gathering now; where the drips may run is worked out in
    // idle time (the first one is not due for over a second anyway).
    this.wantDrips = count;
    this.endT = 20;
    this.scanRaw = null;
    this.scanB = 0;
    this.scheduleScan();

    this.winScrollY = scrollY;
    document.addEventListener('scroll', this.onScroll, { passive: true, capture: true });
    addEventListener('pointermove', this.onPointer, { passive: true });
    addEventListener('resize', this.onResize, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibility);
    this.watchTheme();
    this.wake();
  }

  stop(): void {
    if (!this.overlay || this.stopping) return;
    if (document.visibilityState !== 'visible') {
      this.destroy();
      return;
    }
    this.stopping = true;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.destroy(), 1500);
    this.wake();
  }

  destroy(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    clearTimeout(this.resizeTimer);
    clearTimeout(this.calmTimer);
    clearTimeout(this.themeTimer);
    this.resizeTimer = this.calmTimer = this.themeTimer = undefined;
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    this.scheme?.removeEventListener('change', this.onTheme);
    this.scheme = null;
    this.cancelScan();
    claimAreas('drips', []);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    document.removeEventListener('scroll', this.onScroll, { capture: true });
    removeEventListener('pointermove', this.onPointer);
    removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas?.removeEventListener('webglcontextlost', this.onContextLost);
    if (this.gl) {
      this.gl.getExtension('WEBGL_lose_context')?.loseContext();
      this.gl = null;
    }
    this.overlay?.remove();
    this.overlay = null;
    this.canvas = null;
    this.cpu = null;
    this.cpuImg = null;
    this.glTex = null;
    this.drips = [];
    this.drops = [];
    this.splash = [];
    this.stopping = false;
  }

  // --- setup -----------------------------------------------------------------

  private initGl(): boolean {
    if (glVerdict === false && !FORCE_GL) return false;
    // Every page has a cap on live WebGL contexts and a new one evicts the page's
    // oldest: on canvas-heavy pages, stay on the CPU path.
    if (!FORCE_GL && document.getElementsByTagName('canvas').length >= 4) return false;
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
      // Software GL is slower than our CPU path: let it fall back instead.
      failIfMajorPerformanceCaveat: !FORCE_GL,
    }) as WebGLRenderingContext | null;
    if (!gl) {
      glVerdict = false;
      return false;
    }
    const fail = () => {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      glVerdict = false;
      return false;
    };
    // Software GL would shade millions of pixels on the CPU: the CPU path is cheaper.
    let renderer = String(gl.getParameter(gl.RENDERER) ?? '');
    if (/^webkit webgl$/i.test(renderer)) {
      // Chrome masks RENDERER; Firefox does not (and warns about the extension).
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      if (info) renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? '');
    }
    if (!FORCE_GL && /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer)) return fail();
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return fail();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return fail();
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (const u of ['uF', 'uTexel', 'uShadow', 'uOpacity', 'uDark', 'uScale']) this.glU[u] = gl.getUniformLocation(prog, u);
    gl.uniform1i(this.glU.uF, 0);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.overlay!.layer.appendChild(canvas);
    this.canvas = canvas;
    this.gl = gl;
    this.glTex = tex;
    this.texW = this.texH = 0;
    glVerdict = true;
    return true;
  }

  /** Swap the CPU renderer for WebGL if this machine has hardware WebGL. */
  private upgradeGl(): void {
    const old = this.canvas;
    if (!this.overlay || this.gl || !this.initGl()) return;
    old?.remove();
    this.cpu = null;
    this.cpuImg = null;
    this.out32 = null;
    this.measure();
    this.wake();
  }

  private initCpu(): void {
    const canvas = document.createElement('canvas');
    this.overlay!.layer.appendChild(canvas);
    this.canvas = canvas;
    this.cpu = canvas.getContext('2d');
    this.cpuImg = null;
  }

  /** Viewport size changed (or first run): resize the field, tiles, pool and band. */
  private measure(): void {
    const de = document.documentElement;
    const W = Math.max(1, de.clientWidth || innerWidth);
    const H = Math.max(1, de.clientHeight || innerHeight);
    const oldW = this.W;
    const oldH = this.H;
    this.W = W;
    this.H = H;
    this.sizeK = Math.min(1.2, Math.max(0.85, Math.min(W, H) / 800));
    this.S = Math.min(1.4, Math.max(0.8, H / 800));
    this.fw = Math.ceil(W * FS);
    this.fh = Math.ceil(H * FS);
    const cells = this.fw * this.fh;
    this.field = new Float32Array(cells);
    this.gloss = new Float32Array(cells);
    this.bytes = this.gl ? new Uint8Array(cells * 2) : new Uint8Array(0);
    this.lit = this.gl ? new Uint32Array(0) : new Uint32Array(cells);
    this.colTop = new Float32Array(this.fw);
    this.colBot = new Float32Array(this.fw);
    this.tx = Math.ceil(this.fw / TILE);
    this.ty = Math.ceil(this.fh / TILE);
    this.dirty = new Uint8Array(this.tx * this.ty);
    this.prevDirty = new Uint8Array(this.tx * this.ty);
    this.shade = new Uint8Array(this.tx * this.ty);
    this.live = new Uint8Array(this.tx * this.ty);
    this.painted = new Uint8Array(this.tx * this.ty);
    this.upload = new Uint8Array(this.tx * this.ty);
    this.need = new Uint8Array(this.tx * this.ty);
    this.needLit = new Uint8Array(this.tx * this.ty);
    this.refH = this.gl ? new Float32Array(0) : new Float32Array(cells);
    this.refG = this.gl ? new Float32Array(0) : new Float32Array(cells);
    this.shadeAll = true;
    this.rects = new Int32Array(this.tx * this.ty * 4);
    this.band = new Float32Array(Math.ceil(W / BAND_STEP) + 3);

    const pn = Math.ceil(W / POOL_STEP) + 3;
    const oldBase = this.poolBase;
    this.poolBase = new Float32Array(pn);
    this.poolU = new Float32Array(pn);
    this.poolV = new Float32Array(pn);
    if (oldBase.length) {
      for (let i = 0; i < pn; i++) this.poolBase[i] = oldBase[Math.min(oldBase.length - 1, Math.round((i * (oldBase.length - 1)) / (pn - 1)))];
    }
    if (oldW && (oldW !== W || oldH !== H)) {
      const kx = W / oldW;
      for (const d of this.drips) {
        d.x0 *= kx;
        d.x *= kx;
        d.y = Math.min(d.y, H);
        for (let i = 0; i < d.n; i++) {
          d.trail[i * 4] *= kx;
          d.trail[i * 4 + 1] = Math.min(d.trail[i * 4 + 1], H);
        }
      }
      // Columns were measured for the old layout: probe again, and let any drip now over text go.
      if (this.reach && Math.abs(oldW - W) > PROBE_BIN) {
        this.reach = null;
        this.recheck = true;
        if (!this.idle) {
          this.scanRaw = null;
          this.scheduleScan();
        }
      }
    }

    const canvas = this.canvas!;
    if (this.gl) {
      // The field is half resolution; more than 1.5 device px per CSS px buys nothing.
      const dpr = Math.min(1.5, devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      this.texW = this.texH = 0;
    } else {
      canvas.width = W;
      canvas.height = H;
      this.cpuImg = this.cpu ? this.cpu.createImageData(W, H) : null;
      this.out32 = this.cpuImg ? new Uint32Array(this.cpuImg.data.buffer) : null;
    }
  }

  // --- where drips may run ---------------------------------------------------

  private scheduleScan(): void {
    const w = window as Window & { requestIdleCallback?: (cb: (d: IdleDeadline) => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) {
      this.idleIsTimeout = false;
      this.idle = w.requestIdleCallback(this.scanSlice, { timeout: 400 });
    } else {
      this.idleIsTimeout = true;
      this.idle = window.setTimeout(() => this.scanSlice(null), 30);
    }
  }

  private cancelScan(): void {
    if (!this.idle) return;
    const w = window as Window & { cancelIdleCallback?: (id: number) => void };
    if (this.idleIsTimeout) clearTimeout(this.idle);
    else w.cancelIdleCallback?.(this.idle);
    this.idle = 0;
  }

  /** Probe a few columns per idle slice; when all are done, plan the drips. */
  private scanSlice = (dl: IdleDeadline | null) => {
    this.idle = 0;
    if (!this.overlay) return;
    if (this.glPending) {
      // One idle slice for the WebGL upgrade, the next ones for the text probe.
      this.glPending = false;
      this.upgradeGl();
      this.scheduleScan();
      return;
    }
    const bins = Math.max(1, Math.ceil(this.W / PROBE_BIN));
    if (!this.scanRaw || this.scanRaw.length !== bins) {
      this.scanRaw = new Float32Array(bins);
      this.scanB = 0;
    }
    const budget = dl && !dl.didTimeout ? Math.min(8, Math.max(3, dl.timeRemaining())) : 5;
    const until = performance.now() + budget;
    const probe = this.textProbe();
    while (this.scanB < bins && performance.now() < until) this.scanRaw[this.scanB] = probe(this.scanB++);
    probe(-1);
    if (this.scanB < bins) {
      this.scheduleScan();
      return;
    }
    this.reach = this.spread(this.scanRaw);
    let span = 17.5;
    if (this.recheck) {
      // The layout moved under the drips (a resize, or the page scrolled): drips now running
      // over text or into something else's space evaporate, and as many form in clear columns.
      this.recheck = false;
      span = 6;
      for (const d of this.drips) {
        if (d.doomed) continue;
        const stop = this.stopAt(d.x0, d.edge, d.wobA);
        if (d.phase !== WAITING && stop < this.extent(d) - 4) {
          d.doomed = true;
          if (!this.stopping && !this.wiping) this.wantDrips++;
        } else d.stopY = stop;
      }
    }
    const want = Math.min(MAX_DRIPS - this.drips.filter((d) => !d.doomed).length, this.wantDrips);
    this.wantDrips = 0;
    this.addDrips(want, Math.max(1.3, this.t + 0.3), span);
    this.claim();
    this.wake();
  };

  /** Probe the columns again (keeping the old answer until the new one is in). */
  private requestRecheck(): void {
    this.recheck = true;
    if (!this.idle) {
      this.scanRaw = null;
      this.scheduleScan();
    }
  }

  /**
   * A column prober: probe(bin) is how far down (CSS px) that column is clear before the
   * first text or control, or NO_STOP when it is clear all the way. probe(-1) releases it.
   */
  private textProbe(): (b: number) => number {
    const W = this.W;
    const H = this.H;
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const range = document.createRange();
    const textAt = (x: number, y: number): boolean => {
      let node: Node | null | undefined;
      let off = 0;
      if (doc.caretPositionFromPoint) {
        const p = doc.caretPositionFromPoint(x, y);
        node = p?.offsetNode;
        off = p?.offset ?? 0;
      } else if (doc.caretRangeFromPoint) {
        const r = doc.caretRangeFromPoint(x, y);
        node = r?.startContainer;
        off = r?.startOffset ?? 0;
      }
      if (!node || node.nodeType !== Node.TEXT_NODE) return false;
      const text = node.textContent ?? '';
      for (let o = off - 1; o <= off; o++) {
        if (o < 0 || o >= text.length || /\s/.test(text[o])) continue;
        range.setStart(node, o);
        range.setEnd(node, o + 1);
        const r = range.getBoundingClientRect();
        if (x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 14 && y <= r.bottom + 14) return true;
      }
      return false;
    };
    const controls = /^(INPUT|TEXTAREA|SELECT|BUTTON|VIDEO|IFRAME)$/;
    // Links and buttons dressed up as anything (a pill, a card), unless they are huge wrappers.
    const clickable = 'a[href], button, [role="button"], label, summary';
    const small = W * H * 0.15;
    const isControl = (el: Element | null): boolean => {
      if (!el) return false;
      if (controls.test(el.tagName)) return true;
      const c = el.closest(clickable);
      if (!c) return false;
      const r = c.getBoundingClientRect();
      return r.width * r.height < small;
    };
    return (b: number) => {
      if (b < 0) {
        range.detach();
        return NO_STOP;
      }
      const x = Math.min(W - 1, b * PROBE_BIN + PROBE_BIN / 2);
      try {
        for (let y = 8; y < H; y += PROBE_STEP) {
          if (textAt(x, y)) return y;
          if (isControl(document.elementFromPoint(x, y))) return y;
        }
      } catch {
        return 0;
      }
      return NO_STOP;
    };
  }

  /** A column is only as clear as its neighbours (a head is ~20 px wide). */
  private spread(raw: Float32Array): Float32Array {
    const out = new Float32Array(raw.length);
    for (let b = 0; b < raw.length; b++) {
      let v = raw[b];
      for (let k = -2; k <= 2; k++) if (b + k >= 0 && b + k < raw.length && raw[b + k] < v) v = raw[b + k];
      out[b] = v;
    }
    return out;
  }

  /**
   * How far down a drip at x may run, measured to the bottom of its head: to just above the
   * first text or control in its column (unless it is a thin drip down the window edge), and
   * never into the space another creature has claimed (the eyes' darkness, a web).
   */
  private stopAt(x: number, edge: boolean, wob = 3): number {
    let stop = NO_STOP;
    if (!edge && this.reach) stop = this.reach[Math.min(this.reach.length - 1, Math.max(0, Math.floor(x / PROBE_BIN)))] - STOP_GAP;
    const half = wob + 14;
    for (const a of areasTaken('drips')) {
      if (x + half < a.x || x - half > a.x + a.w || a.y + a.h < 0 || a.y > this.H) continue;
      stop = Math.min(stop, a.y - STOP_GAP);
    }
    return stop;
  }

  /** The lowest point of a drip so far (its trail or its head), in CSS px. */
  private extent(d: Drip): number {
    let y = d.n ? d.trail[(d.n - 1) * 4 + 1] + d.trail[(d.n - 1) * 4 + 2] : 0;
    if (d.m > 1 && d.phase !== WAITING) y = Math.max(y, d.y + Math.sqrt(d.m / Math.PI) * 1.1);
    return y;
  }

  /** Tell the other creatures which columns the drips run down, so they keep out of them. */
  private claim(): void {
    const areas: Area[] = [];
    for (const d of this.drips) {
      if (d.doomed) continue;
      const half = d.wobA + 14;
      areas.push({ x: d.x0 - half, y: 0, w: half * 2, h: Math.min(this.H, d.stopY + STOP_GAP) });
    }
    claimAreas('drips', areas);
  }

  /**
   * Something else settled in a drip's way since it was planned (eyes open, a web is spun):
   * a drip it lands on evaporates, and one that has not reached it yet stops short of it.
   */
  private checkAreas(): void {
    const taken = areasTaken('drips');
    if (!taken.length) return;
    let changed = false;
    for (const d of this.drips) {
      if (d.doomed || d.phase === WAITING) continue;
      const half = d.wobA + 14;
      const bottom = this.extent(d);
      for (const a of taken) {
        if (d.x0 + half < a.x || d.x0 - half > a.x + a.w || a.y + a.h < 0 || a.y - STOP_GAP >= d.stopY) continue;
        changed = true;
        if (a.y - STOP_GAP < bottom) {
          d.doomed = true;
          break;
        }
        d.stopY = a.y - STOP_GAP;
      }
    }
    if (changed) this.claim();
  }

  /**
   * Where the drips run: down columns that are clear for a good way (all the way to the
   * pool is best), preferring the window edges. A column with text further down still
   * takes a drip: it runs until just above the text and hangs there. When the page has
   * (almost) no room at all, a few thin drips hug the outer margins instead. Later drips
   * may follow an earlier one down a long channel. Returns their x positions.
   */
  pickColumns(count: number): number[] {
    if (!this.reach) {
      const bins = Math.max(1, Math.ceil(this.W / PROBE_BIN));
      const raw = new Float32Array(bins);
      const probe = this.textProbe();
      for (let b = 0; b < bins; b++) raw[b] = probe(b);
      probe(-1);
      this.reach = this.spread(raw);
    }
    const W = this.W;
    const H = this.H;
    const rng = this.rng;
    const bins = this.reach.length;
    // How far a drip could run down each column, other creatures included.
    const run = new Float32Array(bins);
    for (let b = 0; b < bins; b++) run[b] = this.stopAt(b * PROBE_BIN + PROBE_BIN / 2, false);
    // Stretches of columns with room for at least a hanging bead, kept off the very edge of the window.
    const slots: number[] = [];
    // Room for a drip every ~24 px (heads are ~20 px wide, and neighbours start at different times).
    const minGap = Math.max(24, Math.min(36, W / 48));
    const taken = this.drips.filter((d) => !d.doomed).map((d) => d.x0);
    let b = 0;
    while (b < bins) {
      if (run[b] < MIN_RUN) {
        b++;
        continue;
      }
      const s = b;
      // A stretch ends where the room changes a lot, so each slot's run is about what it gets.
      while (b < bins && run[b] >= MIN_RUN && Math.abs(Math.min(run[b], H) - Math.min(run[s], H)) < 60) b++;
      const x0 = Math.max(14, s * PROBE_BIN + 4);
      const x1 = Math.min(W - 14, b * PROBE_BIN - 4);
      if (x1 < x0) continue;
      const n = Math.max(1, Math.floor((x1 - x0) / minGap) + 1);
      const step = n > 1 ? (x1 - x0) / (n - 1) : 0;
      for (let i = 0; i < n; i++) slots.push(n > 1 ? x0 + step * i : (x0 + x1) / 2);
    }
    const runAt = (x: number) => Math.min(H, run[Math.min(bins - 1, Math.max(0, Math.floor(x / PROBE_BIN)))]);
    const xs: number[] = [];
    if (slots.length < 2) {
      // Wall-to-wall text: a few thin drips down the outer margins only, if nothing else is there.
      const n = Math.min(count, 3 + (rng() < 0.5 ? 1 : 0));
      for (let i = 0; i < n; i++) {
        const x = i % 2 === 0 ? 3 + rng() * 3 : W - 3 - rng() * 3;
        if (this.stopAt(x, true, 0.4) >= MIN_RUN) xs.push(x);
      }
    } else {
      // Prefer long runs, slots near the window edges, and ones not used yet.
      const weight = (x: number) =>
        (0.4 + Math.pow(Math.max(0, 1 - Math.min(x, W - x) / (W * 0.25)), 1.2)) * (0.25 + 0.75 * Math.min(1, runAt(x) / (H * 0.6)));
      const pool = slots.filter((x) => taken.every((t) => Math.abs(t - x) >= minGap * 0.6));
      const order: number[] = [];
      while (pool.length) {
        let total = 0;
        for (const x of pool) total += weight(x);
        let pick = rng() * total;
        let i = 0;
        while (i < pool.length - 1 && pick > weight(pool[i])) pick -= weight(pool[i++]);
        order.push(pool.splice(i, 1)[0]);
      }
      // Fill fresh slots first; then send later drips down long channels already used (a
      // second head stopping where the first one hangs would only swell it into a blob).
      // Few channels: fewer drips, so a gutter bleeds rather than floods.
      const n = Math.min(count, Math.max(3, Math.ceil(slots.length * 1.7)));
      const long = (order.length ? order : slots).filter((x) => runAt(x) >= H * 0.6);
      for (let i = 0; i < n; i++) {
        if (i < order.length) xs.push(order[i]);
        else if (long.length) xs.push(long[i % long.length]);
      }
    }
    return xs;
  }

  /** Plan `count` drips that start gathering between `from` and `from + span` seconds. */
  private addDrips(count: number, from: number, span: number): void {
    if (count <= 0) return;
    const rng = this.rng;
    const xs = this.pickColumns(count);
    const W = this.W;
    // Drips sharing a channel go one after the other, a few seconds apart.
    const lastAt = new Map<number, number>();
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      const thin = x < 12 || x > W - 12;
      const stopY = this.stopAt(x, thin, thin ? 0.4 : 3);
      // A drip with only a short way to go is a smaller bead.
      const k = this.sizeK * (thin ? 0.55 : 1) * (0.7 + 0.3 * Math.min(1, stopY / 220));
      const r0 = (8 + rng() * 4) * k;
      const pins: number[] = [];
      const pinK: number[] = [];
      for (let y = 30 + rng() * 60; y < this.H; y += 40 + rng() * 150) {
        pins.push(y);
        pinK.push(1.2 + rng() * 1.1);
      }
      const feed = (500 + rng() * 1500) * this.S * k * k;
      let at = i === 0 ? from : from + span * Math.pow(xs.length === 1 ? 0 : i / (xs.length - 1), 0.92) + (rng() - 0.5) * 1.4;
      const key = Math.round(x / 8);
      const prev = lastAt.get(key);
      if (prev !== undefined && at < prev + 5) at = prev + 5 + rng() * 2;
      lastAt.set(key, at);
      let lead: Drip | undefined;
      for (const d of this.drips) if (!d.doomed && Math.abs(d.x0 - x) < 2) lead = lead ?? d;
      if (lead) at = Math.max(at, lead.at + 5 + rng() * 2);
      this.drips.push({
        phase: WAITING,
        at: Math.max(from * 0.6, at),
        gather: i === 0 ? 1.6 + rng() * 0.6 : 1.4 + rng() * 1.9,
        k,
        x0: x,
        x,
        y: 0,
        v: 0,
        m: 0,
        mRelease: Math.PI * r0 * r0,
        rRelease: r0,
        feed,
        feedRate: feed / (2.2 + rng() * 4),
        // Margin drips run straight down the edge.
        // A later drip down the same channel follows the first one's path exactly.
        wobA: lead ? lead.wobA : thin ? 0.4 : 0.8 + rng() * 3.2,
        wobF: lead ? lead.wobF : 0.006 + rng() * 0.02,
        wobP: lead ? lead.wobP : rng() * Math.PI * 2,
        pins: new Float32Array(pins),
        pinK: new Float32Array(pinK),
        pinIdx: 0,
        trail: new Float32Array(TRAIL_CAP * 4),
        n: 0,
        lastX: x,
        lastY: 0,
        lastDeposit: -99,
        detach: rng() < 0.65 ? 0.3 + rng() * 0.6 : 0,
        waver: 0,
        bump: 0,
        bumpW: 9 + r0 * 1.5,
        stretch: 0,
        stuck: 0,
        gone: 1,
        doomed: false,
        stopY,
        edge: thin,
      });
    }
    let end = 0;
    for (const d of this.drips) end = Math.max(end, d.at + d.gather);
    this.endT = end + 14;
  }

  // --- events ----------------------------------------------------------------

  /** Real scrolling only (wheel turns that scroll nothing do not count), on the window or any scroller. */
  private onScroll = (e: Event) => {
    const target = e.target;
    let y: number;
    let prev: number;
    if (target === document || target === document.documentElement || target === document.body) {
      y = scrollY;
      prev = this.winScrollY;
      this.winScrollY = y;
    } else if (target instanceof Element) {
      y = target.scrollTop;
      prev = this.elScroll.get(target) ?? y;
      this.elScroll.set(target, y);
    } else return;
    const dy = y - prev;
    if (!dy) return;
    this.pendingScroll += dy;
    const now = performance.now();
    this.velT[this.velI] = now;
    this.velD[this.velI] = Math.abs(dy);
    this.velI = (this.velI + 1) & 31;
    if (now - this.gestureAt > 250) this.gesture = 0;
    this.gesture += Math.abs(dy);
    this.gestureAt = now;
    this.wake();
  };

  private onPointer = (e: PointerEvent) => {
    this.pointerX = e.clientX;
    this.pointerY = e.clientY;
    if (this.reduced) return;
    for (const d of this.drips) {
      if (d.phase === WAITING || d.m < 8) continue;
      if (Math.abs(d.x - e.clientX) < 110 && Math.abs(d.y - e.clientY) < 110) {
        this.stirUntil = this.t + 1.2;
        this.wake();
        return;
      }
    }
  };

  private onResize = () => {
    if (!this.overlay) return;
    // Resizing fires in bursts; reallocate once it settles. CSS stretches the old frame meanwhile.
    clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = undefined;
      if (!this.overlay) return;
      this.measure();
      this.wake();
    }, 150);
  };

  private onVisibility = () => {
    if (document.visibilityState === 'visible') this.wake();
    else {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      clearTimeout(this.calmTimer);
      this.calmTimer = undefined;
    }
  };

  /** Follow the page if it switches between light and dark while it bleeds. */
  private watchTheme(): void {
    this.themeObserver = new MutationObserver(this.onTheme);
    const opts = { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'data-bs-theme'] };
    this.themeObserver.observe(document.documentElement, opts);
    if (document.body) this.themeObserver.observe(document.body, opts);
    this.scheme = matchMedia('(prefers-color-scheme: dark)');
    this.scheme.addEventListener('change', this.onTheme);
  }

  private onTheme = () => {
    // At most a few checks a second, however busily the page rewrites its classes.
    if (this.themeTimer !== undefined || !this.overlay) return;
    this.themeTimer = window.setTimeout(() => {
      this.themeTimer = undefined;
      if (!this.overlay) return;
      const dark = pageDarkness();
      if (Math.abs(dark - this.darkTarget) < 0.05) return;
      this.darkTarget = dark;
      this.wake();
    }, 300);
  };

  private onContextLost = (e: Event) => {
    e.preventDefault();
    // Fall back to the CPU renderer on a fresh canvas.
    this.canvas?.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas?.remove();
    this.gl = null;
    this.glTex = null;
    if (!this.overlay) return;
    this.initCpu();
    this.W = this.H = 0;
    this.measure();
    this.wake();
  };

  private wake(): void {
    // Cut a calm wait short: the clock keeps running from the last frame.
    const waiting = this.calmTimer !== undefined;
    clearTimeout(this.calmTimer);
    this.calmTimer = undefined;
    if (this.raf || !this.overlay || document.visibilityState !== 'visible') return;
    if (!waiting) this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private calmFrame = () => {
    this.calmTimer = undefined;
    if (this.raf || !this.overlay || document.visibilityState !== 'visible') return;
    this.raf = requestAnimationFrame(this.frame);
  };

  // --- simulation ------------------------------------------------------------

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.overlay) return;
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const pace = this.step(dt);
    if (!this.overlay) return; // wiped away or faded out during the step
    this.rasterize();
    this.present();
    // Running drips, ripples and fades get every frame; drying and seeping only a few a second.
    if (pace === LIVELY) this.raf = requestAnimationFrame(this.frame);
    else if (pace === CALM) this.calmTimer = window.setTimeout(this.calmFrame, 1000 / CALM_FPS - 6);
  };

  /** Advance everything by dt seconds. Returns how soon the next frame is needed (IDLE, CALM, LIVELY). */
  private step(dt: number): number {
    this.t += dt;
    const t = this.t;
    // busy: anything still changing at all; lively: changing fast enough to need every frame.
    let busy = this.idle !== 0;
    let lively = this.pendingScroll !== 0;

    // Fades.
    if (this.stopping) {
      this.opacity = Math.max(0, this.opacity - dt / FADE_OUT_S);
      if (this.opacity <= 0) {
        this.destroy();
        return IDLE;
      }
      lively = true;
    } else if (this.opacity < 1) {
      this.opacity = Math.min(1, this.opacity + dt / 0.9);
      lively = true;
    }
    if (this.dark !== this.darkTarget) {
      // The page changed theme: ease the look over rather than snapping it.
      const k = dt / 0.6;
      this.dark = Math.abs(this.darkTarget - this.dark) <= k ? this.darkTarget : this.dark + Math.sign(this.darkTarget - this.dark) * k;
      lively = true;
    }

    this.handleScroll(dt);
    if (this.wiping) {
      this.wipeT += dt;
      if (this.wipeT >= (this.reduced ? 1.3 : WIPE_S)) {
        this.destroy();
        return IDLE;
      }
      lively = true;
    }
    this.wet += (this.wetTarget - this.wet) * (1 - Math.exp(-dt / 0.4));
    if (Math.abs(this.wet - this.wetTarget) > 0.02) lively = true;
    else if (Math.abs(this.wet - this.wetTarget) > 0.002 || this.wetTarget < 0.999) busy = true;
    if (this.sag > 0.05) {
      this.sag *= Math.exp(-dt / 0.6);
      lively = true;
    } else this.sag = 0;

    // Is a drip still doing something? (A stop or a wipe freezes the schedule.)
    const frozen = this.stopping || this.wiping;
    let live = false;
    let gone = false;
    for (const d of this.drips) {
      if (d.doomed) {
        // Left over text by a resize: it thins and evaporates where it is.
        d.gone = Math.max(0, d.gone - dt / EVAPORATE_S);
        d.bump *= Math.exp(-dt * 3);
        if (d.gone <= 0) gone = true;
        lively = true;
        continue;
      }
      if (this.wiping && !this.reduced) {
        this.streak(d, dt);
      } else if (d.phase === RESTING) {
        if (t - d.lastDeposit < TRAIL_TAU * 2) busy = true;
      } else if (!(frozen && (d.phase === WAITING || d.phase === GATHERING))) {
        live = true;
        // A drip waiting its turn only sags the meniscus a little; the rest move.
        if (d.phase === WAITING) busy = true;
        else lively = true;
        this.stepDrip(d, dt);
      }
      // Mouse nearby: the head trembles, as if breath touched it.
      let target = 0;
      if (t < this.stirUntil && d.phase !== WAITING) {
        const dist = Math.hypot(d.x - this.pointerX, d.y - this.pointerY);
        if (dist < 110) target = Math.sin(t * 7.3 + d.wobP) * 2.4 * (1 - dist / 110);
      }
      d.waver += (target - d.waver) * Math.min(1, dt * 6);
      if (Math.abs(d.waver) > 0.03) lively = true;
    }
    if (gone) this.drips = this.drips.filter((d) => d.gone > 0);
    if (t >= this.nextAreaCheck && !frozen) {
      this.nextAreaCheck = t + 0.5;
      this.checkAreas();
    }
    if (t < this.stirUntil) lively = true;
    if (live || t < this.endT) busy = true;

    // Band drift slows to a stop once nothing is flowing.
    this.act += ((live ? 1 : 0) - this.act) * Math.min(1, dt * 0.5);
    this.bandT += dt * this.act;
    if (this.act > 0.01) busy = true;

    if (this.stepBits(dt)) lively = true;
    const pool = this.stepPool(dt);
    if (pool === LIVELY) lively = true;
    else if (pool === CALM) busy = true;
    this.computeBand();
    return lively ? LIVELY : busy ? CALM : IDLE;
  }

  private handleScroll(dt: number): void {
    const s = this.pendingScroll;
    this.pendingScroll = 0;
    const now = performance.now();
    if (this.stopping || this.wiping) return;
    if (!s) {
      // Calm again: the liquid gathers itself back.
      if (now - this.gestureAt > 400) this.wetTarget += (1 - this.wetTarget) * (1 - Math.exp(-dt / 3));
      // The page under the glass has moved: see which drips now run over text.
      if (this.moved && now - this.gestureAt > 500) {
        this.moved = false;
        this.requestRecheck();
      }
      return;
    }
    this.moved = true;
    let sum = 0;
    for (let i = 0; i < 32; i++) if (now - this.velT[i] < 150) sum += this.velD[i];
    const speed = sum / 0.15;
    if (speed > WIPE_SPEED || this.gesture >= this.H * WIPE_GESTURE) {
      this.wiping = true;
      this.wipeT = 0;
      // Wiped liquid runs: every head streaks downwards, whichever way the page went.
      this.wipeDir = 1;
      return;
    }
    this.wetTarget = Math.min(this.wetTarget, 1 - 0.45 * Math.min(1, this.gesture / (this.H * WIPE_GESTURE)));
    if (this.reduced) return; // a gentle dim only

    // The drips are dragged along with the content (which moves opposite to the scroll).
    const g = Math.max(-40, Math.min(40, -s * 0.25));
    if (g > 0) this.sag = Math.min(8, this.sag + g * 0.3);
    for (let k = 0; k < this.drips.length; k++) {
      const d = this.drips[k];
      if (d.phase === WAITING || d.phase === GATHERING) continue;
      const kick = g * (0.65 + 0.35 * hash(k + 1));
      if (kick > 0) {
        // Dragged down: the head smears on, stretching its trail behind it.
        // (Never past what it stopped above.)
        const lim = Math.min(this.H - 4, d.stopY - Math.sqrt(Math.max(0, d.m) / Math.PI) * 1.1);
        d.y = Math.max(d.y, Math.min(lim, d.y + kick));
        for (let i = 1; i < d.n; i++) d.trail[i * 4 + 1] += kick * 0.85 * (i / d.n) * (i / d.n);
        if (d.phase === RUNNING) d.v = Math.max(d.v, (kick / Math.max(dt, 1 / 60)) * 0.15);
        this.deposit(d, true);
      } else {
        // Dragged up: it slides back a little over its own trail, leaving nothing new.
        d.y = Math.max(this.bandDepthAt(d.x) * 0.6, d.y + kick * 0.4);
        d.lastY = Math.min(d.lastY, d.y);
        // Taking the end of the trail with it: a trail never pokes out below its own head.
        // (A pooling head sits on the pool, and its trail runs into it.)
        if (d.phase !== POOLING) {
          const end = d.y - Math.sqrt(Math.max(0, d.m) / Math.PI) * 0.2;
          while (d.n > 2 && d.trail[(d.n - 1) * 4 + 1] > end) d.n--;
        }
      }
    }
    for (const b of this.drops) if (b.alive) b.y += g;
    // The pool sloshes: velocity goes into its wave, which rounds and damps it.
    const amp = Math.min(18, Math.abs(s) * 0.1) * Math.sign(s);
    this.wavePhase += 1.7;
    for (let j = 0; j < this.poolV.length; j++) this.poolV[j] += amp * (0.6 + 0.4 * Math.sin(j * 0.05 + this.wavePhase));
    if (Math.abs(s) > 60) {
      const x = this.rng() * this.W;
      if (this.poolAt(x) > 3) this.spawnSplash(x, this.H - this.poolAt(x), (this.rng() - 0.5) * 120 * this.S, -(120 + this.rng() * 160) * this.S, 1.4 + this.rng() * 1.4);
    }
  }

  /** Being wiped: every head streaks off in the drag direction while it all fades. */
  private streak(d: Drip, dt: number): void {
    if (d.phase === WAITING || d.m < 2) return;
    d.v = Math.abs(d.v) + 1400 * this.S * dt;
    d.y += this.wipeDir * d.v * dt;
    if (this.wipeDir > 0) this.deposit(d, true);
    else d.lastY = Math.min(d.lastY, d.y);
  }

  private stepDrip(d: Drip, dt: number): void {
    const t = this.t;
    if (d.phase === WAITING) {
      // The meniscus already sags a little where a drip is about to form.
      d.bump = d.rRelease * 0.3 * smooth(d.at - 4, d.at, t);
      if (t >= d.at) {
        // Look again at what lies below: another creature may have settled there since.
        d.stopY = this.stopAt(d.x0, d.edge, d.wobA);
        if (d.stopY < MIN_RUN) {
          d.doomed = true;
          this.claim();
          return;
        }
        d.phase = GATHERING;
        d.x = d.x0 + d.wobA * Math.sin(d.wobP);
        d.lastX = d.x;
        d.lastY = -6;
      }
      return;
    }
    if (d.phase === GATHERING) {
      // A bead swells under the meniscus, hesitating before it lets go.
      const p = Math.min(1, (t - d.at) / d.gather);
      const e = p * p * (3 - 2 * p) + 0.05 * Math.sin(p * Math.PI * 3) * (1 - p);
      d.m = d.mRelease * Math.max(0, Math.pow(Math.max(0, e), 1.15));
      const rv = Math.sqrt(d.m / Math.PI);
      d.bump = d.rRelease * 0.9 * e;
      d.y = this.bandDepthAt(d.x) * 0.75 + rv * 0.45;
      if (p >= 1) {
        d.phase = RUNNING;
        d.v = 0;
        this.pushTrail(d, d.x, -6, d.rRelease * 0.5);
        this.pushTrail(d, d.x, d.y - rv * 0.2, d.rRelease * 0.5);
      }
      return;
    }
    const rv = Math.sqrt(Math.max(0, d.m) / Math.PI);
    // Heads never grow into balls: past this size the meniscus stops feeding them.
    const mMax = Math.PI * Math.pow((this.reduced ? 11 : 14) * d.k, 2);
    if (d.phase === POOLING) {
      const fin = Math.min(d.feed, d.feedRate * dt);
      d.feed -= fin;
      d.feedRate *= Math.exp(-dt / 5);
      if (d.feedRate < 1.5) d.feed = 0; // what is left stays in the meniscus
      d.m += fin;
      const dm = d.m * (1 - Math.exp(-dt * 1.3));
      d.m -= dm;
      this.addPool(d.x, dm);
      d.y = this.H - this.poolAt(d.x) - rv * 0.2;
      d.bump += (d.rRelease * 0.3 - d.bump) * Math.min(1, dt * 0.6);
      if (d.m < 3 && d.feed < 1) {
        d.phase = RESTING;
        d.m = 0;
      }
      return;
    }

    // Running: feed from the meniscus, surface tension pins, gravity.
    const fin = Math.min(d.feed, d.feedRate * dt);
    d.feed -= fin;
    d.feedRate *= Math.exp(-dt / 5);
    if (d.feedRate < 1.5) d.feed = 0;
    d.m = Math.min(mMax, d.m + fin);
    const k = this.sizeK * d.k;
    let mc = Math.PI * 7.2 * 7.2 * k * k;
    while (d.pinIdx < d.pins.length && d.y > d.pins[d.pinIdx] + 9) d.pinIdx++;
    if (d.pinIdx < d.pins.length && d.y > d.pins[d.pinIdx] - 3) mc *= d.pinK[d.pinIdx];
    mc = Math.min(mc, mMax * 0.9);
    const ex = d.m - mc;
    const vmax = (this.reduced ? 34 : 150) * this.S;
    let vt = ex > 0 ? vmax * Math.pow(Math.min(1, ex / (mc * 0.9)), 1.4) : 0;
    // Text or another creature below: the head slows as it nears it and hangs just above.
    const room = d.stopY - (d.y + rv * 1.1);
    if (room < 40) {
      vt *= Math.max(0, room / 40);
      if (room < 2) d.feed = 0;
    }
    const rate = vt > d.v ? 1.7 : 7;
    d.v += (vt - d.v) * (1 - Math.exp(-dt * rate));
    // Where surface tension held the head for a while, a little bead stays behind.
    if (d.v < 4) d.stuck += dt;
    else {
      if (d.stuck > 0.7) this.pushTrail(d, d.x, d.y - rv * 0.15, Math.min(6 * k, rv * 0.6));
      d.stuck = 0;
    }
    const dy = d.v * dt;
    d.y += dy;
    d.m = Math.max(0, d.m - dy * 0.06 * Math.sqrt(d.m));
    d.x = d.x0 + d.wobA * Math.sin(d.y * d.wobF + d.wobP);
    d.stretch += (Math.min(1, d.v / vmax) - d.stretch) * Math.min(1, dt * 5);
    d.bump += ((d.feed > 1 ? d.rRelease * 0.5 : d.rRelease * 0.28) - d.bump) * Math.min(1, dt * 0.7);
    this.deposit(d, false);

    // Now and then a heavy, fast head lets go of a drop.
    if (!this.reduced && d.detach && d.stopY >= this.H && d.v > vmax * 0.55 && d.m > mc * 1.4 && this.rng() < d.detach * dt) {
      const md = d.m * (0.38 + this.rng() * 0.12);
      if (this.spawnDrop(d.x, d.y + rv * 0.6, d.v * 1.15, md)) d.m -= md;
    }
    if (d.stopY >= this.H && d.y + rv * 0.6 >= this.H - this.poolAt(d.x)) {
      d.phase = POOLING;
      d.v = 0;
      this.ripple(d.x, 3 * this.S);
    } else if (vt < 1 && d.v < 0.6 && d.feed < 1) {
      d.phase = RESTING;
      d.lastDeposit = Math.max(d.lastDeposit, t);
    }
  }

  /** Leave trail behind the head every few pixels it travels (downwards). */
  private deposit(d: Drip, smear: boolean): void {
    const rv = Math.sqrt(Math.max(0, d.m) / Math.PI);
    const hx = d.x;
    const hy = d.y - rv * 0.2;
    if (hy < d.lastY + (smear ? 6 : 3.5) && Math.abs(hx - d.lastX) < 4) return;
    // Slow heads leave more behind than fast ones; the width wanders a little.
    const speed = Math.min(1, d.v / ((this.reduced ? 34 : 150) * this.S));
    const wob = 0.8 + 0.4 * (0.5 + 0.5 * Math.sin(hy * 0.045 + d.wobP * 3) * Math.sin(hy * 0.017 + d.wobP));
    let r = Math.max(0.8, Math.min(5.5 * this.sizeK * d.k, rv * (0.5 - 0.18 * speed) * wob)) * (smear ? 1.15 : 1);
    if (d.n > 0) r = d.trail[(d.n - 1) * 4 + 2] * 0.6 + r * 0.4;
    this.pushTrail(d, hx, hy, r);
  }

  private pushTrail(d: Drip, x: number, y: number, r: number): void {
    if (d.n >= TRAIL_CAP) {
      // Out of room: thin the oldest half (every other point).
      let w = 1;
      for (let i = 2; i < d.n; i += 2, w++) for (let c = 0; c < 4; c++) d.trail[w * 4 + c] = d.trail[i * 4 + c];
      d.n = w;
    }
    const o = d.n * 4;
    d.trail[o] = x;
    d.trail[o + 1] = y;
    d.trail[o + 2] = r;
    d.trail[o + 3] = this.t;
    d.n++;
    d.lastX = x;
    d.lastY = y;
    d.lastDeposit = this.t;
  }

  private spawnDrop(x: number, y: number, vy: number, m: number): boolean {
    for (const b of this.drops) {
      if (b.alive) continue;
      b.alive = true;
      b.x = x;
      b.y = y;
      b.vx = 0;
      b.vy = vy;
      b.m = m;
      b.age = 0;
      return true;
    }
    return false;
  }

  private spawnSplash(x: number, y: number, vx: number, vy: number, r: number): void {
    if (this.reduced) return;
    for (const b of this.splash) {
      if (b.alive) continue;
      b.alive = true;
      b.x = x;
      b.y = y;
      b.vx = vx;
      b.vy = vy;
      b.m = Math.PI * r * r;
      b.age = 0;
      return;
    }
  }

  private stepBits(dt: number): boolean {
    let busy = false;
    const G = 1700 * this.S;
    for (const b of this.drops) {
      if (!b.alive) continue;
      busy = true;
      b.vy += G * dt;
      b.y += b.vy * dt;
      b.age += dt;
      const rv = Math.sqrt(b.m / Math.PI);
      const surf = this.H - this.poolAt(b.x);
      if (b.y + rv * 0.5 >= surf || b.age > 4) {
        b.alive = false;
        this.addPool(b.x, b.m);
        const impact = Math.min(1.6, b.vy / (900 * this.S));
        this.ripple(b.x, (4 + 5 * impact) * this.S);
        const n = 2 + Math.floor(this.rng() * 3 * impact);
        for (let i = 0; i < n; i++) {
          const dir = this.rng() < 0.5 ? -1 : 1;
          this.spawnSplash(b.x + dir * rv * 0.5, surf - 1, dir * (30 + this.rng() * 110) * this.S, -(110 + this.rng() * 200) * this.S * impact, 1.1 + this.rng() * 1.4);
        }
      }
    }
    for (const b of this.splash) {
      if (!b.alive) continue;
      busy = true;
      b.vy += G * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.age += dt;
      const surf = this.H - this.poolAt(b.x);
      if ((b.vy > 0 && b.y >= surf) || b.age > 2.5 || b.x < -10 || b.x > this.W + 10) {
        b.alive = false;
        this.addPool(b.x, b.m);
        this.ripple(b.x, 1.2 * this.S);
      }
    }
    return busy;
  }

  // --- pool ------------------------------------------------------------------

  private poolCap(): number {
    return Math.min(16, Math.max(10, this.H * 0.018));
  }

  private addPool(x: number, area: number): void {
    if (area <= 0) return;
    const base = this.poolBase;
    const j0 = Math.round(x / POOL_STEP) + 1;
    const sigma = 4;
    const amp = (area * 1.2) / (POOL_STEP * sigma * 2.5066);
    const cap = this.poolCap();
    for (let k = -12; k <= 12; k++) {
      const j = j0 + k;
      if (j < 0 || j >= base.length) continue;
      base[j] = Math.min(cap, base[j] + amp * Math.exp((-k * k) / (2 * sigma * sigma)));
    }
    this.lastPoolAdd = this.t;
  }

  private ripple(x: number, strength: number): void {
    if (this.reduced) return;
    const j0 = Math.round(x / POOL_STEP) + 1;
    for (let k = -7; k <= 7; k++) {
      const j = j0 + k;
      if (j < 1 || j >= this.poolV.length - 1) continue;
      this.poolV[j] -= strength * 3.2 * Math.exp((-k * k) / 9);
    }
  }

  /** Pool height (px above the bottom edge) at x. */
  private poolAt(x: number): number {
    const f = x / POOL_STEP + 1;
    const j = Math.max(0, Math.min(this.poolBase.length - 2, Math.floor(f)));
    const a = Math.min(1, Math.max(0, f - j));
    const h0 = this.poolBase[j] + this.poolU[j];
    const h1 = this.poolBase[j + 1] + this.poolU[j + 1];
    return h0 + (h1 - h0) * a;
  }

  private stepPool(dt: number): number {
    const base = this.poolBase;
    const u = this.poolU;
    const v = this.poolV;
    const n = base.length;
    // A thin film: it spreads quickly, and seeps in evenly while the tab bleeds.
    const seep = this.t < this.endT ? smooth(4, 24, this.t) * 3.2 * this.S : 0;
    const steps = Math.max(1, Math.ceil(dt * 60 - 0.01));
    const h = dt / steps;
    const D = 5 * h;
    const damp = Math.exp(-h * 2.6);
    const c2 = 560;
    for (let s = 0; s < steps; s++) {
      let prevB = base[0];
      for (let j = 1; j < n - 1; j++) {
        const cur = base[j];
        base[j] += D * (prevB + base[j + 1] - 2 * cur);
        if (base[j] < seep) base[j] += (seep - base[j]) * h * 0.1;
        prevB = cur;
      }
      base[0] = base[1];
      base[n - 1] = base[n - 2];
      // Ripples: a damped 1D wave; viscosity keeps the crests heavy and round.
      for (let j = 1; j < n - 1; j++) v[j] += (c2 * (u[j - 1] + u[j + 1] - 2 * u[j]) - 26 * u[j]) * h;
      let prev = v[0];
      for (let j = 1; j < n - 1; j++) {
        const cur = v[j];
        v[j] += 0.2 * (prev + v[j + 1] - 2 * cur);
        prev = cur;
      }
      for (let j = 1; j < n - 1; j++) {
        v[j] *= damp;
        u[j] += v[j] * h;
        // Never more than a gentle swell, and never below the glass edge.
        const lim = Math.min(20, base[j] * 1.5 + 6);
        if (u[j] > lim) {
          u[j] = lim;
          v[j] *= 0.5;
        } else if (u[j] < -base[j] - 2) {
          u[j] = -base[j] - 2;
          v[j] *= 0.5;
        }
      }
      u[0] = u[1];
      u[n - 1] = u[n - 2];
    }
    let pace = this.t - this.lastPoolAdd < 6 || seep ? CALM : IDLE;
    let energy = 0;
    for (let j = 1; j < n - 1; j++) energy = Math.max(energy, Math.abs(u[j]), Math.abs(v[j]) * 0.1);
    // Ripples you can see need every frame; the last faint swell can settle at the calm rate.
    if (energy > 0.3) pace = LIVELY;
    else if (energy > 0.02) pace = Math.max(pace, CALM);
    else if (energy > 0) {
      u.fill(0);
      v.fill(0);
    }
    return pace;
  }

  // --- meniscus --------------------------------------------------------------

  private computeBand(): void {
    const t = this.t;
    const depthMax = Math.min(20, Math.max(10, this.H * 0.02));
    const grow = smooth(0, 2.6, t);
    const depth = depthMax * grow * (0.35 + 0.65 * grow);
    const p = this.bandPhase;
    const bt = this.bandT;
    const sag = this.sag;
    for (let i = 0; i < this.band.length; i++) {
      const x = (i - 1) * BAND_STEP;
      let d =
        depth *
        (0.6 + 0.22 * Math.sin(x * 0.011 + p[0] + bt * 0.35) + 0.12 * Math.sin(x * 0.029 + p[1] - bt * 0.5) + 0.06 * Math.sin(x * 0.071 + p[2]));
      for (const dr of this.drips) {
        if (dr.bump <= 0.01) continue;
        const dx = x - dr.x0;
        const w = dr.bumpW;
        if (dx > -3 * w && dx < 3 * w) d += dr.bump * Math.exp((-dx * dx) / (2 * w * w));
      }
      if (sag) d += sag * (0.6 + 0.4 * Math.sin(x * 0.013 + p[3]));
      this.band[i] = d;
    }
  }

  private bandDepthAt(x: number): number {
    const f = x / BAND_STEP + 1;
    const j = Math.max(0, Math.min(this.band.length - 2, Math.floor(f)));
    const a = Math.min(1, Math.max(0, f - j));
    return this.band[j] + (this.band[j + 1] - this.band[j]) * a;
  }

  // --- field -----------------------------------------------------------------

  /** Mark the tiles covering a cell rectangle as holding liquid. */
  private mark(x0: number, y0: number, x1: number, y1: number): void {
    const t0x = Math.max(0, x0 >> 3);
    const t1x = Math.min(this.tx - 1, x1 >> 3);
    const t0y = Math.max(0, y0 >> 3);
    const t1y = Math.min(this.ty - 1, y1 >> 3);
    for (let ty = t0y; ty <= t1y; ty++) for (let tx = t0x; tx <= t1x; tx++) this.dirty[ty * this.tx + tx] = 1;
  }

  /** Rasterise everything into the metaball field (and its freshness channel). */
  private rasterize(): void {
    // Tiles that held liquid last frame must be cleared and repainted this frame.
    const tmp = this.prevDirty;
    this.prevDirty = this.dirty;
    this.dirty = tmp;
    this.dirty.fill(0);
    this.field.fill(0);
    this.gloss.fill(0);
    const t = this.t;
    // Gentle scrolling thins the liquid a little; most of the dimming is opacity, so it darkens rather than paling.
    const k = 0.85 + 0.15 * this.wet;
    for (const d of this.drips) {
      if (d.phase === WAITING) continue;
      // An evaporating drip thins out evenly until it falls below the surface threshold.
      const kd = d.gone < 1 ? k * d.gone * (2 - d.gone) : k;
      if (d.n > 0) this.trailField(d, kd, t);
      if (d.m > 1) {
        const rv = Math.min(16, Math.sqrt(d.m / Math.PI));
        const x = d.x + d.waver;
        const s = d.stretch;
        // A teardrop pressed to the glass: heaviest at the bottom, drawn out as it runs.
        this.blob(x, d.y + rv * 0.2 * s, rv * (1 - 0.1 * s), rv * (1 + 0.22 * s), 0.95 * kd);
        this.blob(x, d.y - rv * (0.55 + 0.45 * s), rv * 0.72, rv * (0.8 + 0.3 * s), 0.6 * kd);
        this.blob(x, d.y - rv * (1.15 + 0.8 * s), rv * 0.45, rv * (0.6 + 0.4 * s), 0.55 * kd);
      }
    }
    for (const b of this.drops) {
      if (!b.alive) continue;
      const rv = Math.sqrt(b.m / Math.PI);
      const s = Math.min(1, b.vy / (800 * this.S));
      this.blob(b.x, b.y, rv * (1 - 0.12 * s), rv * (1 + 0.15 * s), 0.95 * k);
      this.blob(b.x, b.y - rv * (0.8 + 1.4 * s), rv * (0.62 - 0.1 * s), rv * (0.62 + 0.3 * s), 0.75 * k);
      this.blob(b.x, b.y - rv * (1.5 + 2.8 * s), rv * 0.34, rv * (0.34 + 0.3 * s), 0.55 * k);
    }
    for (const b of this.splash) {
      if (!b.alive) continue;
      const r = Math.sqrt(b.m / Math.PI);
      this.blob(b.x, b.y, r, r, 0.95 * k);
    }
    this.bandField(k);
  }

  /** A soft elliptical blob: field = peak·(1 − d²)², d the normalised distance. */
  private blob(cx: number, cy: number, rx: number, ry: number, peak: number): void {
    let Rx = rx * 1.45 * FS;
    let Ry = ry * 1.45 * FS;
    let p = peak;
    if (Rx < 1.6) {
      p *= Rx / 1.6;
      Rx = 1.6;
    }
    if (Ry < 1.6) {
      p *= Ry / 1.6;
      Ry = 1.6;
    }
    const F = this.field;
    const G = this.gloss;
    const fw = this.fw;
    const fx = cx * FS;
    const fy = cy * FS;
    const x0 = Math.max(0, Math.floor(fx - Rx));
    const x1 = Math.min(fw - 1, Math.ceil(fx + Rx));
    const y0 = Math.max(0, Math.floor(fy - Ry));
    const y1 = Math.min(this.fh - 1, Math.ceil(fy + Ry));
    if (x1 < x0 || y1 < y0) return;
    this.mark(x0, y0, x1, y1);
    const ix = 1 / (Rx * Rx);
    const iy = 1 / (Ry * Ry);
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - fy;
      const dy2 = dy * dy * iy;
      if (dy2 >= 1) continue;
      const row = y * fw;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - fx;
        const q = dx * dx * ix + dy2;
        if (q < 1) {
          const w = 1 - q;
          const v = p * w * w;
          F[row + x] += v;
          G[row + x] += v;
        }
      }
    }
  }

  /** A drip's trail as a soft ribbon that thins, dries and goes matte with age. */
  private trailField(d: Drip, k: number, t: number): void {
    const tr = d.trail;
    const fresh = 0.9 * k;
    const dry = 0.62 * k;
    let px = 0;
    let py = 0;
    let pr = 0;
    let pi = 0;
    let pg = 0;
    for (let i = 0; i < d.n; i++) {
      const o = i * 4;
      const age = t - tr[o + 3];
      const r0 = tr[o + 2];
      const res = 0.5 + r0 * 0.15;
      const r = res + (r0 - res) * Math.exp(-age / TRAIL_TAU);
      const inten = dry + (fresh - dry) * Math.exp(-age / (TRAIL_TAU * 1.8));
      const g = Math.exp(-age / (TRAIL_TAU * 1.2));
      const x = tr[o];
      const y = tr[o + 1];
      if (i > 0) this.ribbon(px, py, pr, pi, pg, x, y, r, inten, g);
      px = x;
      py = y;
      pr = r;
      pi = inten;
      pg = g;
    }
    if (d.m > 1) {
      const rv = Math.sqrt(d.m / Math.PI);
      const hx = d.x + d.waver;
      if (d.phase !== RESTING) {
        // Live segment from the last trail point to the head.
        const r = Math.max(pr, Math.min(5.5 * this.sizeK * d.k, rv * 0.42));
        const hy = d.y - rv * 0.2;
        this.ribbon(px, py, pr, pi, pg, hx, hy, r, fresh, 1);
        px = hx;
        py = hy;
        pr = r;
        pi = fresh;
        pg = 1;
      }
      // On into the head, fading out: a trail that simply stopped there would leave a step in
      // the surface, which lights up as a bright bar across the middle of the bead.
      this.ribbon(px, py, pr, pi, pg, hx, d.y + rv * 0.6, pr, 0, pg);
    }
  }

  /** One ribbon segment, scanned row by row (rows are half-open, so joints never double up). */
  private ribbon(xa: number, ya: number, ra: number, ia: number, ga: number, xb: number, yb: number, rb: number, ib: number, gb: number): void {
    let fa = ya * FS;
    let fb = yb * FS;
    if (fb < fa) {
      let s = fa;
      fa = fb;
      fb = s;
      s = xa;
      xa = xb;
      xb = s;
      s = ra;
      ra = rb;
      rb = s;
      s = ia;
      ia = ib;
      ib = s;
      s = ga;
      ga = gb;
      gb = s;
    }
    const span = fb - fa;
    if (span < 1e-3) return;
    const F = this.field;
    const G = this.gloss;
    const fw = this.fw;
    const ys = Math.max(0, Math.ceil(fa - 0.5));
    const ye = Math.min(this.fh - 1, Math.ceil(fb - 0.5) - 1);
    if (ye < ys) return;
    const rMax = Math.max(ra, rb, 1) * 1.5 * FS + 1;
    this.mark(Math.floor(Math.min(xa, xb) * FS - rMax), ys, Math.ceil(Math.max(xa, xb) * FS + rMax), ye);
    for (let y = ys; y <= ye; y++) {
      const kk = (y + 0.5 - fa) / span;
      const cx = (xa + (xb - xa) * kk) * FS;
      let r = (ra + (rb - ra) * kk) * 1.5 * FS;
      let p = ia + (ib - ia) * kk;
      const gl = ga + (gb - ga) * kk;
      if (r < 1.3) {
        // Very thin: keep it one steady line rather than letting it break into dashes.
        p *= Math.max(0.85, r / 1.3);
        r = 1.3;
      }
      const inv = 1 / (r * r);
      const x0 = Math.max(0, Math.floor(cx - r));
      const x1 = Math.min(fw - 1, Math.ceil(cx + r));
      const row = y * fw;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const q = dx * dx * inv;
        if (q < 1) {
          const w = 1 - q;
          const v = p * w * w;
          F[row + x] += v;
          G[row + x] += v * gl;
        }
      }
    }
  }

  /** The meniscus along the top and the pool along the bottom, as ramped bands. */
  private bandField(k: number): void {
    const F = this.field;
    const G = this.gloss;
    const fw = this.fw;
    const fh = this.fh;
    const bottom = this.H * FS;
    const pool = this.poolBase;
    const pu = this.poolU;
    const top = this.colTop;
    const bot = this.colBot;
    // Edge heights per field column first, so the ramp can follow the slope.
    for (let fx = 0; fx < fw; fx++) {
      const x = (fx + 0.5) / FS;
      top[fx] = this.bandDepthAt(x) * FS;
      const f = x / POOL_STEP + 1;
      const j = Math.min(pool.length - 2, Math.floor(f));
      const a = f - j;
      bot[fx] = (pool[j] + pu[j] + (pool[j + 1] + pu[j + 1] - pool[j] - pu[j]) * a) * FS;
    }
    const tail = 0.27;
    let topMax = -1;
    let botMin = fh;
    for (let fx = 0; fx < fw; fx++) {
      const l = fx > 0 ? fx - 1 : fx;
      const r = fx < fw - 1 ? fx + 1 : fx;
      // Distance to a sloped edge is the vertical distance times cos(slope): steep
      // flanks get a proportionally longer vertical ramp instead of stair steps.
      const D = top[fx];
      if (D > -RAMP) {
        const sl = (top[r] - top[l]) / (r - l);
        const ramp = RAMP * Math.sqrt(1 + sl * sl);
        const yEnd = Math.min(fh - 1, Math.floor(D + tail * ramp));
        if (yEnd > topMax) topMax = yEnd;
        for (let y = 0; y <= yEnd; y++) {
          const v = tail + (D - (y + 0.5)) / ramp;
          if (v <= 0) break;
          const val = (v < tail ? (v * v) / tail : Math.min(1, v)) * k;
          F[y * fw + fx] += val;
          G[y * fw + fx] += val;
        }
      }
      const P = bot[fx];
      if (P > -RAMP * 0.5) {
        const sl = (bot[r] - bot[l]) / (r - l);
        const ramp = RAMP * Math.sqrt(1 + sl * sl);
        const yStart = Math.max(0, Math.ceil(bottom - P - tail * ramp));
        if (yStart < botMin) botMin = yStart;
        for (let y = fh - 1; y >= yStart; y--) {
          const v = tail + (P - (bottom - (y + 0.5))) / ramp;
          if (v <= 0) break;
          const val = (v < tail ? (v * v) / tail : Math.min(1, v)) * k;
          F[y * fw + fx] += val;
          G[y * fw + fx] += val;
        }
      }
    }
    if (topMax >= 0) this.mark(0, 0, fw - 1, topMax);
    if (botMin < fh) this.mark(0, botMin, fw - 1, fh - 1);
  }

  // --- output ----------------------------------------------------------------

  /**
   * Tiles to process this frame: those with liquid now or last frame, grown by
   * one tile for the normal stencil and the drop shadow. Their field cells are
   * compressed to heights in place, and the freshness sum becomes a 0–1 gloss.
   */
  private prepare(): void {
    const tx = this.tx;
    const ty = this.ty;
    const sh = this.shade;
    sh.fill(0);
    for (let y = 0; y < ty; y++) {
      for (let x = 0; x < tx; x++) {
        if (!this.dirty[y * tx + x] && !this.prevDirty[y * tx + x]) continue;
        for (let yy = Math.max(0, y - 1); yy <= Math.min(ty - 1, y + 1); yy++) {
          for (let xx = Math.max(0, x - 1); xx <= Math.min(tx - 1, x + 1); xx++) sh[yy * tx + xx] = 1;
        }
      }
    }
    const lv = this.live;
    lv.fill(0);
    for (let y = 0; y < ty; y++) {
      for (let x = 0; x < tx; x++) {
        if (!this.dirty[y * tx + x]) continue;
        for (let yy = Math.max(0, y - 1); yy <= Math.min(ty - 1, y + 1); yy++) {
          for (let xx = Math.max(0, x - 1); xx <= Math.min(tx - 1, x + 1); xx++) lv[yy * tx + xx] = 1;
        }
      }
    }
    const F = this.field;
    const G = this.gloss;
    const fw = this.fw;
    const ct = compTab!;
    const scale = COMP_N / COMP_MAX;
    for (let y = 0; y < ty; y++) {
      for (let x = 0; x < tx; x++) {
        if (!sh[y * tx + x]) continue;
        const x0 = x * TILE;
        const x1 = Math.min(fw, x0 + TILE);
        const y1 = Math.min(this.fh, y * TILE + TILE);
        for (let cy = y * TILE; cy < y1; cy++) {
          for (let i = cy * fw + x0, e = cy * fw + x1; i < e; i++) {
            const f = F[i];
            if (f <= 0) {
              G[i] = 0;
              continue;
            }
            G[i] = f > 0.01 ? Math.min(1, G[i] / f) : 1;
            F[i] = f >= COMP_MAX ? 1 : ct[(f * scale) | 0];
          }
        }
      }
    }
  }

  private present(): void {
    this.prepare();
    if (this.gl) this.presentGl();
    else if (this.cpu && this.cpuImg) this.presentCpu();
  }

  private presentGl(): void {
    const gl = this.gl!;
    const F = this.field;
    const G = this.gloss;
    const B = this.bytes;
    const fw = this.fw;
    const tx = this.tx;
    for (let y = 0; y < this.ty; y++) {
      for (let x = 0; x < tx; x++) {
        if (!this.shade[y * tx + x]) continue;
        const x0 = x * TILE;
        const x1 = Math.min(fw, x0 + TILE);
        const y1 = Math.min(this.fh, y * TILE + TILE);
        for (let cy = y * TILE; cy < y1; cy++) {
          for (let i = cy * fw + x0, e = cy * fw + x1; i < e; i++) {
            B[i * 2] = F[i] * 255;
            B[i * 2 + 1] = G[i] * 255;
          }
        }
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, this.glTex);
    if (this.texW !== this.fw || this.texH !== this.fh) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE_ALPHA, this.fw, this.fh, 0, gl.LUMINANCE_ALPHA, gl.UNSIGNED_BYTE, B);
      this.texW = this.fw;
      this.texH = this.fh;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.fw, this.fh, gl.LUMINANCE_ALPHA, gl.UNSIGNED_BYTE, B);
    }
    const c = this.canvas!;
    gl.viewport(0, 0, c.width, c.height);
    gl.uniform2f(this.glU.uTexel, 1 / this.fw, 1 / this.fh);
    gl.uniform2f(this.glU.uScale, (this.W * FS) / this.fw, (this.H * FS) / this.fh);
    gl.uniform2f(this.glU.uShadow, (2.5 * FS) / this.fw, (3.5 * FS) / this.fh);
    gl.uniform1f(this.glU.uOpacity, this.outOpacity());
    gl.uniform1f(this.glU.uDark, this.dark);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * CPU twin of the fragment shader, inside the tiles that need it. Lighting is
   * worked out once per field cell (normal from ±1-cell differences, colour,
   * gloss, highlights); each CSS pixel then thresholds its own bilinear height,
   * so edges are crisp at full resolution, and blends the lit colour of the four
   * cells around it.
   */
  private presentCpu(): void {
    this.findChanged();
    this.lightCells();
    this.shadePixels();
    this.putTiles();
  }

  /**
   * Most of the liquid is still at any moment (the meniscus, the pool, trails slowly drying),
   * so only tiles whose field moved since they were last shaded are shaded again, with their
   * neighbours (the normals and the drop shadow reach a few cells across a tile edge). The
   * rest keep their pixels.
   */
  private findChanged(): void {
    const tx = this.tx;
    const ty = this.ty;
    const F = this.field;
    const G = this.gloss;
    const RH = this.refH;
    const RG = this.refG;
    const fw = this.fw;
    const op = this.outOpacity();
    const all = this.shadeAll || op !== this.lastOp || this.dark !== this.lastDark;
    this.shadeAll = false;
    this.lastOp = op;
    this.lastDark = this.dark;
    const chg = this.needLit; // scratch: changed tiles
    chg.fill(0);
    for (let y = 0; y < ty; y++) {
      for (let x = 0; x < tx; x++) {
        const t = y * tx + x;
        if (!this.shade[t]) continue;
        if (all) {
          chg[t] = 1;
          continue;
        }
        const x0 = x * TILE;
        const x1 = Math.min(fw, x0 + TILE);
        const y1 = Math.min(this.fh, y * TILE + TILE);
        scan: for (let cy = y * TILE; cy < y1; cy++) {
          for (let i = cy * fw + x0, e = cy * fw + x1; i < e; i++) {
            const dh = F[i] - RH[i];
            const dg = G[i] - RG[i];
            if (dh > EPS_H || dh < -EPS_H || dg > EPS_G || dg < -EPS_G) {
              chg[t] = 1;
              break scan;
            }
          }
        }
      }
    }
    // Shade the changed tiles and their neighbours; light one ring further (shading reads lit cells across the edge).
    const need = this.need;
    need.fill(0);
    for (let y = 0; y < ty; y++) {
      for (let x = 0; x < tx; x++) {
        if (!chg[y * tx + x]) continue;
        for (let yy = Math.max(0, y - 1); yy <= Math.min(ty - 1, y + 1); yy++) {
          for (let xx = Math.max(0, x - 1); xx <= Math.min(tx - 1, x + 1); xx++) need[yy * tx + xx] = 1;
        }
      }
    }
    const lit = this.needLit;
    lit.fill(0);
    for (let y = 0; y < ty; y++) {
      for (let x = 0; x < tx; x++) {
        if (!need[y * tx + x]) continue;
        for (let yy = Math.max(0, y - 1); yy <= Math.min(ty - 1, y + 1); yy++) {
          for (let xx = Math.max(0, x - 1); xx <= Math.min(tx - 1, x + 1); xx++) lit[yy * tx + xx] = 1;
        }
      }
    }
  }

  /** Lit colour of every cell with liquid in a live tile, packed RGBA (premultiplied by body alpha). */
  private lightCells(): void {
    const Hc = this.field;
    const Gl = this.gloss;
    const L = this.lit;
    const fw = this.fw;
    const fh = this.fh;
    const tx = this.tx;
    const P = this.palette();
    const thin0 = P[0], thin1 = P[1], thin2 = P[2];
    const thk0 = P[3], thk1 = P[4], thk2 = P[5];
    const edg0 = P[6], edg1 = P[7], edg2 = P[8];
    const dry0 = P[9], dry1 = P[10], dry2 = P[11];
    const glw0 = P[12], glw1 = P[13], glw2 = P[14];
    const rim0 = P[15], rim1 = P[16], rim2 = P[17];
    const rimK = P[18];
    const Bp = LOOK.bump;
    const sT = specTab!;
    const fT = fillTab!;
    const tThick = thickTab!;
    const tGlow = glowTab!;
    const tEdge = edgeTab!;
    const Hx = HALF[0], Hy = HALF[1], Hz = HALF[2];
    const Fx = FILL[0], Fy = FILL[1], Fz = FILL[2];
    for (let tyi = 0; tyi < this.ty; tyi++) {
      for (let txi = 0; txi < tx; txi++) {
        if (!this.live[tyi * tx + txi] || !this.needLit[tyi * tx + txi]) continue;
        const x0 = txi * TILE;
        const x1 = Math.min(fw, x0 + TILE);
        const y1 = Math.min(fh, tyi * TILE + TILE);
        for (let cy = tyi * TILE; cy < y1; cy++) {
          const row = cy * fw;
          for (let cx = x0; cx < x1; cx++) {
            const ci = row + cx;
            const h = Hc[ci];
            if (h < 0.02) continue;
            // ±1-cell differences, lightly smoothed across (Sobel), like the shader's filtered taps.
            const il = cx > 0 ? ci - 1 : ci;
            const ir = cx < fw - 1 ? ci + 1 : ci;
            const du = cy > 0 ? -fw : 0;
            const dd = cy < fh - 1 ? fw : 0;
            let nx = ((Hc[il] - Hc[ir]) * 2 + Hc[il + du] - Hc[ir + du] + Hc[il + dd] - Hc[ir + dd]) * 0.25 * Bp;
            let ny = ((Hc[ci + du] - Hc[ci + dd]) * 2 + Hc[il + du] - Hc[il + dd] + Hc[ir + du] - Hc[ir + dd]) * 0.25 * Bp;
            const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
            nx *= inv;
            ny *= inv;
            const nz = inv;
            const g = Gl[ci];
            const hi = (h * SPEC_N) | 0;
            const thick = tThick[hi];
            const edgeK = tEdge[(nz * SPEC_N) | 0];
            const edge = 1 - nz;
            const dryK = (1 - g) * 0.75;
            let br = thin0 + (thk0 - thin0) * thick;
            let bg = thin1 + (thk1 - thin1) * thick;
            let bb = thin2 + (thk2 - thin2) * thick;
            br += (edg0 - br) * edgeK;
            bg += (edg1 - bg) * edgeK;
            bb += (edg2 - bb) * edgeK;
            br += (dry0 - br) * dryK;
            bg += (dry1 - bg) * dryK;
            bb += (dry2 - bb) * dryK;
            let glow = (nx * 0.45 + ny * 0.8) * 1.8;
            glow = (glow < 0 ? 0 : glow > 1 ? 1 : glow) * (1 - edgeK) * tGlow[hi] * g;
            br += glw0 * glow;
            bg += glw1 * glow;
            bb += glw2 * glow;
            const a = 0.86 + 0.11 * thick;
            let nh = nx * Hx + ny * Hy + nz * Hz;
            let nf = nx * Fx + ny * Fy + nz * Fz;
            if (nh < 0) nh = 0;
            if (nf < 0) nf = 0;
            const spec = (sT[(nh * SPEC_N) | 0] + fT[(nf * SPEC_N) | 0]) * (0.15 + 0.85 * g);
            const rim = edge * edge * rimK;
            let r = (br * a + spec + rim0 * rim) * 255;
            let gg = (bg * a + 0.94 * spec + rim1 * rim) * 255;
            let b = (bb * a + 0.92 * spec + rim2 * rim) * 255;
            if (r > 255) r = 255;
            if (gg > 255) gg = 255;
            if (b > 255) b = 255;
            L[ci] = (((a * 255) << 24) | (b << 16) | (gg << 8) | r) >>> 0;
          }
        }
      }
    }
  }

  /**
   * Every pixel of the processed tiles: crisp coverage, blended lit colour, soft
   * shadow. Pixels go in 2×2 quads that share the same four field cells (at half
   * resolution each pixel sits a quarter cell from a cell corner), so the cells are
   * read once per quad and blended with fixed weights.
   */
  private shadePixels(): void {
    const out32 = this.out32!;
    const W = this.W;
    const Hh = this.H;
    const tx = this.tx;
    const op = this.outOpacity() * 255;
    const shK = this.palette()[19];
    if (shadowTabK !== shK) {
      for (let i = 0; i <= SPEC_N; i++) shadowTab![i] = smooth(SLO, SHI, i / SPEC_N) * shK;
      shadowTabK = shK;
    }
    const tShadow = shadowTab!;
    const px = TILE / FS;
    for (let tyi = 0; tyi < this.ty; tyi++) {
      for (let txi = 0; txi < tx; txi++) {
        const ti = tyi * tx + txi;
        if (!this.shade[ti] || !this.need[ti]) {
          this.upload[ti] = 0;
          continue;
        }
        const X0 = txi * px;
        const X1 = Math.min(W, X0 + px);
        const Y0 = tyi * px;
        const Y1 = Math.min(Hh, Y0 + px);
        // Only tiles that showed something need clearing, and only those with liquid need shading.
        const was = this.painted[ti];
        if (was) {
          for (let Y = Y0; Y < Y1; Y++) {
            for (let i = Y * W + X0, e = Y * W + X1; i < e; i++) out32[i] = 0;
          }
        }
        let any = 0;
        if (this.live[ti]) any = this.shadeTile(txi, tyi, X0, X1, Y0, Y1, op, tShadow);
        this.painted[ti] = any;
        this.upload[ti] = was | any;
        // Remember what this tile was shaded with.
        const fw = this.fw;
        const cx0 = txi * TILE;
        const cx1 = Math.min(fw, cx0 + TILE);
        const cy1 = Math.min(this.fh, tyi * TILE + TILE);
        const F = this.field;
        const G = this.gloss;
        const RH = this.refH;
        const RG = this.refG;
        for (let cy = tyi * TILE; cy < cy1; cy++) {
          for (let i = cy * fw + cx0, e = cy * fw + cx1; i < e; i++) {
            RH[i] = F[i];
            RG[i] = G[i];
          }
        }
      }
    }
  }

  /** Shade one live tile's pixels (already cleared). Returns 1 if anything was drawn. */
  private shadeTile(txi: number, tyi: number, X0: number, X1: number, Y0: number, Y1: number, op: number, tShadow: Float32Array): number {
    const out32 = this.out32!;
    const Hc = this.field;
    const L = this.lit;
    const fw = this.fw;
    const fh = this.fh;
    const W = this.W;
    const tCov = covTab!;
    const hlo = HLO * 0.9;
    const span = this.span;
    let any = 0;
    let flatL = -1;
    let flatP = 0;
    {
      {
        // Per cell row: the leftmost and rightmost cell with anything in it, near this tile.
        const cx0 = Math.max(0, txi * TILE - 3);
        const cx1 = Math.min(fw - 1, txi * TILE + TILE + 1);
        const cy0 = Math.max(0, tyi * TILE - 3);
        const cy1 = Math.min(fh - 1, tyi * TILE + TILE + 1);
        for (let cy = cy0; cy <= cy1; cy++) {
          let lo = -1;
          let hi = -2;
          const row = cy * fw;
          for (let c = cx0; c <= cx1; c++) {
            if (Hc[row + c] > 0.01) {
              if (lo < 0) lo = c;
              hi = c;
            }
          }
          span[(cy - cy0) * 2] = lo;
          span[(cy - cy0) * 2 + 1] = hi;
        }
        // Quad (n, m) covers pixels X = 2n+1, 2n+2 and Y = 2m+1, 2m+2, between cells n..n+1 and m..m+1.
        for (let m = tyi * TILE - 1; m < tyi * TILE + TILE; m++) {
          const ya = 2 * m + 1;
          if (ya + 1 < Y0 || ya >= Y1) continue;
          // Liquid on the rows this quad row reads (its own two, and the shadow's).
          let lo = 1e9;
          let hi = -1e9;
          for (let rr = m - 2; rr <= m + 1; rr++) {
            if (rr < cy0 || rr > cy1) continue;
            const a = span[(rr - cy0) * 2];
            if (a < 0) continue;
            if (a < lo) lo = a;
            const b = span[(rr - cy0) * 2 + 1];
            if (b > hi) hi = b;
          }
          if (hi < lo) continue;
          const r0 = m < 0 ? 0 : m;
          const r1 = m + 1 > fh - 1 ? fh - 1 : m + 1;
          const sA = m - 2 < 0 ? 0 : m - 2 > fh - 1 ? fh - 1 : m - 2;
          const sB = m - 1 < 0 ? 0 : m - 1 > fh - 1 ? fh - 1 : m - 1;
          const R0 = r0 * fw;
          const R1 = r1 * fw;
          const nA = Math.max(txi * TILE - 1, lo - 1);
          const nB = Math.min(txi * TILE + TILE - 1, hi + 1);
          for (let n = nA; n <= nB; n++) {
            const c0 = n < 0 ? 0 : n;
            const c1 = n + 1 > fw - 1 ? fw - 1 : n + 1;
            const h00 = Hc[R0 + c0];
            const h10 = Hc[R0 + c1];
            const h01 = Hc[R1 + c0];
            const h11 = Hc[R1 + c1];
            // Shadow cells: columns n-1..n, rows m-2..m-1.
            const q0 = n - 1 < 0 ? 0 : n - 1;
            const sa0 = Hc[sA * fw + q0];
            const sa1 = Hc[sA * fw + c0];
            const sb0 = Hc[sB * fw + q0];
            const sb1 = Hc[sB * fw + c0];
            const hMax = Math.max(h00, h10, h01, h11);
            if (hMax < hlo && Math.max(sa0, sa1, sb0, sb1) < SLO) continue;
            // Deep inside a flat body (the meniscus, the pool, a head): one colour for the whole quad.
            const l00 = L[R0 + c0];
            if (l00 === L[R0 + c1] && l00 === L[R1 + c0] && l00 === L[R1 + c1] && Math.min(h00, h10, h01, h11) > HHI + 0.02) {
              if (l00 !== flatL) {
                flatL = l00;
                const a = (l00 >>> 24) / 255;
                const kk = 1 / a;
                flatP = ((((a * op) << 24) | (Math.min(255, ((l00 >>> 16) & 255) * kk) << 16) | (Math.min(255, ((l00 >>> 8) & 255) * kk) << 8) | Math.min(255, (l00 & 255) * kk)) >>> 0);
              }
              for (let dy = 0; dy < 2; dy++) {
                const Y = ya + dy;
                if (Y < Y0 || Y >= Y1) continue;
                for (let dx = 0; dx < 2; dx++) {
                  const X = 2 * n + 1 + dx;
                  if (X >= X0 && X < X1) out32[Y * W + X] = flatP;
                }
              }
              any = 1;
              continue;
            }
            let lit = false;
            // The four lit colours, unpacked once (only cells with liquid were lit this frame).
            let r00 = 0, g00 = 0, b00 = 0, a00 = 0, r10 = 0, g10 = 0, b10 = 0, a10 = 0;
            let r01 = 0, g01 = 0, b01 = 0, a01 = 0, r11 = 0, g11 = 0, b11 = 0, a11 = 0;
            if (hMax >= hlo) {
              if (h00 >= 0.02) {
                r00 = l00 & 255;
                g00 = (l00 >>> 8) & 255;
                b00 = (l00 >>> 16) & 255;
                a00 = l00 >>> 24;
              }
              const l10 = L[R0 + c1];
              if (h10 >= 0.02) {
                r10 = l10 & 255;
                g10 = (l10 >>> 8) & 255;
                b10 = (l10 >>> 16) & 255;
                a10 = l10 >>> 24;
              }
              const l01 = L[R1 + c0];
              if (h01 >= 0.02) {
                r01 = l01 & 255;
                g01 = (l01 >>> 8) & 255;
                b01 = (l01 >>> 16) & 255;
                a01 = l01 >>> 24;
              }
              const l11 = L[R1 + c1];
              if (h11 >= 0.02) {
                r11 = l11 & 255;
                g11 = (l11 >>> 8) & 255;
                b11 = (l11 >>> 16) & 255;
                a11 = l11 >>> 24;
              }
              lit = true;
            }
            if (lit && Math.min(h00, h10, h01, h11) > HHI + 0.02) {
              // Fully covered (and too opaque for the shadow to show): fixed-weight blends only.
              for (let q = 0; q < 4; q++) {
                const Y = ya + (q >> 1);
                const X = 2 * n + 1 + (q & 1);
                if (Y < Y0 || Y >= Y1 || X < X0 || X >= X1) continue;
                const wx = q & 1 ? 0.75 : 0.25;
                const wy = q & 2 ? 0.75 : 0.25;
                const w00 = (1 - wx) * (1 - wy);
                const w10 = wx * (1 - wy);
                const w01 = (1 - wx) * wy;
                const w11 = wx * wy;
                let a = (a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11) * (1 / 255);
                const cr = (r00 * w00 + r10 * w10 + r01 * w01 + r11 * w11) * (1 / 255);
                const cg = (g00 * w00 + g10 * w10 + g01 * w01 + g11 * w11) * (1 / 255);
                const cb = (b00 * w00 + b10 * w10 + b01 * w01 + b11 * w11) * (1 / 255);
                if (cr > a) a = cr;
                if (cg > a) a = cg;
                if (cb > a) a = cb;
                if (a > 1) a = 1;
                const kk = 255 / a;
                out32[Y * W + X] = (((a * op) << 24) | ((cb * kk) << 16) | ((cg * kk) << 8) | (cr * kk)) >>> 0;
              }
              any = 1;
              continue;
            }
            const v00 = h00 >= 0.02 ? 1 : 0;
            const v10 = h10 >= 0.02 ? 1 : 0;
            const v01 = h01 >= 0.02 ? 1 : 0;
            const v11 = h11 >= 0.02 ? 1 : 0;
            for (let dy = 0; dy < 2; dy++) {
              const Y = ya + dy;
              if (Y < Y0 || Y >= Y1) continue;
              const wy = dy === 0 ? 0.25 : 0.75;
              // Shadow row: Y = 2m+1 → rows m-2/m-1 halfway; Y = 2m+2 → row m-1.
              const sl0 = dy === 0 ? (sa0 + sb0) * 0.5 : sb0;
              const sl1 = dy === 0 ? (sa1 + sb1) * 0.5 : sb1;
              const rowBase = Y * W;
              for (let dx = 0; dx < 2; dx++) {
                const X = 2 * n + 1 + dx;
                if (X < X0 || X >= X1) continue;
                const wx = dx === 0 ? 0.25 : 0.75;
                // Shadow column: X = 2n+1 → column n-1; X = 2n+2 → halfway to n.
                const hs = dx === 0 ? sl0 : (sl0 + sl1) * 0.5;
                const shadow = tShadow[(hs * SPEC_N) | 0];
                const hTop = h00 + (h10 - h00) * wx;
                const h = hTop + (h01 + (h11 - h01) * wx - hTop) * wy;
                if (!lit || h < hlo) {
                  if (shadow > 0.002) {
                    out32[rowBase + X] = ((shadow * op) << 24) >>> 0;
                    any = 1;
                  }
                  continue;
                }
                const w00 = v00 * (1 - wx) * (1 - wy);
                const w10 = v10 * wx * (1 - wy);
                const w01 = v01 * (1 - wx) * wy;
                const w11 = v11 * wx * wy;
                const ws = w00 + w10 + w01 + w11;
                if (ws <= 0) continue;
                const k = tCov[(h * SPEC_N) | 0] / (ws * 255);
                const cr = (r00 * w00 + r10 * w10 + r01 * w01 + r11 * w11) * k;
                const cg = (g00 * w00 + g10 * w10 + g01 * w01 + g11 * w11) * k;
                const cb = (b00 * w00 + b10 * w10 + b01 * w01 + b11 * w11) * k;
                let a = (a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11) * k;
                a += shadow * (1 - a);
                if (cr > a) a = cr;
                if (cg > a) a = cg;
                if (cb > a) a = cb;
                if (a > 1) a = 1;
                if (a <= 0.002) continue;
                // ImageData is straight alpha (and little-endian RGBA in a Uint32).
                const kk = 255 / a;
                out32[rowBase + X] = (((a * op) << 24) | ((cb * kk) << 16) | ((cg * kk) << 8) | (cr * kk)) >>> 0;
                any = 1;
              }
            }
          }
        }
      }
    }
    return any;
  }

  /** The look's colours mixed for this page's darkness (cached). */
  private palette(): Float32Array {
    if (this.paletteDark !== this.dark) {
      const dk = this.dark;
      let o = 0;
      for (const c of ['thin', 'thick', 'edge', 'dry', 'glow', 'rim'] as const) {
        for (let i = 0; i < 3; i++) this.pal[o++] = LOOK[c][0][i] + (LOOK[c][1][i] - LOOK[c][0][i]) * dk;
      }
      this.pal[o++] = LOOK.rimK[0] + (LOOK.rimK[1] - LOOK.rimK[0]) * dk;
      this.pal[o++] = LOOK.shadowK[0] + (LOOK.shadowK[1] - LOOK.shadowK[0]) * dk;
      this.paletteDark = dk;
    }
    return this.pal;
  }

  /** Upload the processed tiles: vertical runs per tile column, merged across equal neighbours. */
  private putTiles(): void {
    const ctx = this.cpu!;
    const img = this.cpuImg!;
    const tx = this.tx;
    const ty = this.ty;
    const R = this.rects;
    let n = 0;
    let open = 0; // rects [open, n) may still grow to the right
    for (let c = 0; c < tx; c++) {
      const startOfColumn = n;
      let r = 0;
      while (r < ty) {
        if (!this.upload[r * tx + c]) {
          r++;
          continue;
        }
        const r0 = r;
        while (r < ty && this.upload[r * tx + c]) r++;
        let merged = false;
        for (let i = open; i < startOfColumn; i++) {
          if (R[i * 4 + 1] === c && R[i * 4 + 2] === r0 && R[i * 4 + 3] === r) {
            R[i * 4 + 1] = c + 1;
            merged = true;
            break;
          }
        }
        if (!merged) {
          R[n * 4] = c;
          R[n * 4 + 1] = c + 1;
          R[n * 4 + 2] = r0;
          R[n * 4 + 3] = r;
          n++;
        }
      }
      // Rects that did not reach this column are closed: move them out of the open range.
      let w = open;
      for (let i = open; i < n; i++) {
        if (R[i * 4 + 1] === c + 1) continue;
        if (i !== w) for (let q = 0; q < 4; q++) {
          const s = R[w * 4 + q];
          R[w * 4 + q] = R[i * 4 + q];
          R[i * 4 + q] = s;
        }
        w++;
      }
      open = w;
    }
    const px = TILE / FS;
    for (let i = 0; i < n; i++) {
      const x = R[i * 4] * px;
      const y = R[i * 4 + 2] * px;
      const w = Math.min(this.W, R[i * 4 + 1] * px) - x;
      const h = Math.min(this.H, R[i * 4 + 3] * px) - y;
      if (w > 0 && h > 0) ctx.putImageData(img, 0, 0, x, y, w, h);
    }
  }

  private outOpacity(): number {
    const o = this.opacity;
    let a = o * o * (3 - 2 * o);
    // Gentle scrolling dims it a little; a wipe fades it out while it streaks away.
    a *= 0.45 + 0.55 * this.wet;
    if (this.wiping) a *= 1 - smooth(0.1, this.reduced ? 1.3 : WIPE_S * 0.95, this.wipeT);
    return a;
  }
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

/** 0 on a light page, 1 on a dark one, as it shows on screen. */
function pageDarkness(): number {
  const d = pageDarknessRaw();
  return rootInverted() ? 1 - d : d;
}

/** 0 on a light page, 1 on a dark one, from the page's own background colour. */
function pageDarknessRaw(): number {
  try {
    // Let the browser parse the colour (computed styles may be oklch(), lab(), color()...):
    // paint it into a 1x1 canvas and read it back.
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return 0;
    const read = (value: string): number | null => {
      g.clearRect(0, 0, 1, 1);
      g.fillStyle = 'rgba(0, 0, 0, 0)';
      g.fillStyle = value;
      g.fillRect(0, 0, 1, 1);
      const px = g.getImageData(0, 0, 1, 1).data;
      if (px[3] < 128) return null; // transparent: unknown, keep looking
      return (0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]) / 255;
    };
    // What shows behind the liquid: look near both edges (where it mostly runs) and
    // the middle, walking up from the element there to the first opaque background.
    const behind = (x: number, y: number): number | null => {
      for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) {
        const lum = read(getComputedStyle(el).backgroundColor);
        if (lum !== null) return lum;
      }
      return null;
    };
    let sum = 0;
    let n = 0;
    for (const x of [16, innerWidth / 2, innerWidth - 24]) {
      const lum = behind(x, innerHeight * 0.6);
      if (lum !== null) {
        sum += lum;
        n++;
      }
    }
    if (!n) {
      for (const el of [document.body, document.documentElement]) {
        const lum = el ? read(getComputedStyle(el).backgroundColor) : null;
        if (lum !== null) {
          sum = lum;
          n = 1;
          break;
        }
      }
    }
    if (n) return smooth(0.55, 0.25, sum / n);
    // Transparent all the way down: the canvas follows the colour scheme.
    const scheme = getComputedStyle(document.documentElement).colorScheme;
    if (/dark/.test(scheme) && !/light/.test(scheme)) return 1;
  } catch {
    /* ignore */
  }
  return 0;
}
