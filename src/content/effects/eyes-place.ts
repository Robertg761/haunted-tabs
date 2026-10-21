// Where can something hide and watch? A look at the viewport, done in idle time
// and in small slices: hit-test a grid, mark the line boxes of real text,
// controls, media, scrollbars and fixed page chrome as taken, and boxes with
// their own background as off limits for the eyes. Candidates are then
// re-checked densely before they are used. If nowhere is truly empty, there is
// no spot: the eyes never open over the page's content.

import { OUR_ATTR, type Area } from './overlay';

const CELL = 16;
const MAX_ELEMENTS = 1200;
const INTERACTIVE =
  'a[href],button,input,select,textarea,label,summary,details,video,audio,iframe,[role="button"],[role="link"],[role="textbox"],[role="slider"],[role="tab"],[role="menuitem"],[contenteditable=""],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
const MEDIA = new Set(['IMG', 'PICTURE', 'VIDEO', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'svg', 'SVG']);

export interface Rect {
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface Spot {
  x: number;
  y: number;
  /** Eye width in CSS px. */
  w: number;
}

export interface PlaceOptions {
  /** Preferred eye width; smaller ones are tried when space is short. */
  baseW: number;
  cursorX: number;
  cursorY: number;
  /** How hard to keep away from the cursor: firmly from a real one, loosely from a guess. */
  cursorR: number;
  cursorWeight: number;
  /** Spots to stay away from (where the eyes were, the other pair). */
  avoid: { x: number; y: number; r: number }[];
  /** Prefer to be far from this (the other pair). */
  far?: { x: number; y: number };
  rand: () => number;
}

/** Eye box, dense core of the darkness, and its faint tail, in eye widths around the spot. */
export const EYE_BOX = { x: 1.95, y: 0.5, pad: 10 };
export const CORE_BOX = { x: 2.2, y: 0.7 };
export const TAIL_BOX = { x: 2.9, y: 1.4 };
/** How far the visible darkness reaches; it must not be cut off by the window. */
export const POOL_REACH = { x: 2.75, up: 1.05, down: 1.35 };

/** The visible viewport, without scrollbars. */
export function viewportSize(): { vw: number; vh: number } {
  const de = document.documentElement;
  const vw = Math.min(innerWidth, de.clientWidth || innerWidth);
  const vh = Math.min(innerHeight, de.clientHeight || innerHeight);
  return { vw: Math.max(1, vw), vh: Math.max(1, vh) };
}

/** An incremental scan of what is on screen. Every layout read happens in here. */
export class Scan {
  readonly vw: number;
  readonly vh: number;
  readonly sx = scrollX;
  readonly sy = scrollY;
  readonly at = performance.now();
  readonly cols: number;
  readonly rows: number;
  /** Fixed and sticky page chrome, in viewport coordinates at scan time. */
  readonly pinned: Rect[] = [];
  private readonly hard: Uint8Array;
  private readonly soft: Uint8Array;
  private hardSum: Int32Array | null = null;
  private softSum: Int32Array | null = null;
  private readonly step: number;
  private readonly nx: number;
  private readonly ny: number;
  private i = 0;
  private extra: number[] = [];
  private e = 0;
  private readonly seen = new Set<Element>();
  private readonly pinnedOf = new Map<Element, Element | null>();
  private readonly scrollers = new Set<Element>();
  private readonly range = document.createRange();
  private readonly area: number;

  constructor() {
    const { vw, vh } = viewportSize();
    this.vw = vw;
    this.vh = vh;
    this.area = vw * vh;
    this.cols = Math.ceil(vw / CELL);
    this.rows = Math.ceil(vh / CELL);
    this.hard = new Uint8Array(this.cols * this.rows);
    this.soft = new Uint8Array(this.cols * this.rows);
    // Coarser on big screens so the scan costs about the same everywhere.
    this.step = Math.min(44, Math.max(24, Math.round(Math.sqrt(this.area / 1300))));
    this.nx = Math.ceil(vw / this.step);
    this.ny = Math.ceil(vh / this.step);
  }

  /** Still matches what is on screen? */
  fresh(maxAge: number): boolean {
    const { vw, vh } = viewportSize();
    return vw === this.vw && vh === this.vh && scrollX === this.sx && scrollY === this.sy && performance.now() - this.at < maxAge;
  }

