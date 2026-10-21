// Procedural pieces for the possession: the apparition, film grain, tape snow,
// and the SVG filters that pull the real page apart. Nothing is loaded from
// anywhere: every pixel is drawn at run time, and the filters are built node by
// node (no markup strings), so pages enforcing Trusted Types accept them too.

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svgEl(tag: string, attrs: Record<string, string | number> = {}, children: Element[] = []): SVGElement {
  const el = document.createElementNS(SVG_NS, tag) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const child of children) el.appendChild(child);
  return el;
}

const filterEl = (id: string, children: Element[]) =>
  svgEl('filter', { id, x: 0, y: 0, width: '100%', height: '100%', 'color-interpolation-filters': 'sRGB' }, children);
const merge = (result: string, ...inputs: string[]) =>
  svgEl('feMerge', result ? { result } : {}, inputs.map((i) => svgEl('feMergeNode', { in: i })));

/**
 * A pale face that surfaces from the noise: long skull, dark sockets with two
 * pinpoints, an open mouth. Drawn at a modest size and shown larger, so it stays soft.
 */
export function drawApparition(rand: () => number): HTMLCanvasElement {
  const S = 2; // drawn at twice the design grid of 96 x 128
  const W = 96 * S;
  const H = 128 * S;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(S, S);

  const soft = (x: number, y: number, rx: number, ry: number, inner: string, outer: string, mid?: string) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, inner);
    if (mid) g.addColorStop(0.55, mid);
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  // The head: long and narrow, brightest at the brow, dissolving at the edges.
  soft(48, 56, 30, 44, 'rgba(236,238,242,0.97)', 'rgba(205,212,222,0)', 'rgba(222,228,236,0.8)');
  soft(48, 42, 21, 20, 'rgba(248,248,250,0.7)', 'rgba(248,248,250,0)');
  // What is below the chin trails off into nothing.
  soft(48, 106, 15, 22, 'rgba(210,216,226,0.3)', 'rgba(210,216,226,0)');

  // Sockets, mouth and hollows painted dark, so they read on pale pages as well as dark ones.
  // Each socket is two uneven hollows, deeper towards the nose: a skull, not a cartoon.
  const dark = (a: number) => `rgba(8,4,8,${a})`;
  const tilt = (rand() - 0.5) * 1.6;
  for (const [x, side] of [
    [37, -1],
    [59, 1],
  ]) {
    const y = 51 + tilt * side;
    soft(x, y, 8.2, 9.6, dark(0.88), dark(0), dark(0.7));
    soft(x - side * 1.6, y - 1.2, 6, 6.6, dark(0.75), dark(0));
    soft(x + side * 1.4, y + 2.6, 5.2, 4.2, dark(0.5), dark(0));
  }
  soft(48, 63, 2.6, 8, 'rgba(250,250,252,0.3)', 'rgba(250,250,252,0)');
  soft(45.8, 70.5, 1.4, 2.8, dark(0.6), dark(0));
  soft(50.2, 70.5, 1.4, 2.8, dark(0.6), dark(0));
  soft(30.5, 75, 6.5, 10, dark(0.26), dark(0));
  soft(65.5, 75, 6.5, 10, dark(0.26), dark(0));
  soft(48, 88.5, 5.2, 11, dark(0.88), dark(0), dark(0.65));
  // Two pinpoints deep in the sockets.
  soft(38.2, 52.8 + tilt, 0.9, 0.9, 'rgba(255,252,246,1)', 'rgba(255,252,246,0)');
  soft(57.8, 52.8 - tilt, 0.9, 0.9, 'rgba(255,252,246,1)', 'rgba(255,252,246,0)');

  // Eaten away by the signal: thin dead rows and scattered missing pixels.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'destination-out';
  for (let y = 2; y < H; y += 4) {
    ctx.fillStyle = `rgba(0,0,0,${(0.1 + rand() * 0.18).toFixed(2)})`;
    ctx.fillRect(0, y, W, 1);
  }
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = `rgba(0,0,0,${(0.3 + rand() * 0.7).toFixed(2)})`;
    ctx.fillRect(Math.floor(rand() * W), Math.floor(rand() * H), 1 + Math.floor(rand() * 2), 1);
  }
  ctx.globalCompositeOperation = 'source-over';

  // Torn rows, as if the face did not quite make it through the tape.
  const img = ctx.getImageData(0, 0, W, H);
  const row = new Uint8ClampedArray(W * 4);
  for (let tear = 0; tear < 6; tear++) {
    const y0 = Math.floor((18 + rand() * 90) * S);
    const rows = S * (1 + Math.floor(rand() * 3));
    const shift = Math.round((rand() - 0.5) * 9 * S);
    for (let y = y0; y < Math.min(H, y0 + rows); y++) {
      const start = y * W * 4;
      row.set(img.data.subarray(start, start + W * 4));
      for (let x = 0; x < W; x++) {
        const sx = Math.min(W - 1, Math.max(0, x - shift));
        img.data.set(row.subarray(sx * 4, sx * 4 + 4), start + x * 4);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Where the chin sits, as a fraction of the apparition's height (the rest is trailing mist). */
export const APPARITION_CHIN = 0.8;

function xorshift(rand: () => number): () => number {
  let s = (rand() * 0xffffffff) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
}

/** A frame of monochrome film grain at half resolution. Jittered with transforms, it reads as live. */
export function drawGrain(width: number, height: number, rand: () => number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(64, Math.min(900, Math.ceil(width / 2)));
  canvas.height = Math.max(64, Math.min(600, Math.ceil(height / 2)));
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const img = ctx.createImageData(canvas.width, canvas.height);
  const d = img.data;
  // xorshift: a few million Math.random calls would be noticeably slower.
  const next = xorshift(rand);
  for (let i = 0; i < d.length; i += 4) {
    const v = next() & 0xff;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 34;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Tape snow: short bright horizontal dashes, sparse, for the tracking band. */
export function drawSnow(rand: () => number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 48;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  for (let i = 0; i < 150; i++) {
    const y = Math.floor(rand() * canvas.height);
    const x = rand() * canvas.width;
    const w = 1 + rand() * rand() * 22;
    ctx.fillStyle = `rgba(255,255,255,${(0.25 + rand() * 0.6).toFixed(2)})`;
    ctx.fillRect(x, y, w, 1);
  }
  // One bright scratch line, as tracking errors always have.
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillRect(0, Math.floor(canvas.height * (0.2 + rand() * 0.6)), canvas.width, 1);
  return canvas;
}

/**
 * Colour matrix keeping red ('r') or green and blue ('gb'), with the page's
 * darkening folded in: darker, flatter and greyer as `dim` goes to 1, so the
 * page sinks back and the words own the screen (white ends near 0.29, black near 0.05).
 */
export function channelMatrix(keep: 'r' | 'gb', dim = 0): string {
  const b = 1 - dim * 0.64;
  const c = 1 - dim * 0.28;
  const s = 1 - dim * 0.6;
  const sat = [
    [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
  ];
  const rows = sat.map((row, i) =>
    (i === 0) === (keep === 'r') ? `${row.map((v) => (v * b * c).toFixed(4)).join(' ')} 0 ${(0.5 * b * (1 - c)).toFixed(4)}` : '0 0 0 0 0',
  );
  rows.push('0 0 0 1 0');
  return rows.join('  ');
}

export interface SplitFilter {
  filter: SVGElement;
  /** Offsets of the red copy and of the green-and-blue copy. */
  r: SVGElement;
  c: SVGElement;
  /** The two colour matrices, for darkening. */
  mr: SVGElement;
  mc: SVGElement;
}

/**
 * Displace the page behind an element and pull red away from cyan. The gap an
 * offset opens at an edge is filled from the same channels unshifted, so
 * nothing tears open at the sides.
 */
export function splitFilter(id: string): SplitFilter {
  const mr = svgEl('feColorMatrix', { in: 'SourceGraphic', values: channelMatrix('r'), result: 'r' });
  const r = svgEl('feOffset', { in: 'r', result: 'ro' });
  const mc = svgEl('feColorMatrix', { in: 'SourceGraphic', values: channelMatrix('gb'), result: 'c' });
  const c = svgEl('feOffset', { in: 'c', result: 'co' });
  const filter = filterEl(id, [
    mr,
    r,
    merge('R', 'r', 'ro'),
    mc,
    c,
    merge('C', 'c', 'co'),
    svgEl('feComposite', { in: 'R', in2: 'C', operator: 'arithmetic', k2: 1, k3: 1 }),
  ]);
  return { filter, r, c, mr, mc };
}

/** The backdrop sheared sideways by a fixed amount: one row of a tracking error. */
export function shearFilter(id: string, dx: number): SVGElement {
  return filterEl(id, [svgEl('feOffset', { in: 'SourceGraphic', dx: dx.toFixed(1), result: 'o' }), merge('', 'SourceGraphic', 'o')]);
}

const BANDING = '0 .16 .32 .48 .64 .8 1';

/** Datamosh: the backdrop dragged, crushed into macroblocks, colours banded like a starved codec. */
export function moshFilter(id: string, block: number): { filter: SVGElement; o: SVGElement } {
  const h = Math.floor(block / 2);
  const o = svgEl('feOffset', { in: 'SourceGraphic', result: 'o' });
  const band = (ch: string) => svgEl(`feFunc${ch}`, { type: 'discrete', tableValues: BANDING });
  const filter = filterEl(id, [
    o,
    merge('m', 'SourceGraphic', 'o'),
    svgEl('feFlood', { x: h, y: h, width: 1, height: 1, 'flood-color': '#fff' }),
    svgEl('feComposite', { width: block, height: block }),
    svgEl('feTile', { result: 'dots' }),
    svgEl('feComposite', { in: 'm', in2: 'dots', operator: 'in' }),
    svgEl('feMorphology', { operator: 'dilate', radius: h }),
    svgEl('feComponentTransfer', {}, [band('R'), band('G'), band('B')]),
  ]);
  return { filter, o };
}
