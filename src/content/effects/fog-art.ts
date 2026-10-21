// Procedural art for the fog effect: value noise, the pre-rendered fog texture
// (haze, grain, droplets, frost), a water-bead sprite, and the shapes of the
// things that press into the glass from the other side. Everything is drawn
// once, up front; the per-frame work lives in fog.ts.

export type Rand = () => number;
export type RGB = readonly [number, number, number];

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

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

  /** Fractal sum of `oct` octaves, normalised to roughly [0, 1]. */
  fbm(x: number, y: number, oct: number): number {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let f = 1;
    for (let i = 0; i < oct; i++) {
      sum += this.at(x * f + i * 17.3, y * f - i * 9.1) * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return sum / norm;
  }
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
  // The bead lenses the page: a faint body with a dark rim, heaviest at the bottom right.
  const body = g.createRadialGradient(m - r * 0.22, m - r * 0.28, r * 0.1, m, m, r);
  body.addColorStop(0, 'rgba(255,255,255,0.16)');
  body.addColorStop(0.62, 'rgba(235,242,248,0.06)');
  body.addColorStop(0.86, 'rgba(18,26,36,0.30)');
  body.addColorStop(1, 'rgba(18,26,36,0)');
  g.fillStyle = body;
  g.beginPath();
  g.arc(m, m, r, 0, Math.PI * 2);
  g.fill();
  // Light refracted through the drop gathers on the far side, as a soft crescent.
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.lineWidth = r * 0.16;
  g.beginPath();
  g.arc(m, m, r * 0.66, Math.PI * 0.18, Math.PI * 0.78);
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
  scale: number;
  stage: number;
  rand: Rand;
  noise: Noise;
  palette: Palette;
  sprite: HTMLCanvasElement;
}

/**
 * The look of fully fogged glass over the whole viewport: milky haze with fractal
 * texture, fine grain, condensation droplets (more of them near the frame) and
 * frost feathers along the edges. Fog.ts masks it by how much fog is where.
 */