  /** Work until `deadline` (performance.now() ms). True once everything queued is done. */
  run(deadline: number): boolean {
    const total = this.nx * this.ny;
    while (this.i < total) {
      if ((this.i & 3) === 0 && performance.now() > deadline) return false;
      const gx = this.i % this.nx;
      const gy = (this.i / this.nx) | 0;
      this.i++;
      this.sample((gx + 0.5) * this.step, (gy + 0.5) * this.step);
      if (this.seen.size > MAX_ELEMENTS) {
        // Too much to look at: whatever was not looked at counts as taken.
        const r0 = Math.max(0, Math.floor((gy * this.step) / CELL));
        this.hard.fill(1, r0 * this.cols);
        this.i = total;
        this.extra.length = 0;
      }
    }
    while (this.e < this.extra.length) {
      if ((this.e & 7) === 0 && performance.now() > deadline) return false;
      this.sample(this.extra[this.e], this.extra[this.e + 1]);
      this.e += 2;
    }
    this.hardSum = summed(this.hard, this.cols, this.rows);
    this.softSum = summed(this.soft, this.cols, this.rows);
    return true;
  }

  /** Other creatures' ground (a web, a drip's column): as good as content. */
  block(areas: Area[]): void {
    for (const a of areas) this.mark(a.x, a.y, a.x + a.w, a.y + a.h, 8, this.hard);
  }

  /** Queue a dense re-check of a rect (sub-grid sized things like icons and short links). */
  densify(x0: number, y0: number, x1: number, y1: number, step: number): void {
    for (let y = Math.max(1, y0); y < Math.min(this.vh - 1, y1); y += step) {
      for (let x = Math.max(1, x0); x < Math.min(this.vw - 1, x1); x += step) this.extra.push(x, y);
    }
  }

  /** Taken cells inside a rect, from the hard (content) or soft (decorated boxes) layer. */
  count(soft: boolean, x0: number, y0: number, x1: number, y1: number): number {
    const s = soft ? this.softSum : this.hardSum;
    if (!s) return Infinity;
    const W = this.cols + 1;
    const c0 = Math.max(0, Math.floor(x0 / CELL));
    const c1 = Math.min(this.cols, Math.ceil(x1 / CELL));
    const r0 = Math.max(0, Math.floor(y0 / CELL));
    const r1 = Math.min(this.rows, Math.ceil(y1 / CELL));
    if (c1 <= c0 || r1 <= r0) return 0;
    return s[r1 * W + c1] - s[r0 * W + c1] - s[r1 * W + c0] + s[r0 * W + c0];
  }

  fraction(soft: boolean, x0: number, y0: number, x1: number, y1: number): number {
    const cells = Math.max(1, ((x1 - x0) / CELL) * ((y1 - y0) / CELL));
    return Math.min(1, this.count(soft, x0, y0, x1, y1) / cells);
  }

  /** How far the cell at (x, y) is from the nearest taken cell, in px (capped). */
  room(x: number, y: number, max: number): number {
    for (let d = CELL; d < max; d += CELL) {
      if (this.count(false, x - d, y - d, x + d, y + d) > 0) return d - CELL;
    }
    return max;
  }

  /** The scrolling element that would carry a spot along, or null for the page itself. */
  anchorAt(x: number, y: number): Element | null {
    for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) {
      if (this.scrollers.has(el)) return el;
    }
    return null;
  }

  private sample(x: number, y: number): void {
    const ci = Math.min(this.rows - 1, Math.floor(y / CELL)) * this.cols + Math.min(this.cols - 1, Math.floor(x / CELL));
    if (this.hard[ci]) return;
    const el = document.elementFromPoint(x, y);
    if (el) this.probe(el);
  }

  private mark(left: number, top: number, right: number, bottom: number, pad: number, into: Uint8Array): void {
    const { vw, vh, cols, rows } = this;
    if (right < -pad || bottom < -pad || left > vw + pad || top > vh + pad || right <= left || bottom <= top) return;
    const c0 = Math.max(0, Math.floor((left - pad) / CELL));
    const c1 = Math.min(cols - 1, Math.floor((right + pad) / CELL));
    const r0 = Math.max(0, Math.floor((top - pad) / CELL));
    const r1 = Math.min(rows - 1, Math.floor((bottom + pad) / CELL));
    for (let r = r0; r <= r1; r++) into.fill(1, r * cols + c0, r * cols + c1 + 1);
  }

