// Procedural sprites for the eyes: iris, sclera, pupil, highlights and the
// darkness they sit in. Painted once per placement at device resolution, so the
// frame loop only stamps images and strokes a few lid curves.

export type RGB = readonly [number, number, number];

export interface Palette {
  inner: RGB;
  mid: RGB;
  outer: RGB;
  limbus: RGB;
  fiber: RGB;
  glow: RGB;
}

/** Eyeshine colours: amber, sulphur-pale gold, and a dead grey-green. */
export const PALETTES: Palette[] = [
  { inner: [255, 205, 112], mid: [232, 146, 42], outer: [146, 76, 18], limbus: [40, 17, 6], fiber: [255, 222, 150], glow: [255, 150, 48] },
  { inner: [250, 238, 160], mid: [214, 186, 82], outer: [124, 104, 38], limbus: [34, 28, 10], fiber: [255, 248, 196], glow: [236, 208, 104] },
  { inner: [222, 232, 208], mid: [164, 182, 150], outer: [86, 102, 82], limbus: [20, 26, 22], fiber: [240, 248, 230], glow: [196, 220, 178] },
];

const TAU = Math.PI * 2;

export const rgba = (c: RGB, a: number): string => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

function surface(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return [c, c.getContext('2d')!];
}

/** A soft radial dab with the given alpha profile. Used for darkness, glow, socket and highlights. */
export function paintDab(size: number, color: RGB, stops: [number, number][]): HTMLCanvasElement {
  const [c, g] = surface(size, size);
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  for (const [at, a] of stops) grad.addColorStop(at, rgba(color, a));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

/** Near-Gaussian falloff, so overlapping dabs melt into one another. */
export const SOFT: [number, number][] = [
  [0, 1],
  [0.2, 0.93],
  [0.42, 0.68],
  [0.62, 0.36],
  [0.8, 0.12],
  [0.92, 0.03],
  [1, 0],
];

/**
 * The iris, radius R CSS px, painted at `scale` device px per CSS px. The image
 * is (2R + 2·pad) square with the iris centred; pad leaves room for the soft limbus.
 */
export function paintIris(R: number, scale: number, pal: Palette, rand: () => number, stage: number): HTMLCanvasElement {
  const pad = 2;
  const size = (R + pad) * 2 * scale;
  const [c, g] = surface(size, size);
  g.translate(size / 2, size / 2);
  g.scale(scale, scale);

  const base = g.createRadialGradient(0, 0, 0, 0, 0, R);
  base.addColorStop(0, rgba(pal.inner, 1));
  base.addColorStop(0.3, rgba(pal.inner, 1));
  base.addColorStop(0.56, rgba(pal.mid, 1));
  base.addColorStop(0.8, rgba(pal.outer, 1));
  base.addColorStop(0.93, rgba(pal.limbus, 1));
  base.addColorStop(1, rgba(pal.limbus, 0));
  g.fillStyle = base;
  g.beginPath();
  g.arc(0, 0, R, 0, TAU);
  g.fill();

  g.globalCompositeOperation = 'source-atop';
  g.lineCap = 'round';
  const px = 1 / scale;
  // Radial stroma fibres, light and dark, slightly wavy.
  const fibres = Math.round(140 + R * 6);
  for (let i = 0; i < fibres; i++) {
    const a = rand() * TAU;
    const r0 = R * (0.2 + rand() * 0.14);
    const r1 = R * (0.6 + rand() * 0.34);
    const light = rand() < 0.55;
    g.strokeStyle = light ? rgba(pal.fiber, 0.1 + rand() * 0.28) : rgba(pal.limbus, 0.14 + rand() * 0.32);
    g.lineWidth = Math.max(px, R * (0.018 + rand() * 0.035));
    const am = a + (rand() - 0.5) * 0.16;
    const rm = (r0 + r1) / 2;
    const a1 = a + (rand() - 0.5) * 0.1;
    g.beginPath();
    g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    g.quadraticCurveTo(Math.cos(am) * rm, Math.sin(am) * rm, Math.cos(a1) * r1, Math.sin(a1) * r1);
    g.stroke();
  }
  // Crypts: small dark pits in the stroma.
  for (let i = 0; i < 18; i++) {
    const a = rand() * TAU;
    const r = R * (0.42 + rand() * 0.36);
    g.fillStyle = rgba(pal.limbus, 0.22 + rand() * 0.3);
    g.beginPath();
    g.ellipse(Math.cos(a) * r, Math.sin(a) * r, R * (0.05 + rand() * 0.07), R * (0.022 + rand() * 0.02), a, 0, TAU);
    g.fill();
  }
  // The collarette: a ragged pale ring around the pupil zone.
  g.beginPath();
  for (let k = 0; k <= 56; k++) {
    const a = (k / 56) * TAU;
    const r = R * (0.4 + (rand() - 0.5) * 0.08);
    if (k === 0) g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  g.strokeStyle = rgba(pal.fiber, 0.38);
  g.lineWidth = Math.max(px, R * 0.05);
  g.stroke();
  // The glow lives near the pupil, like light coming from inside.
  const inner = g.createRadialGradient(0, 0, R * 0.12, 0, 0, R * 0.62);
  inner.addColorStop(0, rgba(pal.fiber, 0.5));
  inner.addColorStop(1, rgba(pal.fiber, 0));
  g.fillStyle = inner;
  g.fillRect(-R, -R, R * 2, R * 2);
  // Limbal ring: the dark rim that makes an iris look alive.
  const limb = g.createRadialGradient(0, 0, R * 0.72, 0, 0, R);
  limb.addColorStop(0, rgba(pal.limbus, 0));
  limb.addColorStop(0.7, rgba(pal.limbus, 0.55));
  limb.addColorStop(1, rgba(pal.limbus, 0.9));
  g.fillStyle = limb;
  g.fillRect(-R, -R, R * 2, R * 2);
  if (stage >= 4) {
    // Entombed: a faint milky film, like something long dead.
    const film = g.createRadialGradient(-R * 0.1, -R * 0.1, 0, 0, 0, R);
    film.addColorStop(0, 'rgba(226,232,236,0.1)');
    film.addColorStop(0.7, 'rgba(210,218,224,0.06)');
    film.addColorStop(1, 'rgba(200,210,216,0.02)');
    g.fillStyle = film;
    g.fillRect(-R, -R, R * 2, R * 2);
  }
  return c;
}

/** The pupil at radius 1 → half the image. Drawn scaled to any size. */
export function paintPupil(scale: number): HTMLCanvasElement {
  const size = 48 * scale;
  const [c, g] = surface(size, size);
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(2,1,1,1)');
  grad.addColorStop(0.74, 'rgba(4,2,2,1)');
  grad.addColorStop(0.86, 'rgba(22,9,4,0.85)');
  grad.addColorStop(1, 'rgba(22,9,4,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

/** Geometry of the sclera image, in eye widths, relative to the eye centre. */
export const SCLERA_BOX = { x: -0.56, y: -0.32, w: 1.12, h: 0.58 };

/**
 * The white of the eye for an eye of width w, inner corner at -x. Shaded as a
 * sphere sitting back in a dark socket, with a tear-duct caruncle and veins.
 */
export function paintSclera(w: number, scale: number, rand: () => number, stage: number): HTMLCanvasElement {
  const bw = SCLERA_BOX.w * w;
  const bh = SCLERA_BOX.h * w;
  const [c, g] = surface(bw * scale, bh * scale);
  g.scale(scale, scale);
  g.translate(-SCLERA_BOX.x * w, -SCLERA_BOX.y * w);

  const ball = g.createRadialGradient(0.02 * w, -0.04 * w, 0, 0, -0.02 * w, 0.58 * w);
  ball.addColorStop(0, 'rgb(170,158,138)');
  ball.addColorStop(0.3, 'rgb(150,136,117)');
  ball.addColorStop(0.58, 'rgb(98,82,70)');
  ball.addColorStop(0.82, 'rgb(44,33,29)');
  ball.addColorStop(1, 'rgb(16,12,11)');
  g.fillStyle = ball;
  g.fillRect(SCLERA_BOX.x * w, SCLERA_BOX.y * w, bw, bh);
  // The brow and lid keep light off the top of the eyeball.
  const top = g.createLinearGradient(0, SCLERA_BOX.y * w, 0, 0.06 * w);
  top.addColorStop(0, 'rgba(0,0,0,0.6)');
  top.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = top;
  g.fillRect(SCLERA_BOX.x * w, SCLERA_BOX.y * w, bw, bh);

  // Veins creep in from the corners towards the iris.
  const veins = stage >= 4 ? 12 : 6;
  const red = stage >= 4 ? 0.5 : 0.3;
  g.lineCap = 'round';
  for (let i = 0; i < veins; i++) {
    const side = rand() < 0.55 ? -1 : 1;
    let x = side * w * (0.46 + rand() * 0.06);
    let y = (rand() - 0.45) * 0.16 * w;
    let a = side < 0 ? (rand() - 0.5) * 0.7 : Math.PI + (rand() - 0.5) * 0.7;
    let lw = w * (0.012 + rand() * 0.01);
    const steps = 5 + Math.floor(rand() * 5);
    for (let s = 0; s < steps && Math.abs(x) > w * 0.2; s++) {
      const len = w * (0.03 + rand() * 0.03);
      const nx = x + Math.cos(a) * len;
      const ny = y + Math.sin(a) * len;
      g.strokeStyle = `rgba(150,26,24,${red * (1 - s / (steps + 2))})`;
      g.lineWidth = lw;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(nx, ny);
      g.stroke();
      if (rand() < 0.3) {
        const ba = a + (rand() < 0.5 ? -1 : 1) * (0.5 + rand() * 0.5);
        g.lineWidth = lw * 0.6;
        g.beginPath();
        g.moveTo(nx, ny);
        g.lineTo(nx + Math.cos(ba) * len * 0.8, ny + Math.sin(ba) * len * 0.8);
        g.stroke();
      }
      x = nx;
      y = ny;
      a += (rand() - 0.5) * 0.7;
      lw *= 0.82;
    }
  }
  if (stage >= 4) {
    for (const side of [-1, 1]) {
      const flush = g.createRadialGradient(side * 0.5 * w, 0, 0, side * 0.5 * w, 0, 0.32 * w);
      flush.addColorStop(0, 'rgba(150,34,28,0.32)');
      flush.addColorStop(1, 'rgba(150,34,28,0)');
      g.fillStyle = flush;
      g.fillRect(SCLERA_BOX.x * w, SCLERA_BOX.y * w, bw, bh);
    }
  }
  // Caruncle: the pink fold at the inner corner.
  const car = g.createRadialGradient(-0.47 * w, 0.03 * w, 0, -0.47 * w, 0.03 * w, 0.085 * w);
  car.addColorStop(0, 'rgba(150,66,62,0.9)');
  car.addColorStop(0.6, 'rgba(120,50,48,0.5)');
  car.addColorStop(1, 'rgba(120,50,48,0)');
  g.fillStyle = car;
  g.fillRect(SCLERA_BOX.x * w, SCLERA_BOX.y * w, bw, bh);
  return c;
}

/**
 * The core of the darkness, painted at the size it is drawn (w by h px) so its
 * noise is round, not smeared into streaks. A deep centre that thins through a
 * long, smoky falloff; the edge is pushed in and out by several octaves of
 * noise, more the further out it is, so it reads as shadow pooling in the air
 * rather than ink or an airbrushed ellipse.
 */
export function paintPoolCore(w: number, h: number, color: RGB, rand: () => number): HTMLCanvasElement {
  const W = Math.max(8, Math.ceil(w));
  const Hh = Math.max(4, Math.ceil(h));
  const [c, g] = surface(W, Hh);
  const img = g.createImageData(W, Hh);
  // Value-noise octaves on square cells, a few across the short side.
  const octave = (cell: number) => {
    const nx = Math.ceil(W / cell) + 2;
    const ny = Math.ceil(Hh / cell) + 2;
    const lat = new Float32Array(nx * ny);
    for (let i = 0; i < lat.length; i++) lat[i] = rand();
    const ox = rand() * cell;
    const oy = rand() * cell;
    return (x: number, y: number) => {
      const fx = (x + ox) / cell;
      const fy = (y + oy) / cell;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const k = y0 * nx + x0;
      const a = lat[k] + (lat[k + 1] - lat[k]) * sx;
      const b = lat[k + nx] + (lat[k + nx + 1] - lat[k + nx]) * sx;
      return a + (b - a) * sy;
    };
  };
  const o1 = octave(Hh * 0.55);
  const o2 = octave(Hh * 0.27);
  const o3 = octave(Hh * 0.13);
  const o4 = octave(Math.max(2, Hh * 0.06));
  const sstep = (e0: number, e1: number, v: number) => {
    const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const cx = W / 2;
  const cy = Hh / 2;
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x + 0.5 - cx) / cx;
      const dy = (y + 0.5 - cy) / cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r >= 1) continue;
      // Smoke: broad slow lobes push the edge in and out (more the further out),
      // finer curls only shade it. Mostly eaten inward, so the sprite's own edge
      // is never reached and never shows as a cut.
      const lobes = o1(x, y) * 0.65 + o2(x, y) * 0.35;
      const curls = o3(x, y) * 0.6 + o4(x, y) * 0.4;
      const edge = sstep(0.3, 1, r);
      const re = r * (1 + (lobes - 0.42) * 0.85 * edge);
      // A deep heart behind the eyes, wrapped in a broader smoky falloff.
      const heart = 1 - sstep(0.42, 0.8, re);
      const haze = 0.82 * Math.exp(-3 * re * re);
      let a = 1 - (1 - heart) * (1 - haze);
      a *= 1 - sstep(0.84, 1, r);
      // Faint, soft mottling toward the rim; the centre stays solid.
      a *= 1 - 0.45 * (curls - 0.3) * sstep(0.4, 0.95, re);
      const o = (y * W + x) * 4;
      img.data[o] = color[0];
      img.data[o + 1] = color[1];
      img.data[o + 2] = color[2];
      img.data[o + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}
