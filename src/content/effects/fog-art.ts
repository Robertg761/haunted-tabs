// Procedural art for the fog effect: value noise, the pre-rendered fog texture
// (haze, grain, droplets, frost, rime), a water-bead sprite, and the shapes of
// the things that press into the glass from the other side. Everything here is
// drawn once, up front, in small steps; the per-frame work lives in fog.ts.

export type Rand = () => number;
export type RGB = readonly [number, number, number];

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// Each octave is rotated, so the lattice of the value noise never lines up into blocks.
const ROT_C = Math.cos(0.83);
const ROT_S = Math.sin(0.83);

/** Smooth 2D value noise in [0, 1], seeded. */
export class Noise {
  private readonly p = new Uint8Array(512);
  private readonly v = new Float32Array(256);

  constructor(rand: Rand) {
    const perm = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    for (let i = 0; i < 512; i++) this.p[i] = perm[i & 255];
    for (let i = 0; i < 256; i++) this.v[i] = rand();
  }

  at(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const u = fade(x - xi);
    const w = fade(y - yi);
    const X = xi & 255;
    const Y = yi & 255;
    const p = this.p;
    const v = this.v;
    const a = p[X] + Y;
    const b = p[X + 1] + Y;
    return lerp(lerp(v[p[a]], v[p[b]], u), lerp(v[p[a + 1]], v[p[b + 1]], u), w);
  }

  /** Fractal sum of `oct` rotated octaves, normalised to roughly [0, 1]. */
  fbm(x: number, y: number, oct: number): number {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += this.at(x + i * 17.3, y - i * 9.1) * amp;
      norm += amp;
      amp *= 0.5;
      const nx = (x * ROT_C - y * ROT_S) * 2.03;
      y = (x * ROT_S + y * ROT_C) * 2.03;
      x = nx;
    }
    return sum / norm;
  }
}

/**
 * Evaluate `f` on a coarse lattice (every `step` samples) and fill a w*h field by
 * bilinear interpolation. Smooth noise costs a fraction of evaluating it everywhere.
 */
export function coarseField(w: number, h: number, step: number, f: (x: number, y: number) => number): Float32Array {
  const cw = Math.ceil((w - 1) / step) + 2;
  const ch = Math.ceil((h - 1) / step) + 2;
  const c = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) c[y * cw + x] = f(x * step, y * step);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = y / step;
    const y0 = gy | 0;
    const fy = gy - y0;
    const r0 = y0 * cw;
    const r1 = r0 + cw;
    for (let x = 0; x < w; x++) {
      const gx = x / step;
      const x0 = gx | 0;
      const fx = gx - x0;
      const a = c[r0 + x0] + (c[r0 + x0 + 1] - c[r0 + x0]) * fx;
      const b = c[r1 + x0] + (c[r1 + x0 + 1] - c[r1 + x0]) * fx;
      out[y * w + x] = a + (b - a) * fy;
    }
  }
  return out;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** A bead of water on glass, lit from the top left. Readable on light and dark pages. */
export function dropSprite(): HTMLCanvasElement {
  const s = 64;
  const c = makeCanvas(s, s);
  const g = c.getContext('2d')!;
  const r = s / 2 - 3;
  const m = s / 2;
  // The bead lenses the page: a faint body and a dark refraction rim, heaviest at the bottom right.
  const body = g.createRadialGradient(m - r * 0.22, m - r * 0.28, r * 0.1, m, m, r);
  body.addColorStop(0, 'rgba(255,255,255,0.14)');
  body.addColorStop(0.58, 'rgba(235,242,248,0.05)');
  body.addColorStop(0.82, 'rgba(14,22,32,0.42)');
  body.addColorStop(0.94, 'rgba(14,22,32,0.22)');
  body.addColorStop(1, 'rgba(14,22,32,0)');
  g.fillStyle = body;
  g.beginPath();
  g.arc(m, m, r, 0, Math.PI * 2);
  g.fill();
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(10,18,28,0.32)';
  g.lineWidth = r * 0.14;
  g.beginPath();
  g.arc(m, m, r * 0.86, -Math.PI * 0.1, Math.PI * 0.62);
  g.stroke();
  // Light refracted through the drop gathers on the far side, as a soft crescent.
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.lineWidth = r * 0.15;
  g.beginPath();
  g.arc(m, m, r * 0.62, Math.PI * 0.2, Math.PI * 0.78);
  g.stroke();
  // The specular glint.
  const hx = m - r * 0.36;
  const hy = m - r * 0.4;
  const glint = g.createRadialGradient(hx, hy, 0, hx, hy, r * 0.32);
  glint.addColorStop(0, 'rgba(255,255,255,0.95)');
  glint.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  glint.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = glint;
  g.beginPath();
  g.arc(hx, hy, r * 0.32, 0, Math.PI * 2);
  g.fill();
  return c;
}

