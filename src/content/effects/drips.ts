// Drips: the entombed tab bleeds.
//
// A dark, glossy liquid gathers along the top of the window as a wavy meniscus,
// swells into beads and runs down in fits and starts, leaving trails that thin
// and dry, and collects in a shallow pool along the bottom that ripples when a
// drop lands. Scrolling drags and smears it; scroll far or firmly enough and it
// is wiped away for good, and the effect removes itself.
//
// How it is drawn: every frame the liquid is rasterised as a metaball field into
// a small Float32 grid (half the CSS resolution): soft blobs for heads and drops,
// soft ribbons for trails, and ramped bands for the meniscus and the pool. Where
// shapes meet, their fields add up and join organically. A WebGL shader then
// thresholds that field at full resolution and lights it like a liquid (rounded
// height from the field, a sharp specular, a rim light, a red caustic and a faint
// drop shadow). Without WebGL a CPU pass does the same at field resolution.
// Nothing outside our own click-through overlay is touched.

import type { Effect, EffectContext } from './types';
import { createOverlay, seeded, type Overlay } from './overlay';

/** Field cells per CSS pixel. */
const FS = 0.5;
/** Coverage ramp on the field: below LO it is dry glass, above HI it is liquid. */
const LO = 0.2;
const HI = 0.34;
/** Band ramp length in field cells (meniscus and pool edge softness). */
const RAMP = 4.5;
const MAX_DRIPS = 12;
const TRAIL_CAP = 420;
const MAX_DROPS = 16;
const MAX_SPLASH = 40;
const BAND_STEP = 8;
const POOL_STEP = 6;
/** Seconds for a fresh trail to thin to its residue. */
const TRAIL_TAU = 6.5;
const FADE_OUT_S = 1.15;
/** Debug: use WebGL even when it is software-rendered. */
const FORCE_GL = false;

const WAITING = 0;
const GATHERING = 1;
const RUNNING = 2;
const POOLING = 3;
const RESTING = 4;

