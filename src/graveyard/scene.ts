/**
 * The night behind the graves: stars, the moon, layered hills with dead trees,
 * a chapel and an iron fence, drifting fog, the odd bat. Everything is drawn
 * procedurally from a fixed seed, so the landscape is the same on every visit
 * and simply re-fits the window when it is resized.
 */
import { between, n1, seeded, type Rand } from './rand';

const LANDSCAPE_SEED = 0x6a7e;
const MARGIN = 40; // extra width on each side for the pointer parallax

interface Layer {
  el: HTMLElement;
  depth: number;
  /** The most a layer may rise as the page scrolls, as a share of the window height. */
  lift: number;
}

let nearRidge = 0;
/** Where the near ridge (with the fence) meets the sky, in page pixels when scrolled to the top. */
export const nearRidgeY = (): number => nearRidge;

export function startScene(reducedMotion: () => boolean): void {
  const layers: Layer[] = [...document.querySelectorAll<HTMLElement>('.scene [data-depth]')].map((el) => ({
    el,
    depth: Number(el.dataset.depth),
    lift: Number(el.dataset.lift ?? 1),
  }));

  const draw = (): void => {
    drawStars();
    drawLandscape();
    drawFog();
  };
  draw();

  let resizeTimer = 0;
  let lastWidth = innerWidth;
  let lastHeight = innerHeight;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      // Mobile browsers resize the height as the toolbar slides; ignore small changes.
      if (innerWidth === lastWidth && Math.abs(innerHeight - lastHeight) < 120) return;
      lastWidth = innerWidth;
      lastHeight = innerHeight;
      draw();
      update();
    }, 150);
  });

  // Parallax: scroll lifts nearer layers faster, but only so far: however deep the yard,
  // the ridges stay in order and the sky and moon stay in view. The pointer sways them a little.
  let target = 0;
  let sway = 0;
  let ticking = false;
  let last = 0;
  const update = (now = performance.now()): void => {
    ticking = false;
    const reduced = reducedMotion();
    // Eased by time, not by frame, so it settles in the same ~half second at any frame rate.
    const dt = Math.min(100, now - (last || now));
    last = now;
    if (!reduced) sway += (target - sway) * (1 - Math.exp(-dt / 150));
    const scroll = reduced ? 0 : scrollY;
    for (const { el, depth, lift } of layers) {
      const x = reduced ? 0 : sway * depth * 70;
      const y = Math.min(scroll * depth, innerHeight * lift);
      el.style.translate = `${x.toFixed(1)}px ${(-y).toFixed(1)}px`;
    }
    if (!reduced && Math.abs(target - sway) > 0.004) request();
    else last = 0;
  };
  const request = (): void => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame((t) => update(t));
  };
  addEventListener('scroll', request, { passive: true });
  addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType !== 'mouse') return;
      target = (e.clientX / innerWidth - 0.5) * -2;
      request();
    },
    { passive: true },
  );
  update();

  scheduleBats(reducedMotion);
}

// ---------------------------------------------------------------- stars