export interface Palette {
  dark: boolean;
  lo: RGB;
  hi: RGB;
}

export interface TextureOptions {
  w: number;
  h: number;
  stage: number;
  rand: Rand;
  noise: Noise;
  palette: Palette;
  sprite: HTMLCanvasElement;
}

/**
 * The look of fully fogged glass over the whole viewport, at CSS pixel size: milky
 * haze, fine grain, condensation dots and droplets (more of them near the frame),
 * a band of rime right at the frame and ice crystals growing in from it. Returned as
 * a list of steps so the caller can spread the work over several tasks.
 */
export function fogTextureJob(o: TextureOptions): { canvas: HTMLCanvasElement; steps: (() => void)[] } {
  const { w, h, rand, noise, palette } = o;
  const tex = makeCanvas(w, h);
  const g = tex.getContext('2d')!;
  const flush = makeCanvas(1, 1).getContext('2d')!;
  const dark = palette.dark;

  // Where droplets and frost gather: towards the frame, most of all in the corners.
  const edgeness = (x: number, y: number) => {
    const ex = Math.min(x, w - x) / (w * 0.5);
    const ey = Math.min(y, h - y) / (h * 0.5);
    return clamp01(1 - Math.min(ex, ey) * 1.25) ** 1.4;
  };

  // Soft haze from two scales of noise; on dark pages the big shapes stay faint so it never reads as smoke.
  const q = 4;
  const lw = Math.ceil(w / q) + 1;
  const lh = Math.ceil(h / q) + 1;
  let big: Float32Array | null = null;
  let fineN: Float32Array | null = null;
  const hazeBig = () => {
    big = coarseField(lw, lh, 6, (x, y) => noise.fbm((x * q) / 260, (y * q) / 260, 4));
  };
  const hazeFine = () => {
    fineN = coarseField(lw, lh, 3, (x, y) => noise.fbm((x * q) / 46 + 40, (y * q) / 46 - 30, 3));
  };
  let small: HTMLCanvasElement | null = null;
  let img: ImageData | null = null;
  const hazeRows = (from: number, to: number) => () => {
    const B = big!;
    const F = fineN!;
    if (!small) {
      small = makeCanvas(lw, lh);
      img = small.getContext('2d')!.createImageData(lw, lh);
    }
    const d = img!.data;
    const [lr, lg, lb] = palette.lo;
    const [hr, hg, hb] = palette.hi;
    const bigW = dark ? 0.22 : 0.55;
    const y1 = Math.min(lh, Math.round(lh * to));
    for (let y = Math.round(lh * from), i = y * lw; y < y1; y++) {
      for (let x = 0; x < lw; x++, i++) {
        const px = x * q;
        const py = y * q;
        const edge = Math.max(0, Math.min(px, w - px, py, h - py));
        const rime = edge > 120 ? 0 : Math.exp(-edge / (16 + 40 * B[i]));
        const shade = clamp01(bigW * B[i] + (1 - bigW) * F[i] + (dark ? 0.3 : 0.12) * rime - 0.06);
        const k = i * 4;
        d[k] = lerp(lr, hr, shade);
        d[k + 1] = lerp(lg, hg, shade);
        d[k + 2] = lerp(lb, hb, shade);
        d[k + 3] = 255 * clamp01((dark ? 0.8 + 0.14 * F[i] : 0.72 + 0.28 * F[i]) + 0.25 * rime);
      }
    }
  };
  // Upscale in horizontal bands (clipped, so no seams) to keep each step short.
  const band = (from: number, to: number, paint: () => void) => () => {
    g.save();
    g.beginPath();
    g.rect(0, Math.floor(h * from), w, Math.ceil(h * (to - from)) + 1);
    g.clip();
    paint();
    g.restore();
  };
  const hazePaint = () => {
    if (img) {
      small!.getContext('2d')!.putImageData(img, 0, 0);
      img = null;
    }
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'medium';
    g.drawImage(small!, 0, 0, lw * q, lh * q);
  };
  const hazeDone = () => {
    small!.width = small!.height = 0;
    small = null;
    big = fineN = null;
  };

  // The micro-droplets that make fog look like fog, too small to see one by one.
  let pattern: CanvasPattern | null = null;
  const grainPaint = () => {
    if (!pattern) {
      const size = 256;
      const tile = makeCanvas(size, size);
      const tg = tile.getContext('2d')!;
      const timg = tg.createImageData(size, size);
      const td = timg.data;
      for (let i = 0; i < td.length; i += 4) {
        const v = rand();
        const light = v > 0.5;
        td[i] = td[i + 1] = td[i + 2] = light ? 255 : 30;
        td[i + 3] = light ? (v - 0.5) * 2 * 62 : (0.5 - v) * 2 * 30;
      }
      tg.putImageData(timg, 0, 0);
      pattern = g.createPattern(tile, 'repeat');
    }
    if (!pattern) return;
    g.fillStyle = pattern;
    g.globalAlpha = 0.66;
    g.fillRect(0, 0, w, h);
    g.globalAlpha = 1;
  };

  const fine = Math.round((w * h) / 190);
  const dotsLight = () => {
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.beginPath();
    for (let i = 0; i < fine; i++) {
      const x = rand() * w;
      const y = rand() * h;
      if (rand() > 0.35 + 0.65 * edgeness(x, y)) continue;
      const s = 0.6 + rand() * rand() * 1.4;
      g.rect(x, y, s, s);
    }
    g.fill();
  };
  const dotsDark = () => {
    g.fillStyle = dark ? 'rgba(10,14,20,0.22)' : 'rgba(60,72,88,0.2)';
    g.beginPath();
    for (let i = 0; i < fine * 0.5; i++) {
      const x = rand() * w;
      const y = rand() * h;
      if (rand() > 0.3 + 0.7 * edgeness(x, y)) continue;
      g.rect(x, y, 0.9, 0.9);
    }
    g.fill();
  };

  const drops = () => {
    // Droplets big enough to catch the light.
    const n = Math.round((w * h) / 1500);
    for (let i = 0; i < n; i++) {
      const x = rand() * w;
      const y = rand() * h;
      const e = edgeness(x, y);
      if (rand() > 0.05 + 0.95 * e) continue;
      const r = 0.9 + rand() ** 3 * (2.6 + 2.2 * e);
      g.globalAlpha = 0.55 + 0.45 * rand();
      g.drawImage(o.sprite, x - r, y - r, r * 2, r * 2);
    }
    g.globalAlpha = 1;
  };

  return {
    canvas: tex,
    // Canvas drawing is deferred; a one-pixel copy after each step makes it rasterise inside that step.
    steps: [
      hazeBig, hazeFine, hazeRows(0, 0.5), hazeRows(0.5, 1),
      band(0, 0.34, hazePaint), band(0.34, 0.67, hazePaint), band(0.67, 1, hazePaint), hazeDone,
      band(0, 0.5, grainPaint), band(0.5, 1, grainPaint), dotsLight, dotsDark, drops,
      ...rimeSteps(g, w, h, noise, rand), ...frostSteps(g, w, h, o.stage, rand, dark),
    ].map((step) => () => {
      step();
      flush.drawImage(tex, 0, 0, 1, 1, 0, 0, 1, 1);
    }),
  };
}

