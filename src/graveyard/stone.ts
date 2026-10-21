/**
 * Tombstones. Each grave gets a shape, a kind of stone, a tilt, moss and
 * cracks chosen deterministically from its id (older graves weather more),
 * and its face is drawn as SVG at its real size so curves never stretch.
 */
import { formatIdle, siteName } from '../shared/haunt';
import type { Grave } from '../shared/types';
import { el, faviconUrl } from '../shared/ui';
import { between, hashString, n1, pick, seeded, type Rand } from './rand';

export const SHAPES = ['round', 'shoulder', 'gothic', 'cross', 'obelisk', 'pediment', 'tablet'] as const;
export type Shape = (typeof SHAPES)[number];
const MATERIALS = ['granite', 'limestone', 'slate', 'marble'] as const;

/** Space reserved at the foot of each stone for the earth that covers it (px). */
export const GROUND = 18;

export interface Traits {
  seed: number;
  shape: Shape;
  material: (typeof MATERIALS)[number];
  tilt: number;
  sink: number;
  width: number;
  age: number;
  candleLeft: boolean;
}

export function traitsFor(g: Grave, now = Date.now()): Traits {
  const seed = hashString(g.id + '|' + g.url);
  const r = seeded(seed);
  const hours = (Math.max(0, g.idleMs) + Math.max(0, now - g.diedAt)) / 3_600_000;
  // 1 hour ≈ 0.1, a day ≈ 0.46, a week ≈ 0.74, a couple of months ≈ 1.
  const age = Math.min(1, Math.log10(1 + hours) / 3.2);
  const shape = pick(r, SHAPES);
  const material = pick(r, MATERIALS);
  // Everything leans a little; the old and unlucky lean a lot.
  const slanted = r() < 0.18 + age * 0.35;
  const dir = r() < 0.5 ? -1 : 1;
  const tilt = slanted ? dir * between(r, 2.2, 3.2 + age * 2) : between(r, -1.4, 1.4);
  return {
    seed,
    shape,
    material,
    tilt,
    sink: Math.round(between(r, 0, 3 + age * 7)),
    width: between(r, 0.88, 1),
    age,
    candleLeft: r() < 0.5,
  };
}

const dayFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const timeFmt = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

/** Build the DOM for one grave. Drawing the stone itself waits for layout (see drawStone). */
export function buildGrave(g: Grave, t: Traits): HTMLElement {
  const fav = el('img', { class: 'fav', src: faviconUrl(g.url, g.favIconUrl), alt: '', width: '18', height: '18', decoding: 'async' });
  const article = el(
    'article',
    {
      class: `grave stone shape-${t.shape} mat-${t.material}`,
      'data-id': g.id,
      'aria-label': g.title,
      style: `--tilt:${t.tilt.toFixed(2)}deg;--sink:${t.sink}px;--w:${t.width.toFixed(3)}`,
    },
    el(
      'div',
      { class: 'plot' },
      el(
        'div',
        { class: 'body' },
        el(
          'div',
          { class: 'carving' },
          svgEl('slab'),
          el(
            'div',
            { class: 'inscription' },
            el('p', { class: 'rip', text: g.cause === 'haunting' ? 'Here lies' : 'At rest' }),
            el('span', { class: 'inlay' }, fav),
            el('h2', { class: 'name', title: g.title, text: g.title }),
            el('a', { class: 'site', href: g.url, title: g.url, target: '_blank', rel: 'noreferrer', text: siteName(g.url) }),
            el('span', { class: 'rule', 'aria-hidden': 'true' }),
            el(
              'p',
              { class: 'epitaph' },
              el(
                'time',
                { class: 'died', datetime: new Date(g.diedAt).toISOString() },
                el('span', { text: `Died ${dayFmt.format(g.diedAt)}` }),
                el('span', { text: `at ${timeFmt.format(g.diedAt)}` }),
              ),
              el('span', { text: `Forgotten for ${formatIdle(g.idleMs)}` }),
              el('span', { class: 'cause', text: g.cause === 'haunting' ? 'Taken by the haunting' : 'Laid in the ground by you' }),
            ),
            el(
              'div',
              { class: 'actions' },
              el('button', { type: 'button', class: 'btn raise', 'data-action': 'resurrect', 'aria-label': `Resurrect ${g.title}` }, sparkIcon(), 'Resurrect'),
              el('button', { type: 'button', class: 'btn forget', 'data-action': 'forget', 'aria-label': `Lay ${g.title} to rest`, title: 'Remove this grave from the list', text: 'Lay to rest' }),
            ),
          ),
        ),
      ),
    ),
    svgEl('mound'),
    el('span', { class: `candle${t.candleLeft ? ' left' : ''}`, 'aria-hidden': 'true' }, el('i', { class: 'flame' })),
  );
  return article;
}