  /** Mark an element's box, unless it is so big it is really a layout shell (an app root, a focusable <main>). */
  private markEl(el: Element, pad: number, into: Uint8Array, maxShare: number): boolean {
    const r = el.getBoundingClientRect();
    if (r.width * r.height > this.area * maxShare) return false;
    this.mark(r.left, r.top, r.right, r.bottom, pad, into);
    return true;
  }

  /** The nearest fixed or sticky ancestor. Scrollable ancestors met on the way get their scrollbars blocked. */
  private pinnedAncestor(el: Element): Element | null {
    const root = document.documentElement;
    const body = document.body;
    const path: Element[] = [];
    let found: Element | null = null;
    for (let cur: Element | null = el; cur && cur !== body && cur !== root; cur = cur.parentElement) {
      const cached = this.pinnedOf.get(cur);
      if (cached !== undefined) {
        found = cached;
        break;
      }
      path.push(cur);
      const cs = getComputedStyle(cur);
      this.scrollbars(cur, cs);
      if (cs.position === 'fixed' || cs.position === 'sticky') {
        found = cur;
        break;
      }
    }
    for (const p of path) this.pinnedOf.set(p, found);
    return found;
  }

  private scrollbars(el: Element, cs: CSSStyleDeclaration): void {
    const scrollY = /auto|scroll|overlay/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
    const scrollX = /auto|scroll|overlay/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
    if (!scrollY && !scrollX) return;
    this.scrollers.add(el);
    const r = el.getBoundingClientRect();
    const h = el as HTMLElement;
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0;
    const bb = parseFloat(cs.borderBottomWidth) || 0;
    // Overlay scrollbars measure 0 but still appear while scrolling.
    if (scrollY) {
      const sb = Math.max(14, (h.offsetWidth || 0) - el.clientWidth - bl - br);
      this.mark(r.right - br - sb, r.top, r.right, r.bottom, 8, this.hard);
    }
    if (scrollX) {
      const sb = Math.max(14, (h.offsetHeight || 0) - el.clientHeight - bb - (parseFloat(cs.borderTopWidth) || 0));
      this.mark(r.left, r.bottom - bb - sb, r.right, r.bottom, 8, this.hard);
    }
  }

  private probe(el: Element): void {
    if (this.seen.has(el)) return;
    this.seen.add(el);
    const root = document.documentElement;
    if (el === root || el === document.body || el.closest(`[${OUR_ATTR}]`)) return;

    const fixed = this.pinnedAncestor(el);
    if (fixed) {
      const r = fixed.getBoundingClientRect();
      if (r.width * r.height <= this.area * 0.4) {
        this.mark(r.left, r.top, r.right, r.bottom, 18, this.hard);
        this.pinned.push({ l: r.left - 18, t: r.top - 18, r: r.right + 18, b: r.bottom + 18 });
        return;
      }
    }
    const control = el.closest(INTERACTIVE);
    if (control && this.markEl(control, 14, this.hard, 0.3)) return;
    if ((MEDIA.has(el.tagName) || el instanceof SVGElement) && this.markEl(el, 12, this.hard, 0.6)) return;
    let texts = 0;
    for (let n = el.firstChild; n && texts < 200; n = n.nextSibling) {
      if (n.nodeType !== Node.TEXT_NODE || !/\S/.test((n as Text).data)) continue;
      texts++;
      this.range.selectNodeContents(n);
      const rects = this.range.getClientRects();
      for (let i = 0; i < rects.length; i++) this.mark(rects[i].left, rects[i].top, rects[i].right, rects[i].bottom, 12, this.hard);
    }
    // A box with its own background, picture or border (a banner, a card, an
    // infobox, a table cell, a header ruled off below) is no place for eyes;
    // darkness spilling onto it is avoided too. A picture is content even when
    // it is big (a poster, a player, a photo). A backdrop bigger than that
    // (a hero, a sidebar) may hold the eyes, but not across its edge: darkness
    // straddling the line between two colours looks like a smudge.
    const cs = getComputedStyle(el);
    const pictured = cs.backgroundImage !== 'none';
    const painted =
      pictured ||
      alphaOf(cs.backgroundColor) > 0.05 ||
      parseFloat(cs.borderTopWidth) > 0 ||
      parseFloat(cs.borderRightWidth) > 0 ||
      parseFloat(cs.borderBottomWidth) > 0 ||
      parseFloat(cs.borderLeftWidth) > 0;
    if (!painted) return;
    const r = el.getBoundingClientRect();
    const share = (r.width * r.height) / this.area;
    if (share < 0.3 || (pictured && share < 0.6)) {
      this.mark(r.left, r.top, r.right, r.bottom, 8, this.soft);
    } else {
      this.mark(r.left, r.top, r.right, r.top + 1, 12, this.soft);
      this.mark(r.left, r.bottom - 1, r.right, r.bottom, 12, this.soft);
      this.mark(r.left, r.top, r.left + 1, r.bottom, 12, this.soft);
      this.mark(r.right - 1, r.top, r.right, r.bottom, 12, this.soft);
    }
  }
}