/** Frost right at the frame: thresholded fine noise, a crust that breaks up a few pixels in. */
function rimeSteps(g: CanvasRenderingContext2D, w: number, h: number, noise: Noise, rand: Rand): (() => void)[] {
  const band = 11;
  const P = 128;
  let tile: Float32Array | null = null;
  // Fine, seamlessly tiling noise: two octaves of value noise on wrapping lattices.
  const fine = (): Float32Array => {
    if (tile) return tile;
    const lat = (n: number) => Float32Array.from({ length: n * n }, () => rand());
    const l1 = lat(64);
    const l2 = lat(32);
    const sample = (l: Float32Array, n: number, x: number, y: number) => {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const fx = x - xi;
      const fy = y - yi;
      const u = fx * fx * (3 - 2 * fx);
      const v = fy * fy * (3 - 2 * fy);
      const x0 = xi % n;
      const y0 = yi % n;
      const x1 = (x0 + 1) % n;
      const y1 = (y0 + 1) % n;
      const a = l[y0 * n + x0] + (l[y0 * n + x1] - l[y0 * n + x0]) * u;
      const b = l[y1 * n + x0] + (l[y1 * n + x1] - l[y1 * n + x0]) * u;
      return a + (b - a) * v;
    };
    tile = new Float32Array(P * P);
    for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) tile[y * P + x] = sample(l1, 64, x / 2, y / 2) * 0.55 + sample(l2, 32, x / 4, y / 4) * 0.45;
    return tile;
  };
  const strip = (sw: number, sh: number, horizontal: boolean, far: boolean, ox: number, oy: number) => () => {
    const t = fine();
    const len = horizontal ? sw : sh;
    // How far the crust reaches varies slowly along the edge.
    const reach = coarseField(len, 1, 8, (s) => noise.at((horizontal ? s + ox : ox * 3) / 37 - 20, (horizontal ? oy * 3 : s + oy) / 37 + 9));
    const c = makeCanvas(sw, sh);
    const cg = c.getContext('2d')!;
    const img = cg.createImageData(sw, sh);
    const d = img.data;
    for (let y = 0, k = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++, k += 4) {
        const across = horizontal ? y : x;
        const e = (far ? band - 1 - across : across) / band;
        const gx = ox + x;
        const gy = oy + y;
        const v = t[(gy & (P - 1)) * P + (gx & (P - 1))];
        const th = 0.36 + (0.62 * e) / (0.5 + 0.9 * reach[horizontal ? x : y]);
        const a = smoothstep(th, th + 0.16, v) * (1 - e * 0.5);
        if (a <= 0) continue;
        d[k] = d[k + 1] = d[k + 2] = 250;
        d[k + 3] = a * 170;
      }
    }
    cg.putImageData(img, 0, 0);
    g.drawImage(c, ox, oy);
    c.width = c.height = 0;
  };
  return [
    strip(w, band, true, false, 0, 0),
    strip(w, band, true, true, 0, h - band),
    strip(band, h, false, false, 0, 0),
    strip(band, h, false, true, w - band, 0),
  ];
}