/** An unmarked stone for the empty yard. */
export function buildBlankStone(): HTMLElement {
  return el(
    'div',
    { class: 'grave blank shape-round mat-granite', style: '--tilt:-1.6deg;--sink:4px;--w:1', 'aria-hidden': 'true' },
    el('div', { class: 'plot' }, el('div', { class: 'body' }, el('div', { class: 'carving' }, svgEl('slab'), el('div', { class: 'inscription' })))),
    svgEl('mound'),
    el('span', { class: 'candle lit' }, el('i', { class: 'flame' })),
  );
}

function svgEl(cls: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

function sparkIcon(): SVGSVGElement {
  const svg = svgEl('spark');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.innerHTML = '<path d="M8 1.5l1.3 4.2L13.5 7 9.3 8.3 8 12.5 6.7 8.3 2.5 7l4.2-1.3z" fill="currentColor"/><circle cx="13" cy="12.5" r="1.1" fill="currentColor"/><circle cx="3.2" cy="2.8" r=".8" fill="currentColor"/>';
  return svg;
}

// ---------------------------------------------------------------- drawing

/** Cap height and text inset per shape, as fractions of the stone's width. Mirrors graveyard.css. */
const CAP: Record<Shape, number> = { round: 0.3, shoulder: 0.26, gothic: 0.6, cross: 0.4, obelisk: 0.22, pediment: 0.2, tablet: 0.08 };

/** The outline of a stone of a given shape, in px. */
export function outline(shape: Shape, w: number, h: number): string {
  const c = CAP[shape] * w;
  switch (shape) {
    case 'round':
      return `M0,${n1(h)}V${n1(c)}A${n1(w / 2)},${n1(c)} 0 0 1 ${n1(w)},${n1(c)}V${n1(h)}Z`;
    case 'shoulder': {
      const R = c;
      const k = w * 0.045;
      return `M0,${n1(h)}V${n1(R + k)}Q0,${n1(R)} ${n1(k)},${n1(R)}H${n1(w / 2 - R)}A${n1(R)},${n1(R)} 0 0 1 ${n1(w / 2 + R)},${n1(R)}H${n1(w - k)}Q${n1(w)},${n1(R)} ${n1(w)},${n1(R + k)}V${n1(h)}Z`;
    }
    case 'gothic': {
      const rho = w * 0.62;
      return `M0,${n1(h)}V${n1(c)}A${n1(rho)},${n1(rho)} 0 0 1 ${n1(w / 2)},0A${n1(rho)},${n1(rho)} 0 0 1 ${n1(w)},${n1(c)}V${n1(h)}Z`;
    }
    case 'cross': {
      const bw = w * 0.16; // bar width
      const arm = w * 0.25; // arm half-length
      const ay = w * 0.1; // arm top
      const k = w * 0.07; // body chamfer
      const x0 = w / 2 - bw / 2;
      const x1 = w / 2 + bw / 2;
      return (
        `M0,${n1(h)}V${n1(c + k)}L${n1(k)},${n1(c)}H${n1(x0)}V${n1(ay + bw)}H${n1(w / 2 - arm)}V${n1(ay)}H${n1(x0)}V0H${n1(x1)}V${n1(ay)}` +
        `H${n1(w / 2 + arm)}V${n1(ay + bw)}H${n1(x1)}V${n1(c)}H${n1(w - k)}L${n1(w)},${n1(c + k)}V${n1(h)}Z`
      );
    }
    case 'obelisk': {
      const ti = w * 0.15;
      const bi = w * 0.06;
      return `M${n1(bi)},${n1(h)}L${n1(ti)},${n1(c)}L${n1(w / 2)},0L${n1(w - ti)},${n1(c)}L${n1(w - bi)},${n1(h)}Z`;
    }
    case 'pediment': {
      const ledge = w * 0.05;
      const inset = w * 0.04;
      return `M${n1(inset)},${n1(h)}V${n1(c + ledge)}H0V${n1(c)}L${n1(w / 2)},${n1(w * 0.02)}L${n1(w)},${n1(c)}V${n1(c + ledge)}H${n1(w - inset)}V${n1(h)}Z`;
    }
    case 'tablet': {
      const k = w * 0.1;
      return `M0,${n1(h)}V${n1(k)}Q0,0 ${n1(k)},0H${n1(w - k)}Q${n1(w)},0 ${n1(w)},${n1(k)}V${n1(h)}Z`;
    }
  }
}

/** Where the top of the stone's outline is at a given x (roughly), for things that sit on its edge. */
function topEdge(shape: Shape, w: number, x: number): number {
  const c = CAP[shape] * w;
  const dx = x - w / 2;
  switch (shape) {
    case 'round':
      return c - c * Math.sqrt(Math.max(0, 1 - (dx / (w / 2)) ** 2));
    case 'shoulder':
      return Math.abs(dx) < c ? c - Math.sqrt(c * c - dx * dx) : c;
    case 'gothic': {
      const rho = w * 0.62;
      const ox = dx < 0 ? rho : w - rho;
      return c - Math.sqrt(Math.max(0, rho * rho - (x - ox) ** 2));
    }
    case 'pediment':
      return c - (c - w * 0.02) * (1 - Math.abs(dx) / (w / 2));
    case 'tablet':
      return 0;
    default:
      return c;
  }
}

/** The incised border panel inside the stone face: a path and how far it is shifted in. */
function panel(shape: Shape, w: number, h: number, sink: number): { d: string; shift: number } {
  const i = Math.max(7, w * 0.04);
  const bottom = h - GROUND - sink - 6;
  if (shape === 'cross') {
    const top = CAP.cross * w + i;
    return { d: `M${n1(i)},${n1(bottom)}V${n1(top)}H${n1(w - i)}V${n1(bottom)}Z`, shift: 0 };
  }
  if (shape === 'obelisk') {
    const c = CAP.obelisk * w;
    const edge = (y: number): number => w * 0.15 + (w * 0.06 - w * 0.15) * ((y - c) / (h - c));
    const top = c + i * 0.6;
    return {
      d: `M${n1(edge(bottom) + i)},${n1(bottom)}L${n1(edge(top) + i)},${n1(top)}H${n1(w - edge(top) - i)}L${n1(w - edge(bottom) - i)},${n1(bottom)}Z`,
      shift: 0,
    };
  }
  if (shape === 'pediment') {
    const top = CAP.pediment * w + w * 0.05 + i * 0.6;
    const x = w * 0.04 + i;
    return { d: `M${n1(x)},${n1(bottom)}V${n1(top)}H${n1(w - x)}V${n1(bottom)}Z`, shift: 0 };
  }
  return { d: outline(shape, w - i * 2, bottom - i), shift: i };
}

/** Random-walk cracks creeping in from the stone's edge. */
function cracks(r: Rand, w: number, h: number, count: number, capY: number): string {
  let d = '';
  for (let c = 0; c < count; c++) {
    const fromSide = r() < 0.6;
    const left = r() < 0.5;
    let x = fromSide ? (left ? 1 : w - 1) : between(r, w * 0.3, w * 0.7);
    let y = fromSide ? between(r, capY + 10, h * 0.7) : capY * 0.15 + 2;
    let ang = fromSide ? (left ? 0 : Math.PI) + between(r, -0.6, 0.6) : Math.PI / 2 + between(r, -0.5, 0.5);
    const steps = 3 + Math.floor(r() * 4);
    d += `M${n1(x)},${n1(y)}`;
    const branchAt = 1 + Math.floor(r() * 2);
    let bx = 0;
    let by = 0;
    let bang = 0;
    for (let s = 0; s < steps; s++) {
      ang += between(r, -0.6, 0.6);
      const len = w * between(r, 0.03, 0.07);
      x += Math.cos(ang) * len;
      y += Math.sin(ang) * len;
      d += `L${n1(x)},${n1(y)}`;
      if (s === branchAt) {
        bx = x;
        by = y;
        bang = ang + (r() < 0.5 ? -1 : 1) * between(r, 0.5, 1);
      }
    }
    if (bx) {
      d += `M${n1(bx)},${n1(by)}`;
      for (let s = 0; s < 2; s++) {
        bang += between(r, -0.5, 0.5);
        bx += Math.cos(bang) * w * 0.035;
        by += Math.sin(bang) * w * 0.035;
        d += `L${n1(bx)},${n1(by)}`;
      }
    }
  }
  return d;
}

/** A soft irregular blob (for moss), smoothed through Catmull-Rom points. */
function blob(r: Rand, cx: number, cy: number, rad: number): string {
  const n = 12;
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = between(r, 0.6, 1.15);
    pts.push([cx + Math.cos(a) * rad * k, cy + Math.sin(a) * rad * k * 0.7]);
  }
  let d = `M${n1(pts[0][0])},${n1(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    d += `C${n1(p1[0] + (p2[0] - p0[0]) / 6)},${n1(p1[1] + (p2[1] - p0[1]) / 6)} ${n1(p2[0] - (p3[0] - p1[0]) / 6)},${n1(p2[1] - (p3[1] - p1[1]) / 6)} ${n1(p2[0])},${n1(p2[1])}`;
  }
  return d + 'Z';
}

let clipSeq = 0;

/** Draw (or redraw, after a resize) the stone face and its mound of earth. */
export function drawStone(grave: HTMLElement, t: Traits): void {
  const carving = grave.querySelector<HTMLElement>('.carving');
  const slab = grave.querySelector<SVGSVGElement>('svg.slab');
  const mound = grave.querySelector<SVGSVGElement>('svg.mound');
  if (!carving || !slab || !mound) return;
  const w = Math.round(carving.offsetWidth);
  const h = Math.round(carving.offsetHeight);
  if (!w || !h) return;
  const key = `${w}x${h}`;
  if (slab.dataset.size === key) return;
  slab.dataset.size = key;

  const r = seeded(t.seed ^ 0x51ab);
  const id = slab.dataset.clip || `sc${++clipSeq}`;
  slab.dataset.clip = id;
  const d = outline(t.shape, w, h);
  const capY = CAP[t.shape] * w;

  // Moss creeps up from the lower corners, and onto the top of older stones.
  let moss = '';
  let speck = '';
  const mossy = 0.25 + t.age * 0.75;
  const corners = 1 + Math.floor(r() * 2 + t.age * 1.5);
  const firstLeft = r() < 0.5;
  for (let i = 0; i < corners; i++) {
    const left = i % 2 === 0 ? firstLeft : !firstLeft;
    const cx = left ? between(r, 0, w * 0.18) : between(r, w * 0.82, w);
    const cy = h - GROUND - t.sink - between(r, 0, 14);
    const rad = w * between(r, 0.08, 0.16) * mossy;
    moss += blob(r, cx, cy, rad);
    for (let k = 0; k < 10; k++) {
      const a = r() * Math.PI * 2;
      const dist = rad * between(r, 0.9, 1.9);
      speck += `M${n1(cx + Math.cos(a) * dist)},${n1(cy + Math.sin(a) * dist * 0.8)}h1.4v1.4h-1.4Z`;
    }
  }
  if (t.age > 0.35 && r() < 0.4 + t.age * 0.5) {
    // A cushion of moss on the stone's upper edge, half hanging over it.
    const cx = r() < 0.5 ? w * between(r, 0.12, 0.26) : w * between(r, 0.74, 0.88);
    const rad = w * between(r, 0.05, 0.08);
    moss += blob(r, cx, topEdge(t.shape, w, cx) + rad * 0.25, rad);
  }
  // Pale lichen dots.
  let lichen = '';
  for (let i = 0; i < 6 + t.age * 14; i++) {
    const lx = r() < 0.5 ? between(r, 4, w * 0.22) : between(r, w * 0.78, w - 4);
    const ly = between(r, capY * 0.4, h - GROUND);
    lichen += `M${n1(lx)},${n1(ly)}m-1.3,0a1.3,1.1 0 1 0 2.6,0a1.3,1.1 0 1 0 -2.6,0`;
  }
  const crackPath = cracks(r, w, h, Math.round(between(r, 0, 1.2) + t.age * 2.2), capY);

  // Marble has faint veins.
  let veins = '';
  if (t.material === 'marble') {
    for (let v = 0; v < 3; v++) {
      let vx = between(r, -w * 0.1, w * 0.6);
      let vy = between(r, 0, h);
      veins += `M${n1(vx)},${n1(vy)}`;
      for (let s = 0; s < 6; s++) {
        vx += w * between(r, 0.08, 0.18);
        vy += between(r, -h * 0.06, h * 0.05);
        veins += `L${n1(vx)},${n1(vy)}`;
      }
    }
  }

  const pnl = panel(t.shape, w, h, t.sink);
  // Rain has run down the face for years, leaving darker streaks.
  let streaks = '';
  for (let i = 0; i < 2 + Math.round(t.age * 5); i++) {
    const sw = between(r, 2, 9);
    const sx = between(r, 0, w - sw);
    streaks += `<rect x="${n1(sx)}" y="${n1(capY * between(r, 0, 0.6))}" width="${n1(sw)}" height="${n1(h * between(r, 0.2, 0.55))}" rx="${n1(sw / 2)}" fill="url(#streak)" opacity="${between(r, 0.3, 0.7).toFixed(2)}"/>`;
  }
  const facets =
    t.shape === 'obelisk'
      ? `<path d="M${n1(w / 2)},0L${n1(w * 0.15)},${n1(capY)}H${n1(w / 2)}Z" fill="#000" opacity=".16"/><rect x="${n1(w / 2)}" y="${n1(capY)}" width="${n1(w / 2)}" height="${n1(h)}" fill="#fff" opacity=".05"/>`
      : t.shape === 'pediment'
        ? `<path d="M0,${n1(capY)}L${n1(w / 2)},${n1(w * 0.02)}L${n1(w)},${n1(capY)}Z" fill="#000" opacity=".08"/><rect y="${n1(capY)}" width="${w}" height="${n1(w * 0.05)}" fill="#fff" opacity=".1"/>`
        : '';

  slab.setAttribute('viewBox', `0 0 ${w} ${h}`);
  slab.innerHTML =
    `<defs><clipPath id="${id}"><path d="${d}"/></clipPath></defs>` +
    `<path d="${d}" fill="url(#mat-${t.material})"/>` +
    `<g clip-path="url(#${id})">` +
    `<rect width="${w}" height="${h}" fill="url(#mottle)" class="mottle"/>` +
    `<rect width="${w}" height="${h}" fill="url(#moonlit)"/>` +
    facets +
    (veins ? `<path d="${veins}" fill="none" stroke="#6f6e78" stroke-opacity=".22" stroke-width="1.2"/>` : '') +
    `<rect y="${n1(h * 0.55)}" width="${w}" height="${n1(h * 0.45)}" fill="url(#damp)"/>` +
    streaks +
    `<rect width="${w}" height="${h}" fill="url(#edge-shade)"/>` +
    `<path d="${lichen}" fill="#c9c79a" fill-opacity=".28"/>` +
    `<path d="${moss}" fill="url(#moss)"/>` +
    `<path d="${speck}" fill="#56703a" fill-opacity=".75"/>` +
    `<rect width="${w}" height="${h}" fill="url(#grain)" class="grain"/>` +
    `<path d="${pnl.d}" transform="translate(${n1(pnl.shift + 0.6)} ${n1(pnl.shift + 1.2)})" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="1"/>` +
    `<path d="${pnl.d}" transform="translate(${n1(pnl.shift)} ${n1(pnl.shift)})" fill="none" stroke="#000" stroke-opacity=".32" stroke-width="1.2"/>` +
    (crackPath
      ? `<path d="${crackPath}" fill="none" stroke="#fff" stroke-opacity=".2" stroke-width="1" transform="translate(.6 1)"/><path d="${crackPath}" fill="none" stroke="#1a1b20" stroke-opacity=".7" stroke-width="1.1" stroke-linejoin="round"/>`
      : '') +
    `<path d="${d}" fill="none" stroke="#000" stroke-opacity=".16" stroke-width="12"/>` +
    `<path d="${d}" fill="none" stroke="#000" stroke-opacity=".3" stroke-width="4"/>` +
    `<path d="${d}" fill="none" stroke="#eef2ff" stroke-opacity=".45" stroke-width="2.2" transform="translate(-1.2 1.4)"/>` +
    `<rect width="${w}" height="${h}" fill="url(#candlelight-${t.candleLeft ? 'l' : 'r'})" class="candlelight"/>` +
    `<rect width="${w}" height="${h}" fill="url(#spirit)" class="spiritlight"/>` +
    `</g>`;

  drawMound(mound, t, w);
  grave.style.setProperty('--rise', `${h + 12}px`);
}

function drawMound(svg: SVGSVGElement, t: Traits, faceW: number): void {
  const r = seeded(t.seed ^ 0x9e37);
  const W = Math.round(faceW * 1.7);
  const H = 52;
  const crest = 6;
  const cx = W / 2;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.style.width = `${W}px`;
  const hump = `M0,${H}C${n1(W * 0.16)},${H} ${n1(W * 0.2)},${crest + 4} ${n1(cx)},${crest}C${n1(W * 0.8)},${crest + 4} ${n1(W * 0.84)},${H} ${W},${H}Z`;
  const crestY = (x: number): number => {
    // Approximate the hump's top edge for placing grass and pebbles.
    const u = Math.abs(x - cx) / (W / 2);
    return crest + (H - crest) * Math.pow(u, 2.2);
  };
  // Grass: fresher graves are bare earth, old ones are overgrown.
  const blades = Math.round((W / 3) * (0.35 + t.age * 0.9));
  const fills = ['', '', ''];
  for (let i = 0; i < blades; i++) {
    const x = between(r, W * 0.06, W * 0.94);
    const y = crestY(x) + between(r, 0, 4);
    const len = between(r, 3, 9 + t.age * 7) * (1 - Math.abs(x - cx) / W);
    const lean = between(r, -0.6, 0.6) * len;
    const k = x > cx + faceW * 0.2 ? 2 : r() < 0.5 ? 0 : 1;
    fills[k] += `M${n1(x - 1.1)},${n1(y)}Q${n1(x + lean * 0.4)},${n1(y - len * 0.6)} ${n1(x + lean)},${n1(y - len)}Q${n1(x + lean * 0.3 + 0.6)},${n1(y - len * 0.5)} ${n1(x + 1.1)},${n1(y)}Z`;
  }
  let pebbles = '';
  for (let i = 0; i < 4 + Math.floor(r() * 4); i++) {
    const x = between(r, W * 0.12, W * 0.88);
    const y = crestY(x) + between(r, 6, 16);
    const rr = between(r, 1.2, 2.8);
    pebbles += `M${n1(x - rr)},${n1(y)}a${n1(rr)},${n1(rr * 0.7)} 0 1 0 ${n1(rr * 2)},0a${n1(rr)},${n1(rr * 0.7)} 0 1 0 ${n1(-rr * 2)},0`;
  }
  svg.innerHTML =
    `<ellipse cx="${n1(cx)}" cy="${H - 8}" rx="${n1(W * 0.62)}" ry="20" fill="url(#turf)"/>` +
    `<ellipse class="warmth" cx="${n1(cx)}" cy="${n1(crest + 10)}" rx="${n1(W * 0.42)}" ry="16" fill="url(#candleground)"/>` +
    `<path d="${hump}" fill="url(#earth)"/>` +
    `<ellipse cx="${n1(cx - faceW * 0.12)}" cy="${n1(crest + 6)}" rx="${n1(faceW * 0.5)}" ry="6" fill="#000" opacity=".35"/>` +
    `<path d="${pebbles}" fill="#4a4038" opacity=".8"/>` +
    `<path d="${fills[0]}" fill="#1f2b18"/><path d="${fills[1]}" fill="#2a3a20"/><path d="${fills[2]}" fill="#3d5230"/>`;
}