export function renderFogTexture(o: TextureOptions): HTMLCanvasElement {
  const { w, h, scale, rand, noise, palette } = o;
  const tex = makeCanvas(w * scale, h * scale);
  const g = tex.getContext('2d')!;
  g.scale(scale, scale);

  // 1. Haze: two scales of fractal noise, whiter and thicker towards the frame.
  const q = 4;
  const lw = Math.ceil(w / q) + 1;
  const lh = Math.ceil(h / q) + 1;
  const small = makeCanvas(lw, lh);
  const sg = small.getContext('2d')!;
  const img = sg.createImageData(lw, lh);
  const d = img.data;
  const [lr, lg, lb] = palette.lo;
  const [hr, hg, hb] = palette.hi;
  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      const px = x * q;
      const py = y * q;
      const big = noise.fbm(px / 260, py / 260, 4);
      const fine = noise.fbm(px / 46 + 40, py / 46 - 30, 3);
      const edge = Math.min(px, w - px, py, h - py);
      const rime = Math.exp(-Math.max(0, edge) / (16 + 40 * big));
      const shade = clamp01(0.62 * big + 0.38 * fine + (palette.dark ? 0.35 : 0.15) * rime - 0.08);
      const i = (y * lw + x) * 4;
      d[i] = lerp(lr, hr, shade);
      d[i + 1] = lerp(lg, hg, shade);
      d[i + 2] = lerp(lb, hb, shade);
      d[i + 3] = 255 * clamp01(0.7 + 0.3 * fine + 0.25 * rime);
    }
  }
  sg.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(small, 0, 0, lw * q, lh * q);

  // 2. Grain: the micro-droplets that make fog look like fog, too small to see one by one.
  const tile = makeCanvas(160, 160);
  const tg = tile.getContext('2d')!;
  const timg = tg.createImageData(160, 160);
  const td = timg.data;
  for (let i = 0; i < td.length; i += 4) {
    const v = rand();
    const light = v > 0.5;
    td[i] = td[i + 1] = td[i + 2] = light ? 255 : 40;
    td[i + 3] = light ? (v - 0.5) * 2 * 70 : (0.5 - v) * 2 * (palette.dark ? 30 : 22);
  }
  tg.putImageData(timg, 0, 0);
  const pattern = g.createPattern(tile, 'repeat');
  if (pattern) {
    g.save();
    g.scale(1 / scale, 1 / scale);
    g.fillStyle = pattern;
    g.globalAlpha = 0.55;
    g.fillRect(0, 0, w * scale, h * scale);
    g.restore();
  }

  // Where droplets and frost gather: towards the frame, most of all in the corners.
  const edgeness = (x: number, y: number) => {
    const ex = Math.min(x, w - x) / (w * 0.5);
    const ey = Math.min(y, h - y) / (h * 0.5);
    return clamp01(1 - Math.min(ex, ey) * 1.25) ** 1.4;
  };

  // 3. Fine condensation dots.
  const fine = Math.round((w * h) / 140);
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
  g.fillStyle = palette.dark ? 'rgba(10,14,20,0.22)' : 'rgba(70,82,96,0.16)';
  g.beginPath();
  for (let i = 0; i < fine * 0.5; i++) {
    const x = rand() * w;
    const y = rand() * h;
    if (rand() > 0.3 + 0.7 * edgeness(x, y)) continue;
    g.rect(x, y, 0.9, 0.9);
  }
  g.fill();

  // 4. Droplets big enough to catch the light.
  const drops = Math.round((w * h) / 1500);
  for (let i = 0; i < drops; i++) {
    const x = rand() * w;
    const y = rand() * h;
    const e = edgeness(x, y);
    if (rand() > 0.12 + 0.88 * e) continue;
    const r = 0.9 + rand() ** 3 * (2.6 + 2.2 * e);
    g.globalAlpha = 0.55 + 0.45 * rand();
    g.drawImage(o.sprite, x - r, y - r, r * 2, r * 2);
  }
  g.globalAlpha = 1;

  // 5. Frost feathers growing in from the frame.
  drawFrost(g, w, h, o.stage, rand, palette.dark);
  return tex;
}

/**
 * Ice crystal feathers: gently curving stems from the frame, fringed with short
 * side branches at about 60 degrees that taper towards the tip, like ferns.
 * Longest and densest in the corners.
 */