/**
 * Ice crystals: short dendrites from the frame with six-fold, 60-degree symmetry,
 * every arm fringed with small side branches that fade towards their tips. Dense
 * clusters along the frame, larger stars in the corners.
 */
function frostSteps(g: CanvasRenderingContext2D, w: number, h: number, stage: number, rand: Rand, dark: boolean): (() => void)[] {
  // Paths by [depth][fade]: three widths, three opacities along each branch.
  const paths: Path2D[][] = [0, 1, 2].map(() => [new Path2D(), new Path2D(), new Path2D()]);
  const HEX = Math.PI / 3;
  const base = 14 + stage * 6;
  const corner = Math.min(220, Math.min(w, h) * 0.3);

  const arm = (x: number, y: number, ang: number, len: number, depth: number) => {
    const step = depth === 2 ? 3.2 : 2.3;
    const steps = Math.max(2, Math.round(len / step));
    let side = rand() < 0.5 ? 1 : -1;
    let px = x;
    let py = y;
    // One polyline per third of the arm (each third a little fainter), not a subpath per segment.
    let bin = -1;
    let p = paths[depth][0];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      ang += (rand() - 0.5) * 0.06;
      const nx = px + Math.cos(ang) * step;
      const ny = py + Math.sin(ang) * step;
      const b = Math.min(2, Math.floor(t * 3));
      if (b !== bin) {
        bin = b;
        p = paths[depth][b];
        p.moveTo(px, py);
      }
      p.lineTo(nx, ny);
      px = nx;
      py = ny;
      if (depth > 0 && t > 0.1 && t < 0.94 && rand() < 0.68) {
        const sub = len * (depth === 2 ? 0.42 : 0.5) * Math.pow(1 - t, 0.8) * (0.7 + rand() * 0.4);
        if (sub >= 2.2) {
          arm(px, py, ang + side * HEX, sub, depth - 1);
          if (rand() < 0.45) arm(px, py, ang - side * HEX, sub * (0.75 + rand() * 0.25), depth - 1);
          side = -side;
          p.moveTo(px, py);
        }
      }
    }
  };
  /** A crystal: one to three arms 60 degrees apart, like part of a snowflake. */
  const crystal = (x: number, y: number, ang: number, len: number) => {
    arm(x, y, ang, len, 2);
    if (rand() < 0.4) arm(x, y, ang + HEX * (rand() < 0.5 ? 1 : -1), len * (0.55 + rand() * 0.3), 2);
    if (rand() < 0.15) arm(x, y, ang + HEX * 2 * (rand() < 0.5 ? 1 : -1), len * 0.5, 1);
  };

  const edges: [number, number, number, number, number][] = [
    // x0, y0, dx, dy (along the edge), inward angle
    [0, 0, 1, 0, Math.PI / 2],
    [0, h, 1, 0, -Math.PI / 2],
    [0, 0, 0, 1, 0],
    [w, 0, 0, 1, Math.PI],
  ];
  const edgeStep = ([x0, y0, dx, dy, inward]: [number, number, number, number, number]) => () => {
    const length = dx ? w : h;
    let s = rand() * 8;
    while (s < length) {
      const near = clamp01(1 - Math.min(s, length - s) / corner);
      s += 5 + rand() * 13 * (1 - near * 0.6);
      if (rand() > 0.5 + 0.5 * near) continue;
      // Crystals grow from the frame and a few pixels in, on the hexagonal lattice of the ice.
      const inset = rand() * rand() * 10;
      const x = x0 + dx * s + Math.cos(inward) * inset;
      const y = y0 + dy * s + Math.sin(inward) * inset;
      const ang = inward + (Math.round((rand() - 0.5) * 2) * HEX) / 2 + (rand() - 0.5) * 0.3;
      crystal(x, y, ang, base * (0.5 + rand() * 0.6) * (1 + near * 0.9));
    }
  };
  // Larger stars clustered into each corner.
  const corners = () => {
  for (const [cx, cy, a] of [
    [0, 0, Math.PI / 4],
    [w, 0, (3 * Math.PI) / 4],
    [0, h, -Math.PI / 4],
    [w, h, (-3 * Math.PI) / 4],
  ] as const) {
    const n = 10 + Math.floor(rand() * 8);
    for (let i = 0; i < n; i++) {
      const r = corner * 0.45 * rand() * rand();
      const t = a + (rand() - 0.5) * 1.5;
      const x = cx + Math.cos(t) * r;
      const y = cy + Math.sin(t) * r;
      const ang = Math.floor(rand() * 6) * HEX + a * 0.3;
      for (let k = 0; k < 3; k++) arm(x, y, ang + k * 2 * HEX, base * (0.9 + rand() * 0.9) * (1 - r / corner), 2);
    }
  }
  };

  const widths = [0.6, 0.8, 1.0];
  const fades = [1, 0.66, 0.36];
  // A faint dark edge under the white, so the crystals read on white pages (not needed on dark ones).
  const shadow = (d: number) => () => {
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // Thin and offset like an etched shadow: strokes over 1 px wide are far slower to rasterise.
    g.strokeStyle = 'rgba(60,76,96,0.26)';
    g.lineWidth = 1;
    g.save();
    g.translate(0.7, 0.9);
    for (let f = 0; f < 2; f++) g.stroke(paths[d][f]);
    g.restore();
  };
  const ice = (d: number) => () => {
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = widths[d];
    for (let f = 0; f < 3; f++) {
      g.strokeStyle = `rgba(255,255,255,${((dark ? 0.6 : 0.85) * fades[f] * (0.78 + d * 0.11)).toFixed(3)})`;
      g.stroke(paths[d][f]);
    }
  };
  return [...edges.map(edgeStep), corners, ...(dark ? [] : [shadow(0), shadow(1), shadow(2)]), ice(0), ice(1), ice(2)];
}