/**
 * Every place the eyes could open, best first, a few eye widths apart. Hard
 * rules: the eyes sit on nothing at all, the core of the darkness covers no
 * content, and the darkness is not cut off by the window. Empty if nowhere fits.
 * Runs in slices, one row at a time, so it never holds up the page.
 */
export class Search {
  result: Spot[] = [];
  private readonly scales: number[];
  private si = 0;
  private row = 0;
  private readonly found: { x: number; y: number; w: number; s: number }[] = [];

  constructor(
    private readonly scan: Scan,
    private readonly o: PlaceOptions,
    private readonly max = 4,
  ) {
    this.scales = [1.15, 1, 0.85, 0.72, 0.6].map((k) => Math.max(22, o.baseW * k));
  }

  run(deadline: number): boolean {
    const { scan, o } = this;
    const { vw, vh } = scan;
    while (this.si < this.scales.length) {
      if (performance.now() > deadline) return false;
      const w = this.scales[this.si];
      const r = this.row;
      if (++this.row >= scan.rows) {
        this.row = 0;
        this.si++;
      }
      const ehx = EYE_BOX.x * w + EYE_BOX.pad;
      const ehy = EYE_BOX.y * w + EYE_BOX.pad;
      const chx = CORE_BOX.x * w;
      const chy = CORE_BOX.y * w;
      const thx = TAIL_BOX.x * w;
      const thy = TAIL_BOX.y * w;
      const cy = (r + 0.5) * CELL;
      if (cy - POOL_REACH.up * w < 12 || cy + POOL_REACH.down * w > vh - 12) continue;
      for (let c = 0; c < scan.cols; c++) {
        const cx = (c + 0.5) * CELL;
        if (cx - POOL_REACH.x * w < 12 || cx + POOL_REACH.x * w > vw - 12) continue;
        if (scan.count(false, cx - ehx, cy - ehy, cx + ehx, cy + ehy) > 0) continue;
        if (scan.count(true, cx - ehx, cy - ehy, cx + ehx, cy + ehy) > 0) continue;
        if (scan.count(false, cx - chx, cy - chy, cx + chx, cy + chy) > 0) continue;
        const tailHard = scan.fraction(false, cx - thx, cy - thy, cx + thx, cy + thy);
        const tailSoft = scan.fraction(true, cx - thx, cy - thy, cx + thx, cy + thy);
        // Breathing room around the darkness, so it never sits jammed against a heading.
        const halo = scan.fraction(false, cx - chx - 0.5 * w, cy - chy - 0.45 * w, cx + chx + 0.5 * w, cy + chy + 0.45 * w);
        let s = w * 2.2 - tailHard * 320 - tailSoft * 160 - halo * 600;
        s += (Math.abs(cx - vw / 2) / (vw / 2)) * 35;
        s -= (Math.abs(cy - vh * 0.48) / vh) * 50;
        const dc = Math.hypot(cx - o.cursorX, cy - o.cursorY);
        s += dc < o.cursorR ? -(o.cursorR - dc) * o.cursorWeight : Math.min(dc, 900) * 0.04;
        for (const a of o.avoid) {
          const d = Math.hypot(cx - a.x, cy - a.y);
          if (d < a.r) s -= (a.r - d) * 1.4;
        }
        if (o.far) s += Math.min(Math.hypot(cx - o.far.x, cy - o.far.y), 900) * 0.12;
        this.found.push({ x: cx, y: cy, w, s: s + o.rand() * 20 });
      }
    }
    // Room to breathe is the costliest term, so it only ranks the leaders.
    const found = this.found;
    found.sort((a, b) => b.s - a.s);
    const lead = found.slice(0, 40);
    for (const f of lead) {
      // The window edge is a wall too: darkness hugging it looks cut off.
      const edge = (Math.min(f.x, vw - f.x) - POOL_REACH.x * f.w) * 2.5;
      f.s += Math.max(0, Math.min(scan.room(f.x, f.y, 240), edge, 240)) * 0.5;
    }
    lead.sort((a, b) => b.s - a.s);
    for (const f of lead) {
      if (this.result.some((p) => Math.hypot(p.x - f.x, p.y - f.y) < 2.5 * Math.max(p.w, f.w))) continue;
      this.result.push({ x: f.x, y: f.y, w: f.w });
      if (this.result.length >= this.max) break;
    }
    found.length = 0;
    return true;
  }
}