function drawStars(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('.stars');
  const twinkles = document.querySelector<HTMLElement>('.twinkles');
  if (!canvas || !twinkles) return;
  const w = innerWidth;
  const h = innerHeight;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const r = seeded(LANDSCAPE_SEED + 1);
  const count = Math.round((w * h) / 2600);
  for (let i = 0; i < count; i++) {
    const x = r() * w;
    // Denser high in the sky, thinning towards the hills.
    const y = Math.pow(r(), 1.6) * h * 0.72;
    const fade = 1 - y / (h * 0.72);
    const size = Math.pow(r(), 3) * 1.25 + 0.25;
    const tint = r();
    ctx.globalAlpha = (0.25 + r() * 0.65) * (0.35 + fade * 0.65);
    ctx.fillStyle = tint < 0.15 ? '#ffe9c4' : tint < 0.4 ? '#cfe0ff' : '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
  }
  // A faint diagonal band, like a far-off milky way.
  for (let i = 0; i < count * 0.8; i++) {
    const t = r();
    const x = t * w;
    const y = h * (0.05 + t * 0.32) + (r() - 0.5) * h * 0.12 * (1 + r());
    ctx.globalAlpha = 0.12 + r() * 0.25;
    ctx.fillStyle = '#dfe6ff';
    ctx.fillRect(x, y, 0.8, 0.8);
  }
  ctx.globalAlpha = 1;

  // A few brighter stars that twinkle (as their own small layers, cheap to animate).
  const spans: HTMLElement[] = [];
  const bright = Math.max(6, Math.round(w / 110));
  for (let i = 0; i < bright; i++) {
    const s = document.createElement('i');
    s.style.left = `${(r() * 100).toFixed(2)}%`;
    s.style.top = `${(Math.pow(r(), 1.4) * 52).toFixed(2)}%`;
    s.style.setProperty('--d', `${(2.5 + r() * 4).toFixed(2)}s`);
    s.style.setProperty('--delay', `${(-r() * 6).toFixed(2)}s`);
    s.style.setProperty('--s', `${(1.6 + r() * 1.8).toFixed(1)}px`);
    spans.push(s);
  }
  twinkles.replaceChildren(...spans);
}

// ---------------------------------------------------------------- landscape

/** A rolling ridge line built from a few sine waves of fixed wavelengths (in px). */
function ridge(r: Rand, base: number, amp: number, wavelengths: number[]): (x: number) => number {
  const waves = wavelengths.map((len, i) => ({
    a: (amp * between(r, 0.55, 1)) / (i + 1) ** 1.5,
    f: (Math.PI * 2) / (len * between(r, 0.85, 1.15)),
    p: r() * Math.PI * 2,
  }));
  return (x) => base + waves.reduce((sum, w) => sum + w.a * Math.sin(x * w.f + w.p), 0);
}

function ridgePaths(y: (x: number) => number, W: number, H: number): { fill: string; rim: string } {
  let line = '';
  for (let x = 0; x <= W + 8; x += 8) line += `${x === 0 ? 'M' : 'L'}${x},${n1(y(x))}`;
  return { fill: `${line}L${W + 8},${H}L0,${H}Z`, rim: line };
}

/** A gnarled, leafless tree as one filled path (all pieces share the same winding). */
function deadTree(r: Rand, x: number, y: number, height: number, lean: number, maxDepth: number): string {
  let d = '';
  let pieces = 0;
  const circle = (cx: number, cy: number, rad: number): void => {
    if (rad < 0.4) return;
    d += `M${n1(cx - rad)},${n1(cy)}a${n1(rad)},${n1(rad)} 0 1 0 ${n1(rad * 2)},0a${n1(rad)},${n1(rad)} 0 1 0 ${n1(-rad * 2)},0`;
  };
  const branch = (bx: number, by: number, ang: number, len: number, w: number, depth: number): void => {
    if (pieces++ > 900) return;
    const ex = bx + Math.cos(ang) * len;
    const ey = by + Math.sin(ang) * len;
    const bend = between(r, -0.45, 0.45) * len * 0.25;
    const nx = Math.cos(ang + Math.PI / 2);
    const ny = Math.sin(ang + Math.PI / 2);
    const mx = (bx + ex) / 2 + nx * bend;
    const my = (by + ey) / 2 + ny * bend;
    const w2 = Math.max(0.7, w * between(r, 0.58, 0.7));
    const wm = (w + w2) / 4;
    d +=
      `M${n1(bx + (nx * w) / 2)},${n1(by + (ny * w) / 2)}` +
      `Q${n1(mx + nx * wm)},${n1(my + ny * wm)} ${n1(ex + (nx * w2) / 2)},${n1(ey + (ny * w2) / 2)}` +
      `L${n1(ex - (nx * w2) / 2)},${n1(ey - (ny * w2) / 2)}` +
      `Q${n1(mx - nx * wm)},${n1(my - ny * wm)} ${n1(bx - (nx * w) / 2)},${n1(by - (ny * w) / 2)}Z`;
    circle(ex, ey, w2 / 2);
    if (depth >= maxDepth || len < 2.5) return;
    const kids = depth === 0 ? 2 + (r() < 0.6 ? 1 : 0) : r() < 0.22 ? 3 : 2;
    for (let k = 0; k < kids; k++) {
      const spread = (k / (kids - 1 || 1) - 0.5) * between(r, 0.7, 1.25);
      // Branches droop a little as they thin, and the whole tree leans.
      const droop = depth > 2 ? between(r, 0, 0.25) * Math.sign(Math.cos(ang)) : 0;
      branch(ex, ey, ang + spread + between(r, -0.25, 0.25) + droop, len * between(r, 0.62, 0.82), w2, depth + 1);
    }
  };
  // Roots flare into the ground.
  const base = height * 0.05;
  // (Drawn counter-clockwise like every other piece, so overlaps never cancel out.)
  d += `M${n1(x + base * 1.6)},${n1(y + 4)}Q${n1(x + base * 0.4)},${n1(y - base * 0.6)} ${n1(x + base * 0.35)},${n1(y - height * 0.12)}L${n1(x - base * 0.35)},${n1(y - height * 0.12)}Q${n1(x - base * 0.4)},${n1(y - base * 0.6)} ${n1(x - base * 1.6)},${n1(y + 4)}Z`;
  branch(x, y + 2, -Math.PI / 2 + lean, height * 0.34, height * 0.06, 0);
  return d;
}