// --- things pressed into the glass from the other side ---------------------

export interface Grid {
  cols: number;
  rows: number;
  cell: number;
}

/**
 * A shape cleared in the fog over time: `S` is how strongly each cell is cleared,
 * `D` when (seconds) its press begins. Beads and drips are [x, y, t, size] tuples
 * in CSS pixels, sorted by time.
 */
export interface Imprint {
  x0: number;
  y0: number;
  w: number;
  h: number;
  S: Float32Array;
  D: Float32Array;
  maxD: number;
  press: number;
  beads: number[];
  drips: number[];
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

function newImprint(grid: Grid, left: number, top: number, right: number, bottom: number): Imprint {
  const x0 = Math.max(0, Math.floor(left / grid.cell));
  const y0 = Math.max(0, Math.floor(top / grid.cell));
  const x1 = Math.min(grid.cols - 1, Math.ceil(right / grid.cell));
  const y1 = Math.min(grid.rows - 1, Math.ceil(bottom / grid.cell));
  const w = Math.max(1, x1 - x0 + 1);
  const h = Math.max(1, y1 - y0 + 1);
  const D = new Float32Array(w * h).fill(1e9);
  return {
    x0, y0, w, h, S: new Float32Array(w * h), D, maxD: 0, press: 0.2, beads: [], drips: [],
    cx: (left + right) / 2, cy: (top + bottom) / 2, rx: (right - left) / 2, ry: (bottom - top) / 2,
  };
}

function sortTuples(list: number[], stride: number): number[] {
  const rows: number[][] = [];
  for (let i = 0; i < list.length; i += stride) rows.push(list.slice(i, i + stride));
  rows.sort((a, b) => a[2] - b[2]);
  return rows.flat();
}

// Letters as finger strokes on a 0..1 tall grid, the way you would trace them.
const GLYPHS: Record<string, { w: number; strokes: number[][] }> = {
  L: { w: 0.5, strokes: [[0, 0, 0, 1, 0.5, 1]] },
  E: { w: 0.52, strokes: [[0.52, 0, 0, 0, 0, 1, 0.52, 1], [0, 0.5, 0.42, 0.5]] },
  A: { w: 0.62, strokes: [[0, 1, 0.31, 0, 0.62, 1], [0.13, 0.62, 0.49, 0.62]] },
  V: { w: 0.62, strokes: [[0, 0, 0.31, 1, 0.62, 0]] },
  H: { w: 0.56, strokes: [[0, 0, 0, 1], [0.56, 0, 0.56, 1], [0, 0.5, 0.56, 0.5]] },
  R: { w: 0.56, strokes: [[0, 1, 0, 0, 0.36, 0, 0.5, 0.08, 0.55, 0.24, 0.5, 0.4, 0.36, 0.49, 0, 0.49], [0.28, 0.49, 0.58, 1]] },
};

/** A word traced by an unseen finger, stroke by stroke, centred on (cx, cy). */
export function buildWord(word: string, cx: number, cy: number, size: number, grid: Grid, rand: Rand): Imprint {
  const gap = 0.3;
  let total = 0;
  for (const ch of word) total += (GLYPHS[ch]?.w ?? 0.5) + gap;
  total -= gap;
  const slant = 0.12 + rand() * 0.08;
  const r = Math.max(grid.cell * 1.6, size * 0.1);
  const left = cx - (total * size) / 2;
  const top = cy - size / 2;
  const imp = newImprint(grid, left - r * 2 - size * slant, top - r * 2, left + total * size + r * 2, top + size + r * 2);
  imp.press = 0.16;
  const speed = size * 4.6;
  const jit = () => (rand() - 0.5) * 0.06;
  let t = 0;
  let pen = 0;
  const cell = grid.cell;
  for (const ch of word) {
    const glyph = GLYPHS[ch];
    if (!glyph) continue;
    const s = 0.94 + rand() * 0.12;
    const lift = (rand() - 0.5) * 0.08;
    for (const stroke of glyph.strokes) {
      const pts: number[] = [];
      for (let i = 0; i < stroke.length; i += 2) {
        const gy = stroke[i + 1] * s + lift + jit();
        const gx = stroke[i] * s + jit();
        pts.push(left + (pen + gx + (1 - gy) * slant) * size, top + gy * size);
      }
      for (let i = 0; i + 2 < pts.length; i += 2) {
        const ax = pts[i];
        const ay = pts[i + 1];
        const bx = pts[i + 2];
        const by = pts[i + 3];
        const len = Math.hypot(bx - ax, by - ay);
        const n = Math.max(1, Math.ceil(len / (cell * 0.5)));
        const nx = -(by - ay) / (len || 1);
        const ny = (bx - ax) / (len || 1);
        for (let k = 0; k <= n; k++) {
          const f = k / n;
          const x = ax + (bx - ax) * f;
          const y = ay + (by - ay) * f;
          const at = t + (len * f) / speed;
          stampDisc(imp, grid, x, y, r, at);
          if (rand() < 0.07) {
            const side = rand() < 0.5 ? 1 : -1;
            imp.beads.push(x + nx * side * r * 1.05, y + ny * side * r * 1.05, at + 0.1, 0.7 + rand() * 1.4);
          }
        }
        t += len / speed;
      }
      // Water gathers at the bottom of a stroke and runs.
      for (let i = 1; i < stroke.length; i += 2) {
        if (stroke[i] < 0.95 || rand() > 0.55) continue;
        const px = pts[i - 1];
        const py = pts[i];
        imp.drips.push(px + (rand() - 0.5) * r * 0.6, py + r * 0.7, t + 0.3 + rand() * 0.8, 1.6 + rand() * 0.9);
      }
      t += 0.16 + rand() * 0.1;
    }
    pen += glyph.w + gap;
    t += 0.14;
  }
  imp.maxD = t;
  imp.beads = sortTuples(imp.beads, 4);
  imp.drips = sortTuples(imp.drips, 4);
  return imp;
}

function stampDisc(imp: Imprint, grid: Grid, x: number, y: number, r: number, at: number): void {
  const c = grid.cell;
  const gx0 = Math.max(imp.x0, Math.floor((x - r) / c));
  const gx1 = Math.min(imp.x0 + imp.w - 1, Math.ceil((x + r) / c));
  const gy0 = Math.max(imp.y0, Math.floor((y - r) / c));
  const gy1 = Math.min(imp.y0 + imp.h - 1, Math.ceil((y + r) / c));
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const dist = Math.hypot((gx + 0.5) * c - x, (gy + 0.5) * c - y);
      const s = 1 - smoothstep(r * 0.5, r, dist);
      if (s <= 0.02) continue;
      const i = (gy - imp.y0) * imp.w + (gx - imp.x0);
      if (s > imp.S[i]) imp.S[i] = s;
      if (at < imp.D[i]) imp.D[i] = at;
    }
  }
}