interface Drip {
  phase: number;
  /** Sim time (s) the bead starts gathering. */
  at: number;
  gather: number;
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

const VERT = `
attribute vec2 aPos;
uniform vec2 uScale;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5) * uScale;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// The look, shared by the shader and its CPU twin (shadeCpu, keep them in step).
// Colours are [light page, dark page]: on dark pages the body is lifted and the
// rim light is stronger so the shape still reads.
const LOOK = {
  bump: 1.4,
  fill: [0.3, 0.6, 1.0],
  half: [-0.5, -0.35, 1.0],
  thin: [
    [0.5, 0.0, 0.03],
    [0.56, 0.03, 0.055],
  ],
  thick: [
    [0.13, 0.0, 0.018],
    [0.21, 0.012, 0.026],
  ],
  edge: [
    [0.03, 0.0, 0.005],
    [0.12, 0.006, 0.014],
  ],
  glow: [
    [0.5, 0.035, 0.055],
    [0.62, 0.07, 0.09],
  ],
  rim: [
    [0.5, 0.1, 0.11],
    [0.62, 0.15, 0.17],
  ],
  rimK: [0.1, 0.55],
  shadowK: [0.17, 0.06],
};
const v3 = (c: number[]) => `vec3(${c.map((x) => x.toFixed(3)).join(', ')})`;
const mixd = (k: keyof typeof LOOK) => {
  const c = LOOK[k] as number[][];
  return `mix(${v3(c[0])}, ${v3(c[1])}, uDark)`;
};

const FRAG = `
precision mediump float;
uniform sampler2D uF;
uniform vec2 uTexel;
uniform vec2 uShadow;
uniform float uOpacity;
uniform float uDark;
varying vec2 vUv;
void main() {
  float f = texture2D(uF, vUv).r;
  float fs = texture2D(uF, vUv - uShadow).r;
  if (f < 0.03 && fs < 0.45) { gl_FragColor = vec4(0.0); return; }
  float cov = smoothstep(${LO.toFixed(2)}, ${HI.toFixed(2)}, f);
  float fl = texture2D(uF, vUv - vec2(uTexel.x * 2.0, 0.0)).r;
  float fr = texture2D(uF, vUv + vec2(uTexel.x * 2.0, 0.0)).r;
  float fu = texture2D(uF, vUv - vec2(0.0, uTexel.y * 2.0)).r;
  float fd = texture2D(uF, vUv + vec2(0.0, uTexel.y * 2.0)).r;
  vec3 n = normalize(vec3((fl - fr) * ${LOOK.bump.toFixed(2)}, (fu - fd) * ${LOOK.bump.toFixed(2)}, 1.0));
  float edge = 1.0 - n.z;
  // Thickness looks at the neighbourhood too, so a bead's rim reads as part of a
  // thick bead while a thin film (whose neighbours are thinner) stays translucent.
  float thick = smoothstep(0.32, 0.92, max(f, 0.85 * max(max(fl, fr), max(fu, fd))));
  float edgeK = smoothstep(0.35, 0.8, edge) * 0.5;
  vec3 body = mix(mix(${mixd('thin')}, ${mixd('thick')}, thick), ${mixd('edge')}, edgeK);
  float glow = clamp(dot(n.xy, vec2(0.45, 0.8)) * 1.8, 0.0, 1.0) * (1.0 - edgeK) * smoothstep(0.35, 0.9, f);
  body += ${mixd('glow')} * glow;
  float a = cov * mix(0.7, 0.97, max(thick, edgeK));
  float nh = max(dot(n, normalize(${v3(LOOK.half)})), 0.0);
  float nf = max(dot(n, normalize(${v3(LOOK.fill)})), 0.0);
  float spec = (pow(nh, 28.0) * 0.9 + pow(nh, 6.0) * 0.05 + pow(nf, 18.0) * 0.16 + smoothstep(0.05, 0.5, -n.y) * 0.08) * cov;
  float rim = edge * edge * cov * mix(${LOOK.rimK[0].toFixed(2)}, ${LOOK.rimK[1].toFixed(2)}, uDark);
  vec3 col = body * a + vec3(1.0, 0.94, 0.92) * spec + ${mixd('rim')} * rim;
  float sh = smoothstep(0.45, 0.95, fs) * (1.0 - a) * mix(${LOOK.shadowK[0].toFixed(2)}, ${LOOK.shadowK[1].toFixed(2)}, uDark);
  a = clamp(max(a + sh, max(col.r, max(col.g, col.b))), 0.0, 1.0);
  gl_FragColor = vec4(col, a) * uOpacity;
}`;

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
  private field = new Float32Array(0);
  private bytes = new Uint8Array(0);
  private colTop = new Float32Array(0);
  private colBot = new Float32Array(0);

  private drips: Drip[] = [];
  private drops: Bit[] = [];
  private splash: Bit[] = [];
  private band = new Float32Array(0);
  private combTop = new Float32Array(0);
  private poolBase = new Float32Array(0);
  private poolU = new Float32Array(0);
  private poolV = new Float32Array(0);
  private combBot = new Float32Array(0);
  private poolShape = new Float32Array(0);

  private rng: () => number = Math.random;
  private seed = 0;
  private reduced = false;
  private dark = 0;
  private t = 0;
  private last = 0;
  private raf = 0;
  private timer: number | undefined;
  private stopping = false;
  private opacity = 0;
  private wet = 1;
  /** What the liquid's field is scaled by: wetness, but while wiped it dissolves more than it shrinks. */
  private fieldK = 1;
  private wetTarget = 1;
  private wipeAccum = 0;
  private recent = 0;
  private wiping = false;
  private sm = 0;
  private bandT = 0;
  private act = 1;
  private endT = 0;
  private lastPoolAdd = -99;
  private stirUntil = 0;
  private pendingScroll = 0;
  private wheelCredit = 0;
  private pointerX = -1e4;
  private pointerY = -1e4;
  private winScrollY = 0;
  private elScroll = new WeakMap<EventTarget, number>();
  private wavePhase = 0;
  private bandPhase = new Float32Array(6);
  private sizeK = 1;
  private S = 1;

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
      if (this.wiping || this.wetTarget < 1) {
        this.wiping = false;
        this.wipeAccum = 0;
        this.wetTarget = 1;
      }
      this.addDrips(Math.min(3, MAX_DRIPS - this.drips.length), this.t + 0.8, 7);
      this.wake();
      return;
    }
    this.reduced = ctx.reduced;
    this.seed = ctx.seed >>> 0;
    this.rng = seeded(this.seed ^ 0x9e3779b9);
    const shape = seeded(this.seed ^ 0x5eed);
    for (let i = 0; i < this.bandPhase.length; i++) this.bandPhase[i] = shape() * Math.PI * 2;
    this.dark = pageDarkness();
    this.overlay = createOverlay(this.name, 'canvas { position: absolute; inset: 0; width: 100%; height: 100%; }');
    if (!this.initGl()) this.initCpu();
    // A fresh run: nothing carries over from an earlier one on this instance.
    this.W = this.H = 0;
    this.poolBase = new Float32Array(0);
    this.measure();
    this.t = 0;
    this.opacity = 0;
    this.wet = this.wetTarget = this.fieldK = 1;
    this.wiping = this.stopping = false;
    this.wipeAccum = this.recent = this.sm = this.pendingScroll = this.wheelCredit = 0;
    this.act = 1;
    this.bandT = 0;
    this.lastPoolAdd = -99;
    this.stirUntil = 0;
    for (let i = 0; i < MAX_DROPS; i++) this.drops.push({ alive: false, x: 0, y: 0, vx: 0, vy: 0, m: 0, age: 0 });
    for (let i = 0; i < MAX_SPLASH; i++) this.splash.push({ alive: false, x: 0, y: 0, vx: 0, vy: 0, m: 0, age: 0 });

    const idleH = ctx.idleMs / 3_600_000;
    let count = 5 + Math.floor(this.rng() * 3) + Math.round(Math.min(1, idleH / 8) * 4) - (this.W < 1000 ? 1 : 0) - (4 - Math.min(4, ctx.stage));
    count = Math.max(5, Math.min(MAX_DRIPS, count));
    this.addDrips(count, 1.3, 17.5);

    this.winScrollY = scrollY;
    addEventListener('wheel', this.onWheel, { passive: true });
    document.addEventListener('scroll', this.onScroll, { passive: true, capture: true });
    addEventListener('pointermove', this.onPointer, { passive: true });
    addEventListener('resize', this.onResize, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibility);
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
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    removeEventListener('wheel', this.onWheel);
    document.removeEventListener('scroll', this.onScroll, { capture: true });
    removeEventListener('pointermove', this.onPointer);
    removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.gl) {
      this.gl.getExtension('WEBGL_lose_context')?.loseContext();
      this.gl = null;
    }
    this.canvas?.removeEventListener('webglcontextlost', this.onContextLost);
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
    if (!gl) return false;
    // Software GL would shade millions of pixels on the CPU: the CPU path is cheaper.
    let renderer = String(gl.getParameter(gl.RENDERER) ?? '');
    if (/^webkit webgl$/i.test(renderer)) {
      // Chrome masks RENDERER; Firefox does not (and warns about the extension).
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      if (info) renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? '');
    }
    if (!FORCE_GL && /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer)) {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return false;
    }
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
    if (!vs || !fs || !prog) return false;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
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
    return true;
  }

  private initCpu(): void {
    const canvas = document.createElement('canvas');
    this.overlay!.layer.appendChild(canvas);
    this.canvas = canvas;
    this.cpu = canvas.getContext('2d');
    this.cpuImg = null;
  }

  /** Viewport size changed (or first run): resize the field and the pool and band arrays. */
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
    this.field = new Float32Array(this.fw * this.fh);
    this.bytes = new Uint8Array(this.fw * this.fh);
    this.colTop = new Float32Array(this.fw);
    this.colBot = new Float32Array(this.fw);

    const shape = seeded(this.seed ^ 0xc0b1);
    const bn = Math.ceil(W / BAND_STEP) + 3;
    this.band = new Float32Array(bn);
    this.combTop = new Float32Array(bn);
    const fingers = (arr: Float32Array, step: number) => {
      // Sparse, soft fingers for smears: a few wide lobes rather than noise.
      const a = shape() * 6.28;
      const b = shape() * 6.28;
      const c = shape() * 6.28;
      for (let i = 0; i < arr.length; i++) {
        const x = i * step;
        const n = 0.5 * Math.sin(x * 0.021 + a) + 0.3 * Math.sin(x * 0.047 + b) + 0.2 * Math.sin(x * 0.093 + c);
        arr[i] = Math.pow(Math.max(0, n), 1.6) * 1.8;
      }
    };
    fingers(this.combTop, BAND_STEP);
    const pn = Math.ceil(W / POOL_STEP) + 3;
    const oldBase = this.poolBase;
    this.poolBase = new Float32Array(pn);
    this.poolU = new Float32Array(pn);
    this.poolV = new Float32Array(pn);
    this.combBot = new Float32Array(pn);
    this.poolShape = new Float32Array(pn);
    const q1 = shape() * 6.28;
    const q2 = shape() * 6.28;
    for (let i = 0; i < pn; i++) {
      const x = i * POOL_STEP;
      this.poolShape[i] = 0.35 + 0.65 * (0.5 + 0.5 * (0.65 * Math.sin(x * 0.011 + q1) + 0.35 * Math.sin(x * 0.033 + q2)));
      if (oldBase.length) this.poolBase[i] = oldBase[Math.min(oldBase.length - 1, Math.round((i * (oldBase.length - 1)) / (pn - 1)))];
    }
    fingers(this.combBot, POOL_STEP);
    if (oldW && (oldW !== W || oldH !== H)) {
      const kx = W / oldW;
      for (const d of this.drips) {
        d.x0 *= kx;
        d.x *= kx;
        d.y = Math.min(d.y, H);
        for (let i = 0; i < d.n; i++) d.trail[i * 4] *= kx;
      }
    }

    const canvas = this.canvas!;
    if (this.gl) {
      const dpr = Math.min(2, devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    } else {
      canvas.width = this.fw;
      canvas.height = this.fh;
      this.cpuImg = this.cpu ? this.cpu.createImageData(this.fw, this.fh) : null;
    }
  }

  /** Plan `count` drips that start gathering between `from` and `from + span` seconds. */
  private addDrips(count: number, from: number, span: number): void {
    if (count <= 0) return;
    const rng = this.rng;
    const xs = this.pickColumns(count);
    for (let i = 0; i < xs.length; i++) {
      const k = this.sizeK;
      const r0 = (9 + rng() * 5) * k;
      const pins: number[] = [];
      const pinK: number[] = [];
      for (let y = 30 + rng() * 60; y < this.H; y += 40 + rng() * 150) {
        pins.push(y);
        pinK.push(1.2 + rng() * 1.1);
      }
      const feed = (500 + rng() * 1500) * this.S * k * k;
      const at = i === 0 ? from : from + span * Math.pow(xs.length === 1 ? 0 : i / (xs.length - 1), 0.92) + (rng() - 0.5) * 1.4;
      this.drips.push({
        phase: WAITING,
        at: Math.max(from * 0.6, at),
        gather: i === 0 ? 1.6 + rng() * 0.6 : 1.4 + rng() * 1.9,
        x0: xs[i],
        x: xs[i],
        y: 0,
        v: 0,
        m: 0,
        mRelease: Math.PI * r0 * r0,
        rRelease: r0,
        feed,
        feedRate: feed / (2.2 + rng() * 4),
        wobA: 0.8 + rng() * 3.6,
        wobF: 0.006 + rng() * 0.02,
        wobP: rng() * Math.PI * 2,
        pins: new Float32Array(pins),
        pinK: new Float32Array(pinK),
        pinIdx: 0,
        trail: new Float32Array(TRAIL_CAP * 4),
        n: 0,
        lastX: xs[i],
        lastY: 0,
        lastDeposit: -99,
        detach: rng() < 0.65 ? 0.3 + rng() * 0.6 : 0,
        waver: 0,
        bump: 0,
        bumpW: 9 + r0 * 1.5,
        stretch: 0,
        stuck: 0,
      });
    }
    let end = 0;
    for (const d of this.drips) end = Math.max(end, d.at + d.gather);
    this.endT = end + 14;
  }

  /**
   * Where the drips run: mostly near the window edges and in the gutters between
   * blocks of text, so reading is not blocked. One-off layout reads, at start only.
   */
  private pickColumns(count: number): number[] {
    const W = this.W;
    const H = this.H;
    const bin = 32;
    const bins = Math.max(1, Math.ceil(W / bin));
    const dens = new Float32Array(bins);
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const range = document.createRange();
    const rows = 13;
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
        if (x >= r.left - 10 && x <= r.right + 10 && y >= r.top - 14 && y <= r.bottom + 14) return true;
      }
      return false;
    };
    try {
      for (let b = 0; b < bins; b++) {
        const x = Math.min(W - 1, b * bin + bin / 2);
        let hits = 0;
        for (let r = 0; r < rows; r++) {
          const y = H * (0.1 + (0.8 * r) / (rows - 1));
          if (textAt(x, y)) hits++;
          else {
            const el = document.elementFromPoint(x, y);
            if (el && /^(IMG|VIDEO|CANVAS|svg|IFRAME|INPUT|TEXTAREA|BUTTON)$/i.test(el.tagName)) hits += 0.6;
          }
        }
        dens[b] = hits / rows;
      }
    } catch {
      dens.fill(0);
    }
    range.detach();
    // Keep a little clear of text: a bin borrows some density from its neighbours.
    const near = new Float32Array(bins);
    for (let b = 0; b < bins; b++) near[b] = Math.max(dens[b], 0.7 * (dens[b - 1] ?? 0), 0.7 * (dens[b + 1] ?? 0));

    const rng = this.rng;
    const weights: number[] = [];
    let total = 0;
    for (let b = 0; b < bins; b++) {
      const x = b * bin + bin / 2;
      const edge = Math.pow(Math.max(0, 1 - Math.min(x, W - x) / (W * 0.2)), 1.2);
      const w = (0.16 + 1.3 * edge) * Math.pow(Math.max(0, 1 - near[b]), 6) + 0.002;
      weights.push(w);
      total += w;
    }
    const xs: number[] = [];
    const taken = this.drips.map((d) => d.x0);
    const minGap = Math.max(26, Math.min(48, W / 30));
    for (let i = 0; i < count; i++) {
      for (let tries = 0; tries < 30; tries++) {
        let pick = rng() * total;
        let b = 0;
        while (b < bins - 1 && pick > weights[b]) pick -= weights[b++];
        const x = Math.min(W - 12, Math.max(12, b * bin + rng() * bin));
        if (taken.every((t) => Math.abs(t - x) >= minGap) || tries === 29) {
          xs.push(x);
          taken.push(x);
          break;
        }
      }
    }
    // Left to right does not matter, but the schedule reads better shuffled.
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [xs[i], xs[j]] = [xs[j], xs[i]];
    }
    return xs;
  }

  // --- events ----------------------------------------------------------------

  private onWheel = (e: WheelEvent) => {
    if (e.ctrlKey) return;
    const unit = e.deltaMode === 1 ? 19 : e.deltaMode === 2 ? this.H : 1;
    const dy = Math.max(-this.H, Math.min(this.H, e.deltaY * unit));
    this.pendingScroll += dy;
    this.wheelCredit += dy;
    this.wake();
  };

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
    let dy = y - prev;
    if (!dy) return;
    // Wheel scrolling was already counted from the wheel event itself.
    if (this.wheelCredit && Math.sign(this.wheelCredit) === Math.sign(dy)) {
      const used = Math.sign(dy) * Math.min(Math.abs(dy), Math.abs(this.wheelCredit));
      this.wheelCredit -= used;
      dy -= used;
    }
    if (!dy) return;
    this.pendingScroll += dy;
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
    this.measure();
    this.texW = this.texH = 0;
    this.wake();
  };

  private onVisibility = () => {
    if (document.visibilityState === 'visible') this.wake();
    else if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
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
    this.measure();
    this.wake();
  };

  private wake(): void {
    if (this.raf || !this.overlay || document.visibilityState !== 'visible') return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  // --- simulation ------------------------------------------------------------

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.overlay) return;
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const busy = this.step(dt);
    if (!this.overlay) return; // wiped away or faded out during the step
    this.rasterize();
    this.present();
    if (busy) this.raf = requestAnimationFrame(this.frame);
  };

  /** Advance everything by dt seconds. Returns whether anything is still changing. */
  private step(dt: number): boolean {
    this.t += dt;
    const t = this.t;
    let busy = false;

    // Fades.
    if (this.stopping) {
      this.opacity = Math.max(0, this.opacity - dt / FADE_OUT_S);
      this.wetTarget = Math.min(this.wetTarget, 0.55);
      if (this.opacity <= 0) {
        this.destroy();
        return false;
      }
      busy = true;
    } else if (this.opacity < 1) {
      this.opacity = Math.min(1, this.opacity + dt / 0.9);
      busy = true;
    }

    this.handleScroll(dt);
    const wetEase = 1 - Math.exp(-dt / (this.reduced ? 0.9 : this.wiping ? 0.5 : 0.35));
    this.wet += (this.wetTarget - this.wet) * wetEase;
    if (Math.abs(this.wet - this.wetTarget) > 0.002) busy = true;
    this.fieldK = this.wiping ? 0.4 + 0.6 * this.wet : this.wet;
    if (this.wiping && this.wet < 0.015) {
      this.destroy();
      return false;
    }
    if (Math.abs(this.sm) > 0.05) {
      this.sm *= Math.exp(-dt / 1.1);
      busy = true;
    }

    // Is a drip still doing something?
    let live = false;
    for (const d of this.drips) {
      if (d.phase === RESTING) {
        if (t - d.lastDeposit < TRAIL_TAU * 2) busy = true;
      } else {
        live = true;
        this.stepDrip(d, dt);
      }
      // Mouse nearby: the head trembles, as if breath touched it.
      let target = 0;
      if (t < this.stirUntil && d.phase !== WAITING) {
        const dist = Math.hypot(d.x - this.pointerX, d.y - this.pointerY);
        if (dist < 110) target = Math.sin(t * 7.3 + d.wobP) * 2.4 * (1 - dist / 110);
      }
      d.waver += (target - d.waver) * Math.min(1, dt * 6);
      if (Math.abs(d.waver) > 0.03) busy = true;
    }
    if (t < this.stirUntil) busy = true;
    if (live || t < this.endT) busy = true;

    // Band drift slows to a stop once nothing is flowing.
    this.act += ((live ? 1 : 0) - this.act) * Math.min(1, dt * 0.5);
    this.bandT += dt * this.act;
    if (this.act > 0.01) busy = true;

    if (this.stepBits(dt)) busy = true;
    if (this.stepPool(dt)) busy = true;
    this.computeBand();
    return busy;
  }

  private handleScroll(dt: number): void {
    this.wheelCredit *= Math.exp(-dt / 0.4);
    if (Math.abs(this.wheelCredit) < 1) this.wheelCredit = 0;
    this.recent *= Math.exp(-dt / 0.35);
    const s = this.pendingScroll;
    this.pendingScroll = 0;
    if (!s || this.stopping) return;
    const mag = Math.abs(s);
    this.recent += mag;
    this.wipeAccum += mag;
    if (this.recent > Math.max(320, this.H * 0.5) || this.wipeAccum > this.H * 1.3) {
      this.wiping = true;
      this.wetTarget = 0;
    } else if (!this.wiping) {
      this.wetTarget = Math.min(this.wetTarget, Math.max(0.12, 1 - this.wipeAccum / (this.H * 1.3)));
    }
    if (this.reduced) return; // gentle fade only

    // The liquid is dragged along with the content (which moves opposite to the scroll).
    const g = Math.max(-60, Math.min(60, -s * 0.32));
    this.sm = Math.max(-this.H * 0.35, Math.min(this.H * 0.35, this.sm + g * 0.8));
    for (let k = 0; k < this.drips.length; k++) {
      const d = this.drips[k];
      if (d.phase === WAITING) continue;
      const kick = g * (0.65 + 0.35 * hash(k + 1));
      d.y = Math.max(this.bandDepthAt(d.x) * 0.6, d.y + kick);
      d.x += g * 0.04 * (hash(k + 7) - 0.5);
      if (d.phase === RUNNING && kick > 0) d.v = Math.max(d.v, kick / Math.max(dt, 1 / 60) * 0.15);
      // The trail stretches smoothly towards the head, so it smears instead of breaking up.
      for (let i = 1; i < d.n; i++) d.trail[i * 4 + 1] += kick * 0.85 * (i / d.n) * (i / d.n);
      this.deposit(d, true);
    }
    for (const b of this.drops) if (b.alive) b.y += g;
    // The pool sloshes, and a firm shove throws a few drops up.
    const amp = Math.min(22, mag * 0.12) * Math.sign(s);
    this.wavePhase += 1.7;
    for (let j = 0; j < this.poolV.length; j++) this.poolV[j] += amp * (0.55 + 0.45 * Math.sin(j * 0.07 + this.wavePhase)) * this.poolShape[j];
    const throws = Math.min(5, Math.floor(mag / 70));
    for (let i = 0; i < throws; i++) {
      const x = this.rng() * this.W;
      if (this.poolAt(x) < 3) continue;
      this.spawnSplash(x, this.H - this.poolAt(x), (this.rng() - 0.5) * 160 * this.S, -(160 + this.rng() * 260) * this.S, 1.6 + this.rng() * 2);
    }
  }

  private stepDrip(d: Drip, dt: number): void {
    const t = this.t;
    if (d.phase === WAITING) {
      // The meniscus already sags a little where a drip is about to form.
      d.bump = d.rRelease * 0.3 * smooth(d.at - 4, d.at, t);
      if (t >= d.at) {
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
    d.m += fin;
    const k = this.sizeK;
    let mc = Math.PI * 7.8 * 7.8 * k * k;
    while (d.pinIdx < d.pins.length && d.y > d.pins[d.pinIdx] + 9) d.pinIdx++;
    if (d.pinIdx < d.pins.length && d.y > d.pins[d.pinIdx] - 3) mc *= d.pinK[d.pinIdx];
    const ex = d.m - mc;
    const vmax = (this.reduced ? 34 : 150) * this.S;
    const vt = ex > 0 ? vmax * Math.pow(Math.min(1, ex / (mc * 0.9)), 1.4) : 0;
    const rate = vt > d.v ? 1.7 : 7;
    d.v += (vt - d.v) * (1 - Math.exp(-dt * rate));
    // Where surface tension held the head for a while, a little bead stays behind.
    if (d.v < 4) d.stuck += dt;
    else {
      if (d.stuck > 0.7) this.pushTrail(d, d.x, d.y - rv * 0.15, Math.min(7 * k, rv * 0.72));
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
    if (!this.reduced && d.detach && d.v > vmax * 0.55 && d.m > mc * 1.5 && this.rng() < d.detach * dt) {
      const md = d.m * (0.38 + this.rng() * 0.12);
      if (this.spawnDrop(d.x, d.y + rv * 0.6, d.v * 1.15, md)) d.m -= md;
    }
    if (d.y + rv * 0.6 >= this.H - this.poolAt(d.x)) {
      d.phase = POOLING;
      d.v = 0;
      this.ripple(d.x, 3 * this.S);
    } else if (ex <= 0 && d.v < 0.6 && d.feed < 1) {
      d.phase = RESTING;
      d.lastDeposit = Math.max(d.lastDeposit, t);
    }
  }

  /** Leave trail behind the head every few pixels it travels. */
  private deposit(d: Drip, smear: boolean): void {
    const rv = Math.sqrt(Math.max(0, d.m) / Math.PI);
    const hx = d.x;
    const hy = d.y - rv * 0.2;
    const dist = Math.hypot(hx - d.lastX, hy - d.lastY);
    if (dist < (smear ? 6 : 3.5)) return;
    // Slow heads leave more behind than fast ones; the width wanders a little.
    const speed = Math.min(1, d.v / ((this.reduced ? 34 : 150) * this.S));
    const wob = 0.8 + 0.4 * (0.5 + 0.5 * Math.sin(hy * 0.045 + d.wobP * 3) * Math.sin(hy * 0.017 + d.wobP));
    let r = Math.max(0.8, Math.min(6 * this.sizeK, rv * (0.5 - 0.18 * speed) * wob)) * (smear ? 1.25 : 1);
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
        this.ripple(b.x, (5 + 7 * impact) * this.S);
        const n = 2 + Math.floor(this.rng() * 3 * impact);
        for (let i = 0; i < n; i++) {
          const dir = this.rng() < 0.5 ? -1 : 1;
          this.spawnSplash(b.x + dir * rv * 0.5, surf - 1, dir * (30 + this.rng() * 110) * this.S, -(110 + this.rng() * 230) * this.S * impact, 1.2 + this.rng() * 1.6);
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
        this.ripple(b.x, 1.5 * this.S);
      }
    }
    return busy;
  }

  // --- pool ------------------------------------------------------------------

  private addPool(x: number, area: number): void {
    if (area <= 0) return;
    const base = this.poolBase;
    const j0 = Math.round(x / POOL_STEP) + 1;
    const sigma = 3;
    const amp = (area * 3) / (POOL_STEP * sigma * 2.5066);
    const cap = Math.min(48, Math.max(20, this.H * 0.05));
    for (let k = -9; k <= 9; k++) {
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

  /** Pool height (px above the bottom edge) at x, before wetness. */
  private poolAt(x: number): number {
    const f = x / POOL_STEP + 1;
    const j = Math.max(0, Math.min(this.poolBase.length - 2, Math.floor(f)));
    const a = Math.min(1, Math.max(0, f - j));
    const h0 = this.poolBase[j] + this.poolU[j];
    const h1 = this.poolBase[j + 1] + this.poolU[j + 1];
    return (h0 + (h1 - h0) * a) * this.fieldK;
  }

  private stepPool(dt: number): boolean {
    const base = this.poolBase;
    const u = this.poolU;
    const v = this.poolV;
    const n = base.length;
    let busy = false;
    // Viscous spreading, and a slow seep while the tab is still bleeding.
    const D = 1.1 * dt;
    const seep = this.t < this.endT ? smooth(3, 22, this.t) * 6 * this.S : 0;
    for (let j = 1; j < n - 1; j++) {
      base[j] += D * (base[j - 1] + base[j + 1] - 2 * base[j]);
      const want = seep * this.poolShape[j];
      if (base[j] < want) base[j] += (want - base[j]) * dt * 0.1;
    }
    base[0] = base[1];
    base[n - 1] = base[n - 2];
    if (this.t - this.lastPoolAdd < 6 || seep) busy = true;
    // Ripples: a damped 1D wave.
    const c2 = 560;
    let energy = 0;
    const steps = Math.ceil(dt * 60 - 0.01);
    const h = dt / Math.max(1, steps);
    const damp = Math.exp(-h * 2.6);
    for (let s = 0; s < steps; s++) {
      // Thick liquid: viscosity smooths the velocity field so ripples stay heavy and round.
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
        // Keep the surface from pulling below the glass edge.
        if (base[j] + u[j] < -2) u[j] = -2 - base[j];
      }
      u[0] = u[1];
      u[n - 1] = u[n - 2];
    }
    for (let j = 1; j < n - 1; j++) energy = Math.max(energy, Math.abs(u[j]), Math.abs(v[j]) * 0.1);
    if (energy > 0.02) busy = true;
    else if (energy > 0) {
      u.fill(0);
      v.fill(0);
    }
    return busy;
  }

  // --- meniscus --------------------------------------------------------------

  private computeBand(): void {
    const t = this.t;
    const depthMax = Math.min(30, Math.max(14, this.H * 0.028));
    const grow = smooth(0, 2.6, t);
    const depth = depthMax * grow * (0.35 + 0.65 * grow);
    const p = this.bandPhase;
    const bt = this.bandT;
    const smear = Math.max(0, this.sm);
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
      if (smear) d += smear * (0.15 + 1.6 * this.combTop[i]);
      this.band[i] = d * this.fieldK;
    }
  }

  private bandDepthAt(x: number): number {
    const f = x / BAND_STEP + 1;
    const j = Math.max(0, Math.min(this.band.length - 2, Math.floor(f)));
    const a = Math.min(1, Math.max(0, f - j));
    return this.band[j] + (this.band[j + 1] - this.band[j]) * a;
  }

  // --- field -----------------------------------------------------------------

  /** Rasterise everything into the metaball field. */
  private rasterize(): void {
    const F = this.field;
    F.fill(0);
    const wet = this.fieldK;
    const t = this.t;
    for (const d of this.drips) {
      if (d.phase === WAITING) continue;
      if (d.n > 0) this.trailField(d, wet, t);
      if (d.m > 1) {
        const rv = Math.min(17, Math.sqrt(d.m / Math.PI));
        const x = d.x + d.waver;
        const s = d.stretch;
        this.blob(x, d.y + rv * 0.25 * s, rv * (1 + 0.06 * s), 0.95 * wet);
        // The neck that joins the head to its trail: the head reads as a teardrop.
        this.blob(x, d.y - rv * (0.85 + 0.35 * s), rv * 0.6, 0.7 * wet);
      }
    }
    for (const b of this.drops) {
      if (!b.alive) continue;
      const rv = Math.sqrt(b.m / Math.PI);
      const s = Math.min(1, b.vy / (800 * this.S));
      this.blob(b.x, b.y, rv * (1 - 0.12 * s), 0.95 * wet);
      this.blob(b.x, b.y - rv * (0.8 + 1.4 * s), rv * (0.62 - 0.1 * s), 0.75 * wet);
      this.blob(b.x, b.y - rv * (1.5 + 2.8 * s), rv * 0.34, 0.55 * wet);
    }
    for (const b of this.splash) {
      if (!b.alive) continue;
      this.blob(b.x, b.y, Math.sqrt(b.m / Math.PI), 0.95 * wet);
    }
    this.bandField();
  }

  /** A soft round blob: field = peak·(1 − d²/R²)². */
  private blob(cx: number, cy: number, rv: number, peak: number): void {
    let R = rv * 1.45 * FS;
    let p = peak;
    if (R < 1.6) {
      p *= (R / 1.6) * (R / 1.6);
      R = 1.6;
    }
    const F = this.field;
    const fw = this.fw;
    const fx = cx * FS;
    const fy = cy * FS;
    const x0 = Math.max(0, Math.floor(fx - R));
    const x1 = Math.min(fw - 1, Math.ceil(fx + R));
    const y0 = Math.max(0, Math.floor(fy - R));
    const y1 = Math.min(this.fh - 1, Math.ceil(fy + R));
    const inv = 1 / (R * R);
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - fy;
      const dy2 = dy * dy * inv;
      if (dy2 >= 1) continue;
      const row = y * fw;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - fx;
        const q = dx * dx * inv + dy2;
        if (q < 1) {
          const w = 1 - q;
          F[row + x] += p * w * w;
        }
      }
    }
  }

  /** A drip's trail as a soft ribbon that thins and dries with age. */
  private trailField(d: Drip, wet: number, t: number): void {
    const tr = d.trail;
    const fresh = 0.88 * wet;
    const dry = 0.32 * wet;
    let px = 0;
    let py = 0;
    let pr = 0;
    let pi = 0;
    for (let i = 0; i < d.n; i++) {
      const o = i * 4;
      const age = t - tr[o + 3];
      const r0 = tr[o + 2];
      const res = 0.35 + r0 * 0.3;
      const r = res + (r0 - res) * Math.exp(-age / TRAIL_TAU);
      const inten = dry + (fresh - dry) * Math.exp(-age / (TRAIL_TAU * 1.8));
      const x = tr[o];
      const y = tr[o + 1];
      if (i > 0) this.ribbon(px, py, pr, pi, x, y, r, inten);
      px = x;
      py = y;
      pr = r;
      pi = inten;
    }
    // Live segment from the last trail point to the head.
    if (d.m > 1 && d.phase !== RESTING) {
      const rv = Math.sqrt(d.m / Math.PI);
      this.ribbon(px, py, pr, pi, d.x + d.waver, d.y - rv * 0.2, Math.max(pr, Math.min(6 * this.sizeK, rv * 0.42)), fresh);
    }
  }

  /** One ribbon segment, scanned row by row (rows are half-open, so joints never double up). */
  private ribbon(xa: number, ya: number, ra: number, ia: number, xb: number, yb: number, rb: number, ib: number): void {
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
    }
    const span = fb - fa;
    if (span < 1e-3) return;
    const F = this.field;
    const fw = this.fw;
    const ys = Math.max(0, Math.ceil(fa - 0.5));
    const ye = Math.min(this.fh - 1, Math.ceil(fb - 0.5) - 1);
    for (let y = ys; y <= ye; y++) {
      const k = (y + 0.5 - fa) / span;
      const cx = (xa + (xb - xa) * k) * FS;
      let r = (ra + (rb - ra) * k) * 1.5 * FS;
      let p = ia + (ib - ia) * k;
      if (r < 1.3) {
        p *= r / 1.3;
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
          F[row + x] += p * w * w;
        }
      }
    }
  }

  /** The meniscus along the top and the pool along the bottom, as ramped bands. */
  private bandField(): void {
    const F = this.field;
    const fw = this.fw;
    const fh = this.fh;
    const bottom = this.H * FS;
    const wet = this.fieldK;
    const smearUp = Math.max(0, -this.sm);
    const pool = this.poolBase;
    const pu = this.poolU;
    const comb = this.combBot;
    const top = this.colTop;
    const bot = this.colBot;
    // Edge heights per field column first, so the ramp can follow the slope.
    for (let fx = 0; fx < fw; fx++) {
      const x = (fx + 0.5) / FS;
      top[fx] = this.bandDepthAt(x) * FS;
      const f = x / POOL_STEP + 1;
      const j = Math.min(pool.length - 2, Math.floor(f));
      const a = f - j;
      let P = pool[j] + pu[j] + (pool[j + 1] + pu[j + 1] - pool[j] - pu[j]) * a;
      if (smearUp) P += smearUp * (0.15 + 1.4 * (comb[j] + (comb[j + 1] - comb[j]) * a));
      bot[fx] = P * wet * FS;
    }
    const tail = 0.27;
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
        for (let y = 0; y <= yEnd; y++) {
          const v = tail + (D - (y + 0.5)) / ramp;
          if (v <= 0) break;
          F[y * fw + fx] += (v < tail ? (v * v) / tail : Math.min(1, v)) * wet;
        }
      }
      const P = bot[fx];
      if (P > -RAMP * 0.5) {
        const sl = (bot[r] - bot[l]) / (r - l);
        const ramp = RAMP * Math.sqrt(1 + sl * sl);
        const yStart = Math.max(0, Math.ceil(bottom - P - tail * ramp));
        for (let y = fh - 1; y >= yStart; y--) {
          const v = tail + (P - (bottom - (y + 0.5))) / ramp;
          if (v <= 0) break;
          F[y * fw + fx] += (v < tail ? (v * v) / tail : Math.min(1, v)) * wet;
        }
      }
    }
  }

  // --- output ----------------------------------------------------------------

  private present(): void {
    const F = this.field;
    if (this.gl) {
      const gl = this.gl;
      const B = this.bytes;
      for (let i = 0; i < F.length; i++) {
        const v = F[i];
        B[i] = v >= 1 ? 255 : v <= 0 ? 0 : v * 255;
      }
      gl.bindTexture(gl.TEXTURE_2D, this.glTex);
      if (this.texW !== this.fw || this.texH !== this.fh) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, this.fw, this.fh, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, B);
        this.texW = this.fw;
        this.texH = this.fh;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.fw, this.fh, gl.LUMINANCE, gl.UNSIGNED_BYTE, B);
      }
      const c = this.canvas!;
      gl.viewport(0, 0, c.width, c.height);
      gl.uniform2f(this.glU.uTexel, 1 / this.fw, 1 / this.fh);
      gl.uniform2f(this.glU.uScale, (this.W * FS) / this.fw, (this.H * FS) / this.fh);
      gl.uniform2f(this.glU.uShadow, (2.5 * FS) / this.fw, (3.5 * FS) / this.fh);
      gl.uniform1f(this.glU.uOpacity, this.easedOpacity());
      gl.uniform1f(this.glU.uDark, this.dark);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else if (this.cpu && this.cpuImg) {
      shadeCpu(F, this.cpuImg.data, this.fw, this.fh, this.dark, this.easedOpacity());
      this.cpu.putImageData(this.cpuImg, 0, 0);
    }
  }

  private easedOpacity(): number {
    const o = this.opacity;
    // While being wiped away it also dissolves, rather than only shrinking.
    const w = this.wiping ? smooth(0, 0.6, this.wet) : 1;
    return o * o * (3 - 2 * o) * w;
  }
}

/** CPU twin of the fragment shader, at field resolution. Writes straight RGBA. */
const TAB = 1024;
let specTab: Float32Array | null = null;
let covTab: Float32Array | null = null;
let thickTab: Float32Array | null = null;
let fillTab: Float32Array | null = null;
let palette: Float32Array | null = null;
let paletteDark = -1;
/** Colours mixed for this page's darkness, and the two light directions, flattened. */
function buildPalette(dark: number): Float32Array {
  const out = new Float32Array(23);
  let o = 0;
  for (const k of ['thin', 'thick', 'edge', 'glow', 'rim'] as const) {
    for (let c = 0; c < 3; c++) out[o++] = LOOK[k][0][c] + (LOOK[k][1][c] - LOOK[k][0][c]) * dark;
  }
  out[o++] = LOOK.rimK[0] + (LOOK.rimK[1] - LOOK.rimK[0]) * dark;
  out[o++] = LOOK.shadowK[0] + (LOOK.shadowK[1] - LOOK.shadowK[0]) * dark;
  for (const v of [LOOK.half, LOOK.fill]) {
    const l = Math.hypot(v[0], v[1], v[2]);
    out[o++] = v[0] / l;
    out[o++] = v[1] / l;
    out[o++] = v[2] / l;
  }
  return out;
}
function shadeCpu(F: Float32Array, out: Uint8ClampedArray, w: number, h: number, dark: number, opacity: number): void {
  if (!specTab || !covTab || !thickTab || !fillTab) {
    specTab = new Float32Array(TAB + 1);
    fillTab = new Float32Array(TAB + 1);
    covTab = new Float32Array(TAB + 1);
    thickTab = new Float32Array(TAB + 1);
    for (let i = 0; i <= TAB; i++) {
      const x = i / TAB;
      specTab[i] = Math.pow(x, 28) * 0.9 + Math.pow(x, 6) * 0.05;
      fillTab[i] = Math.pow(x, 18) * 0.16;
      covTab[i] = smooth(LO, HI, x);
      thickTab[i] = smooth(0.32, 0.92, x);
    }
  }
  const sT = specTab;
  const cT = covTab;
  const tT = thickTab;
  const fT = fillTab;
  if (!palette || paletteDark !== dark) {
    palette = buildPalette(dark);
    paletteDark = dark;
  }
  const P = palette;
  const thin0 = P[0], thin1 = P[1], thin2 = P[2];
  const thk0 = P[3], thk1 = P[4], thk2 = P[5];
  const edg0 = P[6], edg1 = P[7], edg2 = P[8];
  const glw0 = P[9], glw1 = P[10], glw2 = P[11];
  const rim0 = P[12], rim1 = P[13], rim2 = P[14];
  const rimK = P[15];
  const shK = P[16];
  const Hx = P[17], Hy = P[18], Hz = P[19];
  const Fx = P[20], Fy = P[21], Fz = P[22];
  const B = LOOK.bump;
  const op = opacity * 255;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const srow = (y - 2) * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const o = i << 2;
      const fraw = F[i];
      const fs = y >= 2 && x >= 1 ? F[srow + x - 1] : 0;
      if (fraw < 0.03 && fs < 0.45) {
        out[o + 3] = 0;
        continue;
      }
      const f = fraw > 1 ? 1 : fraw;
      const fi = (f * TAB) | 0;
      const cov = cT[fi];
      const fl = x > 1 ? Math.min(1, F[i - 2]) : f;
      const fr = x < w - 2 ? Math.min(1, F[i + 2]) : f;
      const fu = y > 1 ? Math.min(1, F[i - 2 * w]) : f;
      const fd = y < h - 2 ? Math.min(1, F[i + 2 * w]) : f;
      let nx = (fl - fr) * B;
      let ny = (fu - fd) * B;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv;
      ny *= inv;
      const nz = inv;
      const edge = 1 - nz;
      const nb = 0.85 * Math.max(fl, fr, fu, fd);
      const thick = tT[((nb > f ? nb : f) * TAB) | 0];
      const edgeK = smooth(0.35, 0.8, edge) * 0.5;
      let glow = (nx * 0.45 + ny * 0.8) * 1.8;
      glow = (glow < 0 ? 0 : glow > 1 ? 1 : glow) * (1 - edgeK) * smooth(0.35, 0.9, f);
      let a = cov * (0.7 + 0.27 * (thick > edgeK ? thick : edgeK));
      const nh = Math.max(0, nx * Hx + ny * Hy + nz * Hz);
      const nf = Math.max(0, nx * Fx + ny * Fy + nz * Fz);
      const spec = (sT[(nh * TAB) | 0] + fT[(nf * TAB) | 0] + smooth(0.05, 0.5, -ny) * 0.08) * cov;
      const rim = edge * edge * cov * rimK;
      const br = thin0 + (thk0 - thin0) * thick;
      const bg = thin1 + (thk1 - thin1) * thick;
      const bb = thin2 + (thk2 - thin2) * thick;
      const cr = (br + (edg0 - br) * edgeK + glw0 * glow) * a + spec + rim0 * rim;
      const cg = (bg + (edg1 - bg) * edgeK + glw1 * glow) * a + 0.94 * spec + rim1 * rim;
      const cb = (bb + (edg2 - bb) * edgeK + glw2 * glow) * a + 0.92 * spec + rim2 * rim;
      const sh = smooth(0.45, 0.95, fs) * (1 - a) * shK;
      a = Math.min(1, Math.max(a + sh, cr, cg, cb));
      if (a <= 0.002) {
        out[o + 3] = 0;
        continue;
      }
      // ImageData is straight alpha.
      const k = 255 / a;
      out[o] = cr * k;
      out[o + 1] = cg * k;
      out[o + 2] = cb * k;
      out[o + 3] = a * op;
    }
  }
}

/** 0 on a light page, 1 on a dark one, from the page's own background colour. */
function pageDarkness(): number {
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