function chapel(x: number, y: number, s: number): { body: string; glow: string } {
  const p = (pts: [number, number][]): string => 'M' + pts.map(([px, py]) => `${n1(x + px * s)},${n1(y + py * s)}`).join('L') + 'Z';
  const body =
    p([[-34, 6], [-34, -26], [-8, -44], [18, -26], [18, 6]]) + // nave with roof
    p([[18, 6], [18, -46], [21, -50], [21, -66], [27, -92], [33, -66], [33, -50], [36, -46], [36, 6]]) + // tower and spire
    p([[26.2, -92], [27.8, -92], [27.8, -100], [31, -100], [31, -102], [27.8, -102], [27.8, -106], [26.2, -106], [26.2, -102], [23, -102], [23, -100], [26.2, -100]]); // cross
  const glow = p([[-22, -6], [-22, -16], [-19, -20], [-16, -16], [-16, -6]]) + p([[25, -30], [25, -38], [27, -41], [29, -38], [29, -30]]);
  return { body, glow };
}

function tinyGraves(r: Rand, y: (x: number) => number, from: number, to: number, s: number): string {
  let d = '';
  for (let x = from; x < to; x += between(r, 9, 22) * s) {
    const gy = y(x) + 1;
    const h = between(r, 5, 10) * s;
    const w = between(r, 3, 5) * s;
    if (r() < 0.35) {
      const t = w * 0.35;
      d += `M${n1(x - t / 2)},${n1(gy)}V${n1(gy - h)}h${n1(t)}V${n1(gy)}Z`;
      d += `M${n1(x - w / 2)},${n1(gy - h * 0.72)}h${n1(w)}v${n1(t)}h${n1(-w)}Z`;
    } else {
      d += `M${n1(x - w / 2)},${n1(gy)}V${n1(gy - h + w / 2)}a${n1(w / 2)},${n1(w / 2)} 0 0 1 ${n1(w)},0V${n1(gy)}Z`;
    }
  }
  return d;
}

function grass(r: Rand, y: (x: number) => number, W: number, maxH: number): string {
  let d = '';
  for (let x = 0; x < W; x += between(r, 1.5, 4)) {
    const gy = y(x) + 1;
    const h = between(r, 0.3, 1) * maxH;
    const lean = between(r, -0.5, 0.5) * h;
    d += `M${n1(x - 1)},${n1(gy)}L${n1(x + lean)},${n1(gy - h)}L${n1(x + 1)},${n1(gy)}Z`;
  }
  return d;
}