/** Distance from (px, py) to a polyline [x0, y0, x1, y1, ...]: [distance, t along it 0..1, side -1/+1]. */
function polyDist(px: number, py: number, pts: number[], out: number[]): void {
  let best = 1e9;
  let bt = 0;
  let side = 1;
  const n = pts.length / 2 - 1;
  for (let i = 0; i < n; i++) {
    const ax = pts[i * 2];
    const ay = pts[i * 2 + 1];
    const dx = pts[i * 2 + 2] - ax;
    const dy = pts[i * 2 + 3] - ay;
    const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
    const ex = px - ax - dx * t;
    const ey = py - ay - dy * t;
    const d = ex * ex + ey * ey;
    if (d < best) {
      best = d;
      bt = (i + t) / n;
      side = dx * ey - dy * ex > 0 ? 1 : -1;
    }
  }
  out[0] = Math.sqrt(best);
  out[1] = bt;
  out[2] = side;
}

interface Finger {
  pts: number[];
  r0: number;
  r1: number;
  len: number;
  creases: number[]; // t, partial offset
}

/**
 * A hand pressed flat against the other side of the glass: the heel of the palm
 * first, then the fingers roll on from base to tip. Contact is patchy like real
 * skin: fingertip pads clearest, a noisy hollow in the palm that barely touches,
 * thin partial creases at the knuckles, and fine beads squeezed out inside.
 */