/** Re-check a candidate after densify() has run. */
export function stillFree(scan: Scan, s: Spot): boolean {
  const ehx = EYE_BOX.x * s.w + EYE_BOX.pad;
  const ehy = EYE_BOX.y * s.w + EYE_BOX.pad;
  const chx = CORE_BOX.x * s.w;
  const chy = CORE_BOX.y * s.w;
  return (
    scan.count(false, s.x - ehx, s.y - ehy, s.x + ehx, s.y + ehy) === 0 &&
    scan.count(true, s.x - ehx, s.y - ehy, s.x + ehx, s.y + ehy) === 0 &&
    scan.count(false, s.x - chx, s.y - chy, s.x + chx, s.y + chy) === 0
  );
}

/** Queue the dense check for a candidate: every 8px over the eyes and the core of the darkness. */
export function densifySpot(scan: Scan, s: Spot): void {
  const ehx = EYE_BOX.x * s.w + EYE_BOX.pad;
  const ehy = EYE_BOX.y * s.w + EYE_BOX.pad;
  scan.densify(s.x - ehx, s.y - ehy, s.x + ehx, s.y + ehy, 8);
  scan.densify(s.x - CORE_BOX.x * s.w, s.y - CORE_BOX.y * s.w, s.x + CORE_BOX.x * s.w, s.y + CORE_BOX.y * s.w, 10);
}

/** Is the page behind this point dark? Used to decide how deep the darkness must be to read. */
export function pageIsDark(x: number, y: number): boolean {
  let el: Element | null = document.elementFromPoint(x, y);
  while (el) {
    if (!el.closest(`[${OUR_ATTR}]`)) {
      const rgb = parseColor(getComputedStyle(el).backgroundColor);
      if (rgb && rgb[3] > 0.4) return luminance(rgb) < 0.36;
    }
    el = el.parentElement;
  }
  for (const node of [document.body, document.documentElement]) {
    if (!node) continue;
    const rgb = parseColor(getComputedStyle(node).backgroundColor);
    if (rgb && rgb[3] > 0.4) return luminance(rgb) < 0.36;
  }
  return matchMedia('(prefers-color-scheme: dark)').matches && getComputedStyle(document.documentElement).colorScheme.includes('dark');
}

function parseColor(s: string): [number, number, number, number] | null {
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
  if (p.length < 3) return null;
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}

function alphaOf(s: string): number {
  return parseColor(s)?.[3] ?? 0;
}

function luminance([r, g, b]: [number, number, number, number]): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function summed(cells: Uint8Array, cols: number, rows: number): Int32Array {
  const s = new Int32Array((cols + 1) * (rows + 1));
  for (let r = 0; r < rows; r++) {
    let run = 0;
    for (let c = 0; c < cols; c++) {
      run += cells[r * cols + c];
      s[(r + 1) * (cols + 1) + c + 1] = s[r * (cols + 1) + c + 1] + run;
    }
  }
  return s;
}