/** Wrought-iron fence following the near ridge, with spear-tipped bars and the odd bent one (all clockwise). */
function fence(r: Rand, y: (x: number) => number, W: number, h: number): string {
  let d = '';
  const fh = Math.max(34, Math.min(66, h * 0.065));
  const gap = Math.max(10, fh * 0.24);
  const bw = Math.max(1.6, fh * 0.04);
  for (let x = 6; x < W; x += gap) {
    if (r() < 0.04) continue; // a missing bar
    const base = y(x) + 3;
    const tilt = r() < 0.07 ? between(r, -0.18, 0.18) : between(r, -0.02, 0.02);
    const tipX = x + Math.sin(tilt) * fh;
    const tipY = base - Math.cos(tilt) * fh;
    d += `M${n1(x - bw / 2)},${n1(base)}L${n1(tipX - bw / 2)},${n1(tipY)}L${n1(tipX + bw / 2)},${n1(tipY)}L${n1(x + bw / 2)},${n1(base)}Z`;
    const sp = bw * 1.9;
    d += `M${n1(tipX - sp)},${n1(tipY + sp * 0.6)}L${n1(tipX)},${n1(tipY - sp * 2.2)}L${n1(tipX + sp)},${n1(tipY + sp * 0.6)}Z`;
  }
  // Two rails, and stout posts with ball finials.
  for (const at of [0.22, 0.8]) {
    let top = '';
    let bottom = '';
    for (let x = 0; x <= W; x += 10) {
      const ry = y(x) + 3 - fh * at;
      top += `${x === 0 ? 'M' : 'L'}${x},${n1(ry - bw * 0.8)}`;
      bottom = `L${x},${n1(ry + bw * 0.8)}` + bottom;
    }
    d += top + bottom + 'Z';
  }
  for (let x = between(r, 40, 120); x < W; x += between(r, 170, 240)) {
    const base = y(x) + 4;
    const pw = bw * 3.4;
    const ph = fh * 1.12;
    d += `M${n1(x - pw / 2)},${n1(base)}V${n1(base - ph)}h${n1(pw)}V${n1(base)}Z`;
    d += `M${n1(x - pw * 0.7)},${n1(base - ph)}h${n1(pw * 1.4)}v${n1(-pw * 0.4)}h${n1(-pw * 1.4)}Z`;
    const br = pw * 0.55;
    d += `M${n1(x - br)},${n1(base - ph - pw * 0.4 - br)}a${n1(br)},${n1(br)} 0 1 1 ${n1(br * 2)},0a${n1(br)},${n1(br)} 0 1 1 ${n1(-br * 2)},0`;
  }
  return d;
}