function drawFrost(g: CanvasRenderingContext2D, w: number, h: number, stage: number, rand: Rand, dark: boolean): void {
  const stems = new Path2D();
  const fronds = new Path2D();
  const base = 22 + stage * 12;
  const corner = Math.min(240, Math.min(w, h) * 0.32);
  const SPLAY = 1.05; // ~60 degrees

  const feather = (x: number, y: number, ang: number, len: number, depth: number) => {
    const path = depth >= 2 ? stems : fronds;
    const step = depth >= 2 ? 3 : 2;
    const steps = Math.max(2, Math.round(len / step));
    const bend = (rand() - 0.5) * (depth >= 2 ? 0.025 : 0.05);
    path.moveTo(x, y);
    let side = rand() < 0.5 ? 1 : -1;
    for (let i = 1; i <= steps; i++) {
      ang += bend + (rand() - 0.5) * 0.05;
      x += Math.cos(ang) * step;
      y += Math.sin(ang) * step;
      path.lineTo(x, y);
      if (depth === 0) continue;
      const t = i / steps;
      if (t < 0.08 || rand() > (depth >= 2 ? 0.8 : 0.55)) continue;
      // Fronds shorten towards the tip; occasionally both sides grow at once.
      const sub = len * (depth >= 2 ? 0.26 : 0.34) * (1 - t) * (0.6 + rand() * 0.6);
      if (sub < 2.5) continue;
      feather(x, y, ang + side * SPLAY * (0.85 + rand() * 0.3), sub, depth - 1);
      if (rand() < 0.4) feather(x, y, ang - side * SPLAY * (0.85 + rand() * 0.3), sub * 0.85, depth - 1);
      side = -side;
      path.moveTo(x, y);
    }
  };

  const edges: [number, number, number, number, number][] = [
    // x0, y0, dx, dy (along the edge), inward angle
    [0, 0, 1, 0, Math.PI / 2],
    [0, h, 1, 0, -Math.PI / 2],
    [0, 0, 0, 1, 0],
    [w, 0, 0, 1, Math.PI],
  ];
  for (const [x0, y0, dx, dy, inward] of edges) {
    const length = dx ? w : h;
    let s = rand() * 20;
    while (s < length) {
      const near = clamp01(1 - Math.min(s, length - s) / corner);
      s += 14 + rand() * 40 * (1 - near * 0.75);
      if (rand() > 0.35 + 0.65 * near) continue;
      const len = base * (0.4 + rand() * 0.8) * (1 + near * near * 1.8);
      feather(x0 + dx * s, y0 + dy * s, inward + (rand() - 0.5) * 1.3, len, 2);
    }
  }
  // Big feathers fanning out of each corner.
  for (const [cx, cy, a] of [
    [0, 0, Math.PI / 4],
    [w, 0, (3 * Math.PI) / 4],
    [0, h, -Math.PI / 4],
    [w, h, (-3 * Math.PI) / 4],
  ] as const) {
    const n = 3 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) feather(cx, cy, a + (rand() - 0.5) * 1.4, base * (1.8 + rand() * 1.8), 3);
  }

  g.lineCap = 'round';
  g.lineJoin = 'round';
  // A faint dark edge under the white, so the frost reads on white pages as well as dark ones.
  g.strokeStyle = dark ? 'rgba(20,28,38,0.12)' : 'rgba(60,76,96,0.2)';
  g.lineWidth = 1.9;
  g.stroke(stems);
  g.lineWidth = 1.3;
  g.stroke(fronds);
  g.strokeStyle = 'rgba(255,255,255,0.7)';
  g.lineWidth = 0.9;
  g.stroke(stems);
  g.strokeStyle = 'rgba(255,255,255,0.5)';
  g.lineWidth = 0.55;
  g.stroke(fronds);
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

// Fingers as tapered capsules in hand units (1 = wrist to middle fingertip), palm centre at the origin.
const FINGERS: [number, number, number, number, number][] = [
  // base x, base y, tip x, tip y, radius
  [-0.135, -0.07, -0.19, -0.43, 0.043],
  [-0.045, -0.09, -0.055, -0.5, 0.046],
  [0.048, -0.08, 0.08, -0.46, 0.044],
  [0.13, -0.04, 0.2, -0.33, 0.037],
  [-0.19, 0.1, -0.36, -0.08, 0.052],
];

/** A soft elliptical pad, 1 inside and fading to 0 across its rim. */
function lobe(x: number, y: number, cx: number, cy: number, rx: number, ry: number, edge: number): number {
  const q = Math.hypot((x - cx) / rx, (y - cy) / ry);
  const e = edge / Math.min(rx, ry);
  return 1 - smoothstep(1 - e, 1 + e, q);
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): [number, number] {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
  return [Math.hypot(px - ax - dx * t, py - ay - dy * t), t];
}

