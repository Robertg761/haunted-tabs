// Procedural pieces for the possession: the apparition, film grain, tape snow,
// and the SVG filters that pull the real page apart. Nothing is loaded from
// anywhere: every pixel is drawn at run time.

/** A pale, blurred face that surfaces from the noise. Drawn small, shown large, so it stays soft. */
export function drawApparition(rand: () => number): HTMLCanvasElement {
  const W = 96;
  const H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const soft = (x: number, y: number, rx: number, ry: number, inner: string, outer: string) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, inner);
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  // The head: long and narrow, brightest at the brow, dissolving at the edges.
  soft(48, 54, 31, 44, 'rgba(232,236,240,0.95)', 'rgba(205,212,222,0)');
  soft(48, 44, 22, 22, 'rgba(244,246,248,0.6)', 'rgba(244,246,248,0)');
  // What is below the chin trails off into nothing.
  soft(48, 104, 18, 26, 'rgba(210,216,226,0.28)', 'rgba(210,216,226,0)');

  // Hollows carved out of it, so the dark page shows through.
  ctx.globalCompositeOperation = 'destination-out';
  const tilt = (rand() - 0.5) * 2;
  soft(37, 50 + tilt, 8.5, 10.5, 'rgba(0,0,0,1)', 'rgba(0,0,0,0)');
  soft(59, 50 - tilt, 8.5, 10.5, 'rgba(0,0,0,1)', 'rgba(0,0,0,0)');
  soft(48, 87, 6, 12, 'rgba(0,0,0,0.95)', 'rgba(0,0,0,0)');
  soft(45.5, 69, 1.6, 3.2, 'rgba(0,0,0,0.7)', 'rgba(0,0,0,0)');
  soft(50.5, 69, 1.6, 3.2, 'rgba(0,0,0,0.7)', 'rgba(0,0,0,0)');
  soft(31, 72, 6, 9, 'rgba(0,0,0,0.3)', 'rgba(0,0,0,0)');
  soft(65, 72, 6, 9, 'rgba(0,0,0,0.3)', 'rgba(0,0,0,0)');
  // Eaten away by the signal: thin dead rows and scattered missing pixels.
  for (let y = 1; y < H; y += 3) {
    ctx.fillStyle = `rgba(0,0,0,${0.12 + rand() * 0.18})`;
    ctx.fillRect(0, y, W, 1);
  }
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.3 + rand() * 0.7})`;
    ctx.fillRect(Math.floor(rand() * W), Math.floor(rand() * H), 1, 1);
  }
  ctx.globalCompositeOperation = 'source-over';
  // Two pinpoints deep in the sockets.
  soft(37.5, 51.5, 1.4, 1.4, 'rgba(255,250,245,0.55)', 'rgba(255,250,245,0)');
  soft(58.5, 51.5, 1.4, 1.4, 'rgba(255,250,245,0.55)', 'rgba(255,250,245,0)');

  // Torn rows, as if the face did not quite make it through the tape.
  const img = ctx.getImageData(0, 0, W, H);
  const row = new Uint8ClampedArray(W * 4);
  for (let tear = 0; tear < 5; tear++) {
    const y0 = Math.floor(18 + rand() * 90);
    const rows = 1 + Math.floor(rand() * 3);
    const shift = Math.round((rand() - 0.5) * 9);
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

/** The colour matrix rows that keep one channel (0 red, 1 green, 2 blue). */
export function channelMatrix(channel: number, dim = 0): string {
  // brightness, then saturate, then contrast, as CSS would, folded into one row.
  const b = 1 - dim * 0.64;
  const s = 1 - dim * 0.55;
  const c = 1 + dim * 0.12;
  const sat = [
    [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
  ];
  const rows: string[] = [];
  for (let r = 0; r < 3; r++) {
    if (r !== channel) rows.push('0 0 0 0 0');
    else rows.push(`${sat[r].map((v) => (v * b * c).toFixed(4)).join(' ')} 0 ${(0.5 * (1 - c)).toFixed(4)}`);
  }
  rows.push('0 0 0 1 0');
  return rows.join('  ');
}

/**
 * Displace the page behind an element and pull its colour channels apart.
 * Each channel gets its own offset (set later through the data-k hooks), and the
 * gap an offset opens at an edge is filled from the same channel unshifted, so
 * nothing tears open at the sides.
 */
export function splitFilter(id: string): string {
  const channel = (k: string, i: number) => `
  <feColorMatrix in="SourceGraphic" values="${channelMatrix(i)}" result="${k}" data-k="m${k}"/>
  <feOffset in="${k}" result="${k}o" data-k="${k}"/>
  <feMerge result="${k.toUpperCase()}"><feMergeNode in="${k}"/><feMergeNode in="${k}o"/></feMerge>`;
  return `<filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
  ${channel('r', 0)}${channel('g', 1)}${channel('b', 2)}
  <feComposite in="R" in2="G" operator="arithmetic" k2="1" k3="1" result="RG"/>
  <feComposite in="RG" in2="B" operator="arithmetic" k2="1" k3="1"/>
</filter>`;
}

/** The backdrop sheared sideways by a fixed amount and lifted a little: one row of a tracking error. */
export function shearFilter(id: string, dx: number): string {
  return `<filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
  <feOffset in="SourceGraphic" dx="${dx.toFixed(1)}" result="o"/>
  <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="o"/></feMerge>
  <feComponentTransfer><feFuncR type="linear" slope="1.1" intercept="0.03"/><feFuncG type="linear" slope="1.08" intercept="0.03"/><feFuncB type="linear" slope="1.14" intercept="0.05"/></feComponentTransfer>
</filter>`;
}

const BANDING = '0 .16 .32 .48 .64 .8 1';

/** Datamosh: the backdrop dragged, crushed into macroblocks, colours banded like a starved codec. */
export function moshFilter(id: string, block: number): string {
  const h = Math.floor(block / 2);
  return `<filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
  <feOffset in="SourceGraphic" result="o" data-k="o"/>
  <feMerge result="m"><feMergeNode in="SourceGraphic"/><feMergeNode in="o"/></feMerge>
  <feFlood x="${h}" y="${h}" width="1" height="1" flood-color="#fff"/>
  <feComposite width="${block}" height="${block}"/>
  <feTile result="dots"/>
  <feComposite in="m" in2="dots" operator="in"/>
  <feMorphology operator="dilate" radius="${h}"/>
  <feColorMatrix values="1.12 0 0 0 -0.02  0 1.12 0 0 -0.02  0 0 1.12 0 -0.02  0 0 0 1 0"/>
  <feComponentTransfer><feFuncR type="discrete" tableValues="${BANDING}"/><feFuncG type="discrete" tableValues="${BANDING}"/><feFuncB type="discrete" tableValues="${BANDING}"/></feComponentTransfer>
</filter>`;
}