export function buildHand(cx: number, cy: number, size: number, grid: Grid, rand: Rand, noise: Noise): Imprint {
  const mirror = rand() < 0.5 ? -1 : 1;
  const ang = (rand() - 0.5) * 0.4;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const reach = size * 0.62;
  const imp = newImprint(grid, cx - reach, cy - reach, cx + reach, cy + reach);
  imp.press = 1.3;
  const edge = (grid.cell * 0.75) / size;
  const toHand = (x: number, y: number): [number, number] => {
    const dx = (x - cx) / size;
    const dy = (y - cy) / size;
    return [(dx * cos + dy * sin) * mirror, -dx * sin + dy * cos];
  };
  const toPage = (hx: number, hy: number): [number, number] => {
    const x = hx * mirror;
    return [cx + (x * cos - hy * sin) * size, cy + (x * sin + hy * cos) * size];
  };

  // Fingers: base, direction (radians from straight up), length, base and tip radius, curl.
  const spread = 0.85 + rand() * 0.3;
  const defs: [number, number, number, number, number, number, number][] = [
    [-0.13, -0.07, -0.19, 0.355, 0.043, 0.033, 0.05],
    [-0.04, -0.09, -0.04, 0.41, 0.045, 0.035, 0.015],
    [0.052, -0.085, 0.11, 0.38, 0.043, 0.033, -0.03],
    [0.138, -0.045, 0.27, 0.285, 0.036, 0.028, -0.06],
    [-0.185, 0.11, -0.98, 0.27, 0.05, 0.04, 0.09],
  ];
  const fingers: Finger[] = defs.map(([bx, by, dir, len, r0, r1, curl], i) => {
    const a = dir * (i === 4 ? 1 : spread) + (rand() - 0.5) * 0.08;
    const L = len * (0.94 + rand() * 0.1);
    const ux = Math.sin(a);
    const uy = -Math.cos(a);
    const bend = curl + (rand() - 0.5) * 0.03;
    const pts: number[] = [];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6;
      const off = bend * L * Math.sin(Math.PI * t * 0.9);
      pts.push(bx + ux * L * t - uy * off, by + uy * L * t + ux * off);
    }
    const creases = i === 4 ? [0.5, rand() - 0.5] : [0.44 + rand() * 0.04, rand() - 0.5, 0.71 + rand() * 0.04, rand() - 0.5];
    return { pts, r0, r1, len: L, creases };
  });

  const tmp = [0, 0, 0];
  for (let gy = 0; gy < imp.h; gy++) {
    for (let gx = 0; gx < imp.w; gx++) {
      const px = (imp.x0 + gx + 0.5) * grid.cell;
      const py = (imp.y0 + gy + 0.5) * grid.cell;
      const [hx, hy] = toHand(px, py);
      if (hx * hx + hy * hy > 0.42) continue;
      let best = 0;
      let when = 1e9;
      // Palm: one broad pad, wider under the knuckles, tapering to a rounded heel.
      const half = 0.212 - 0.045 * clamp01((hy + 0.09) / 0.39);
      const rr = 0.115;
      const qx = Math.abs(hx) - (half - rr);
      const qy = Math.abs(hy - 0.105) - (0.2 - rr);
      const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr;
      const palm = 1 - smoothstep(-edge, edge, sd);
      if (palm > 0) {
        // Pressure: heel and the pads under the knuckles press hardest; the hollow barely touches.
        const heel = Math.exp(-(((hx + 0.07) / 0.1) ** 2 + ((hy - 0.22) / 0.08) ** 2)) + Math.exp(-(((hx - 0.09) / 0.08) ** 2 + ((hy - 0.21) / 0.08) ** 2));
        const pads = Math.exp(-(((hy + 0.045) / 0.045) ** 2));
        const hr = 0.075 * (0.75 + 0.5 * noise.fbm(px / 18, py / 18, 2));
        const hollow = Math.exp(-((hx + 0.01) ** 2 + (hy - 0.07) ** 2) / (hr * hr));
        const pressure = clamp01(0.52 + 0.45 * Math.min(1, heel) + 0.2 * pads - 0.6 * hollow);
        best = palm * pressure;
        when = 0.9 * clamp01(Math.hypot(hx, hy - 0.24) / 0.34);
      }
      for (const f of fingers) {
        polyDist(hx, hy, f.pts, tmp);
        const t = tmp[1];
        const r = f.r0 + (f.r1 - f.r0) * t;
        const s = 1 - smoothstep(r - edge, r + edge, tmp[0]);
        if (s <= 0) continue;
        // Fingertip pads press hardest; creases are thin, partial lines of lighter contact.
        let p = 0.66 + 0.34 * smoothstep(0.6, 0.86, t);
        const across = (tmp[0] / r) * tmp[2];
        for (let c = 0; c < f.creases.length; c += 2) {
          const dt = ((t - f.creases[c]) * f.len) / 0.016;
          const part = smoothstep(-0.5, 0.2, across * (f.creases[c + 1] > 0 ? 1 : -1) + f.creases[c + 1]);
          p -= 0.5 * Math.exp(-dt * dt) * part;
        }
        const v = s * p;
        if (v > best) best = v;
        when = Math.min(when, 0.7 + t * 1.1);
      }
      if (best <= 0.02) continue;
      // Skin: fine, patchy contact.
      const skin = noise.fbm(px / 6.5 + 31, py / 6.5 - 17, 2);
      best *= smoothstep(0.12, 0.55, 0.62 * best + 0.55 * skin - 0.08);
      if (best <= 0.02) continue;
      const i = gy * imp.w + gx;
      imp.S[i] = Math.min(1, best);
      imp.D[i] = when + rand() * 0.12;
    }
  }
  imp.maxD = 1.9;
  // Water squeezed out along the outline of the fingers.
  for (const f of fingers) {
    for (let k = 0; k < 6; k++) {
      const t = 0.15 + rand() * 0.85;
      const i = Math.min(5, Math.floor(t * 6));
      const ft = t * 6 - i;
      const ax = f.pts[i * 2];
      const ay = f.pts[i * 2 + 1];
      const bx = f.pts[i * 2 + 2];
      const by = f.pts[i * 2 + 3];
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const side = rand() < 0.5 ? 1 : -1;
      const r = f.r0 + (f.r1 - f.r0) * t + 0.012;
      const [x, y] = toPage(ax + (bx - ax) * ft - ((by - ay) / len) * r * side, ay + (by - ay) * ft + ((bx - ax) / len) * r * side);
      imp.beads.push(x, y, 0.7 + t * 1.1 + imp.press * 0.6, 0.6 + rand() * 1.3);
    }
  }
  // Fine beads stippled inside the contact, where the skin pressed water aside.
  for (let k = 0, tries = 0; k < 46 && tries < 400; tries++) {
    const j = Math.floor(rand() * imp.S.length);
    if (imp.S[j] < 0.55) continue;
    const x = (imp.x0 + (j % imp.w) + rand()) * grid.cell;
    const y = (imp.y0 + Math.floor(j / imp.w) + rand()) * grid.cell;
    imp.beads.push(x, y, imp.D[j] + imp.press * 0.8, 0.4 + rand() * 0.6);
    k++;
  }
  // A small drip running from the heel of the hand.
  const drips = 1 + (rand() < 0.4 ? 1 : 0);
  for (let k = 0; k < drips; k++) {
    const [x, y] = toPage((rand() - 0.5) * 0.22, 0.3);
    imp.drips.push(x, y, 2.4 + rand() * 1.5, 1.0 + rand() * 0.4);
  }
  imp.beads = sortTuples(imp.beads, 4);
  imp.drips = sortTuples(imp.drips, 4);
  return imp;
}