function drawLandscape(): void {
  const vw = innerWidth;
  const vh = innerHeight;
  const W = vw + MARGIN * 2;
  const H = Math.round(vh * 1.7);
  const s = Math.max(0.65, Math.min(1.3, vh / 850));
  const narrow = vw < 640;
  const r = seeded(LANDSCAPE_SEED);

  const set = (id: string, inner: string): void => {
    const svg = document.getElementById(id);
    if (!svg) return;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML = inner;
  };
  const grad = (id: string, top: string, bottom: string, y1: number, y2: number): string =>
    `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${n1(y1)}" x2="0" y2="${n1(y2)}"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>`;

  // Far hills: low, hazy, catching moonlight on their crests.
  const farY = ridge(r, vh * (narrow ? 0.6 : 0.56), vh * 0.05, [1100, 520, 240, 90]);
  const far = ridgePaths(farY, W, H);
  let farTrees = '';
  for (let x = between(r, 60, 200); x < W; x += between(r, 160, 340)) {
    if (r() < 0.45) farTrees += deadTree(r, x, farY(x), between(r, 26, 48) * s, between(r, -0.2, 0.2), 4);
  }
  set(
    'hills-far',
    grad('g-far', '#2b2747', '#141227', vh * 0.48, vh * 0.9) +
      `<path d="${far.fill}" fill="url(#g-far)"/><path d="${farTrees}" fill="url(#g-far)"/>` +
      `<path d="${far.rim}" fill="none" stroke="#a7a3d6" stroke-opacity=".28" stroke-width="1.2"/>`,
  );

  // Middle ground: trees, a chapel with a lit window, a distant row of graves.
  const midY = ridge(r, vh * (narrow ? 0.7 : 0.67), vh * 0.035, [1300, 600, 210, 70]);
  const mid = ridgePaths(midY, W, H);
  let midTrees = '';
  const chapelX = W * (narrow ? 0.78 : 0.7);
  for (let x = between(r, 30, 140); x < W; x += between(r, 260, 460) * (narrow ? 0.8 : 1)) {
    if (Math.abs(x - chapelX) < 90 * s) continue;
    midTrees += deadTree(r, x, midY(x), between(r, 70, 130) * s, between(r, -0.25, 0.25), 6);
  }
  const ch = chapel(chapelX, midY(chapelX) + 2, s * (narrow ? 0.8 : 1));
  const graves = tinyGraves(r, midY, chapelX - 220 * s, chapelX - 50 * s, s) + tinyGraves(r, midY, chapelX + 50 * s, chapelX + 160 * s, s);
  set(
    'hills-mid',
    grad('g-mid', '#191630', '#0c0a1a', vh * 0.6, vh * 1.1) +
      `<path d="${mid.fill}${ch.body}${graves}${grass(r, midY, W, 3)}" fill="url(#g-mid)"/><path d="${midTrees}" fill="url(#g-mid)"/>` +
      `<path d="${ch.glow}" fill="#f2b45e" fill-opacity=".55" class="window"/>` +
      `<path d="${mid.rim}" fill="none" stroke="#9e98d0" stroke-opacity=".16" stroke-width="1"/>`,
  );

  // Near crest: the iron fence, a great dead tree at the edge, long grass.
  const nearY = ridge(r, vh * (narrow ? 0.82 : 0.8), vh * 0.018, [1500, 640, 260]);
  nearRidge = nearY(W / 2);
  const near = ridgePaths(nearY, W, H);
  // Below the crest the yard rolls on in low swells, each catching a little moonlight, so a
  // long scroll still reads as ground receding rather than a black wall.
  let swells = '';
  for (let i = 1; i <= 5; i++) {
    const swell = ridge(r, vh * (narrow ? 0.84 : 0.82) + vh * 0.09 * i, vh * 0.012, [900, 380]);
    const p = ridgePaths(swell, W, H);
    swells += `<path d="${p.fill}" fill="#0c0a15" fill-opacity="${(0.5 + i * 0.08).toFixed(2)}"/><path d="${p.rim}" fill="none" stroke="#6f69a0" stroke-opacity="${(0.09 - i * 0.008).toFixed(3)}" stroke-width="1"/>`;
    swells += `<path d="${grass(r, swell, W, 4 * s)}" fill="#0c0a15"/>`;
  }
  const bigX = MARGIN + (narrow ? 4 : vw * 0.035);
  const big = deadTree(r, bigX, nearY(bigX), vh * (narrow ? 0.4 : 0.56), 0.1, 7);
  const smallX = W * 0.965;
  const small = narrow ? '' : deadTree(r, smallX, nearY(smallX), vh * 0.26, 0.2, 6);
  set(
    'hills-near',
    grad('g-near', '#0b0914', '#05040a', vh * 0.75, vh * 1.2) +
      `<path d="${near.fill}${fence(r, nearY, W, vh)}${grass(r, nearY, W, 7 * s)}" fill="url(#g-near)"/><path d="${big}${small}" fill="url(#g-near)"/>` +
      `<path d="${near.rim}" fill="none" stroke="#8d88c0" stroke-opacity=".1" stroke-width="1"/>` +
      swells,
  );
}

// ---------------------------------------------------------------- fog