/** A hand pressed flat against the other side of the glass: heel of the palm first, then the fingers. */
export function buildHand(cx: number, cy: number, size: number, grid: Grid, rand: Rand): Imprint {
  const mirror = rand() < 0.5 ? -1 : 1;
  const ang = (rand() - 0.5) * 0.45;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const reach = size * 0.62;
  const imp = newImprint(grid, cx - reach, cy - reach, cx + reach, cy + reach);
  imp.press = 1.3;
  const edge = (grid.cell * 0.7) / size;
  const toHand = (x: number, y: number): [number, number] => {
    const dx = (x - cx) / size;
    const dy = (y - cy) / size;
    return [(dx * cos + dy * sin) * mirror, -dx * sin + dy * cos];
  };
  const toPage = (hx: number, hy: number): [number, number] => {
    const x = hx * mirror;
    return [cx + (x * cos - hy * sin) * size, cy + (x * sin + hy * cos) * size];
  };
  for (let gy = 0; gy < imp.h; gy++) {
    for (let gx = 0; gx < imp.w; gx++) {
      const [hx, hy] = toHand((imp.x0 + gx + 0.5) * grid.cell, (imp.y0 + gy + 0.5) * grid.cell);
      let best = 0;
      let when = 1e9;
      // Palm: the pad under the knuckles, and the two mounds of the heel, with a
      // hollow in the middle that never quite touches the glass.
      const pads =
        Math.max(
          lobe(hx, hy, 0, 0.02, 0.215, 0.12, edge),
          lobe(hx, hy, -0.085, 0.16, 0.11, 0.135, edge),
          lobe(hx, hy, 0.09, 0.165, 0.1, 0.115, edge),
        );
      if (pads > 0) {
        const hollow = 0.5 * Math.exp(-((hx / 0.09) ** 2 + ((hy - 0.1) / 0.08) ** 2));
        best = pads * (1 - hollow);
        when = 0.9 * clamp01(Math.hypot(hx, hy - 0.24) / 0.34);
      }
      for (const [bx, by, tx, ty, rad] of FINGERS) {
        const [dist, t] = segDist(hx, hy, bx, by, tx, ty);
        const r = rad * (1 - 0.18 * t);
        const s = 1 - smoothstep(r - edge, r + edge, dist);
        if (s <= 0) continue;
        // Creases at the knuckles, and a firmer pad at the tip.
        const crease = 1 - 0.42 * Math.exp(-(((t - 0.42) / 0.03) ** 2)) - 0.34 * Math.exp(-(((t - 0.7) / 0.026) ** 2));
        const v = s * crease * (0.85 + 0.15 * t);
        if (v > best) best = v;
        when = Math.min(when, 0.7 + t * 1.1);
      }
      if (best <= 0.02) continue;
      const i = gy * imp.w + gx;
      imp.S[i] = best;
      imp.D[i] = when + rand() * 0.12;
    }
  }
  imp.maxD = 1.9;
  // Water beads squeezed out around the outline.
  for (const [bx, by, tx, ty, rad] of FINGERS) {
    for (let k = 0; k < 7; k++) {
      const t = 0.15 + rand() * 0.85;
      const side = rand() < 0.5 ? 1 : -1;
      const len = Math.hypot(tx - bx, ty - by);
      const nx = (-(ty - by) / len) * side;
      const ny = ((tx - bx) / len) * side;
      const r = rad * (1 - 0.18 * t) + 0.012;
      const [x, y] = toPage(bx + (tx - bx) * t + nx * r, by + (ty - by) * t + ny * r);
      imp.beads.push(x, y, 0.7 + t * 1.1 + imp.press * 0.6, 0.7 + rand() * 1.5);
    }
  }
  for (let k = 0; k < 14; k++) {
    const a = rand() * Math.PI * 2;
    const [x, y] = toPage(Math.cos(a) * 0.2, 0.1 + Math.sin(a) * 0.2);
    imp.beads.push(x, y, 0.9 + imp.press * 0.6, 0.8 + rand() * 1.6);
  }
  // A drip or two running from the heel of the hand.
  const drips = 1 + Math.floor(rand() * 2);
  for (let k = 0; k < drips; k++) {
    const [x, y] = toPage((rand() - 0.5) * 0.24, 0.3);
    imp.drips.push(x, y, 2.4 + rand() * 1.5, 1.8 + rand() * 0.8);
  }
  imp.beads = sortTuples(imp.beads, 4);
  imp.drips = sortTuples(imp.drips, 4);
  return imp;
}