/** Soft, seamlessly tiling fog painted once; CSS only slides it sideways. */
function drawFog(): void {
  document.querySelectorAll<HTMLCanvasElement>('canvas.fog').forEach((canvas, i) => {
    const tile = Math.max(1024, Math.ceil(innerWidth / 256) * 256);
    const height = Number(canvas.dataset.height || 240);
    const scale = 0.5; // painted at half resolution: fog is soft anyway
    canvas.width = Math.round(tile * 2 * scale);
    canvas.height = Math.round(height * scale);
    canvas.style.width = `${tile * 2}px`;
    canvas.style.height = `${height}px`;
    canvas.style.setProperty('--tile', `${tile}px`);
    canvas.style.setProperty('--fog-dur', `${Math.round(tile / (i === 0 ? 9 : 14))}s`);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(scale, scale);
    const r = seeded(LANDSCAPE_SEED + 7 + i * 31);
    const blobs = Math.round(tile / 14);
    for (let b = 0; b < blobs; b++) {
      const x = r() * tile;
      const y = height * between(r, 0.3, 0.92);
      const ry = between(r, 16, 52);
      const rx = ry * between(r, 2.5, 6);
      const a = between(r, 0.035, 0.09);
      for (const ox of [x - tile, x, x + tile, x + tile * 2]) {
        if (ox + rx < 0 || ox - rx > tile * 2) continue;
        ctx.save();
        ctx.translate(ox, y);
        ctx.scale(rx / ry, 1);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, ry);
        g.addColorStop(0, `rgba(205, 210, 236, ${a})`);
        g.addColorStop(0.6, `rgba(190, 196, 228, ${a * 0.45})`);
        g.addColorStop(1, 'rgba(190, 196, 228, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, ry, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  });
}

// ---------------------------------------------------------------- bats

const BAT_SVG =
  '<svg viewBox="-20 -10 40 20" aria-hidden="true">' +
  '<path class="wing" d="M0-1C-4-6-10-7.5-18.5-4.5Q-15.5-1.6-15 1.2Q-12-1-9.6 1.6Q-6.8-.6-4.6 2.2Q-2.4.4 0 1.2Z"/>' +
  '<g transform="scale(-1 1)"><path class="wing" d="M0-1C-4-6-10-7.5-18.5-4.5Q-15.5-1.6-15 1.2Q-12-1-9.6 1.6Q-6.8-.6-4.6 2.2Q-2.4.4 0 1.2Z"/></g>' +
  '<path d="M-1.6-1.4L-1.9-4.4L-.7-2.6H.7L1.9-4.4L1.6-1.4C2.2.8 1.4 3.6 0 4.4C-1.4 3.6-2.2.8-1.6-1.4Z"/>' +
  '</svg>';

function scheduleBats(reducedMotion: () => boolean): void {
  const host = document.querySelector<HTMLElement>('.bats');
  if (!host) return;
  const flight = (): void => {
    const next = 16_000 + Math.random() * 22_000;
    setTimeout(flight, next);
    if (reducedMotion() || document.visibilityState !== 'visible' || document.documentElement.classList.contains('still')) return;
    const flock = Math.random() < 0.3 ? 2 + Math.floor(Math.random() * 2) : 1;
    const rtl = Math.random() < 0.5;
    const y = 6 + Math.random() * 24;
    for (let i = 0; i < flock; i++) {
      const bat = document.createElement('div');
      bat.className = `bat${rtl ? ' rtl' : ''}`;
      bat.style.setProperty('--y', `${(y + (i ? (Math.random() - 0.3) * 8 : 0)).toFixed(1)}vh`);
      bat.style.setProperty('--dur', `${(9 + Math.random() * 5).toFixed(1)}s`);
      bat.style.setProperty('--size', `${(18 + Math.random() * 14).toFixed(0)}px`);
      bat.style.setProperty('--bob', `${(0.9 + Math.random() * 0.8).toFixed(2)}s`);
      bat.style.animationDelay = `${(i * (0.25 + Math.random() * 0.5)).toFixed(2)}s`;
      bat.innerHTML = `<div class="bat-bob">${BAT_SVG}</div>`;
      bat.addEventListener('animationend', (e) => e.target === bat && bat.remove());
      host.append(bat);
    }
  };
  setTimeout(flight, 3500);
}
