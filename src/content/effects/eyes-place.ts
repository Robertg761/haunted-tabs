// Where can something hide and watch? A cheap, one-off look at the viewport:
// hit-test a coarse grid, mark the line boxes of real text, controls, media and
// fixed page chrome as taken, and pick the emptiest spot that leaves the reader
// alone. Runs only when the eyes are about to open somewhere, never per frame.

import { OUR_ATTR } from './overlay';

const CELL = 16;
const SAMPLE_STEP = 30;
const MAX_ELEMENTS = 450;
const INTERACTIVE =
  'a[href],button,input,select,textarea,label,summary,details,video,audio,iframe,[role="button"],[role="link"],[role="textbox"],[role="slider"],[role="tab"],[role="menuitem"],[contenteditable=""],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
const MEDIA = new Set(['IMG', 'PICTURE', 'VIDEO', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'svg', 'SVG']);

export interface FreeMap {
  cols: number;
  rows: number;
  vw: number;
  vh: number;
  /** Summed-area tables (cols+1 by rows+1) of hard (text, controls) and soft (decorated boxes) cells. */
  hard: Int32Array;
  soft: Int32Array;
  /** Distance in px from each cell to the nearest hard cell. */
  clear: Float32Array;
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
  /** Where the reader probably is (the cursor, or the middle of the page). */
  cursorX: number;
  cursorY: number;
  /** How hard to keep away from it: firmly from a real cursor, loosely from a guess. */
  cursorR: number;
  cursorWeight: number;
  /** Spots to stay away from (where the eyes were, the other pair). */
  avoid: { x: number; y: number; r: number }[];
  /** Prefer to be far from these (the other pair). */
  far?: { x: number; y: number };
  rand: () => number;
}

/** Look at what is on screen right now. Layout reads happen here, once. */
export function scanViewport(): FreeMap {
  const vw = Math.max(1, innerWidth);
  const vh = Math.max(1, innerHeight);
  const cols = Math.ceil(vw / CELL);
  const rows = Math.ceil(vh / CELL);
  const hardCells = new Uint8Array(cols * rows);
  const softCells = new Uint8Array(cols * rows);
  const area = vw * vh;

  const mark = (left: number, top: number, right: number, bottom: number, pad: number, into: Uint8Array) => {
    if (right < -pad || bottom < -pad || left > vw + pad || top > vh + pad || right <= left || bottom <= top) return;
    const c0 = Math.max(0, Math.floor((left - pad) / CELL));
    const c1 = Math.min(cols - 1, Math.floor((right + pad) / CELL));
    const r0 = Math.max(0, Math.floor((top - pad) / CELL));
    const r1 = Math.min(rows - 1, Math.floor((bottom + pad) / CELL));
    for (let r = r0; r <= r1; r++) into.fill(1, r * cols + c0, r * cols + c1 + 1);
  };
  /** Mark an element's box, unless it is so big it is really a layout shell (an app root, a focusable <main>). */
  const markEl = (el: Element, pad: number, into: Uint8Array, maxShare: number): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width * r.height > area * maxShare) return false;
    mark(r.left, r.top, r.right, r.bottom, pad, into);
    return true;
  };

  const seen = new Set<Element>();
  const pinned = new Map<Element, Element | null>();
  const range = document.createRange();
  const root = document.documentElement;
  const body = document.body;

  /** The nearest fixed or sticky ancestor: page chrome that never scrolls away. */
  const pinnedAncestor = (el: Element): Element | null => {
    const path: Element[] = [];
    let found: Element | null = null;
    for (let cur: Element | null = el; cur && cur !== body && cur !== root; cur = cur.parentElement) {
      const cached = pinned.get(cur);
      if (cached !== undefined) {
        found = cached;
        break;
      }
      path.push(cur);
      const pos = getComputedStyle(cur).position;
      if (pos === 'fixed' || pos === 'sticky') {
        found = cur;
        break;
      }
    }
    for (const p of path) pinned.set(p, found);
    return found;
  };

  outer: for (let y = SAMPLE_STEP / 2; y < vh; y += SAMPLE_STEP) {
    for (let x = SAMPLE_STEP / 2; x < vw; x += SAMPLE_STEP) {
      const ci = Math.min(rows - 1, Math.floor(y / CELL)) * cols + Math.min(cols - 1, Math.floor(x / CELL));
      if (hardCells[ci]) continue;
      const el = document.elementFromPoint(x, y);
      if (!el || seen.has(el)) continue;
      seen.add(el);
      if (seen.size > MAX_ELEMENTS) break outer;
      if (el === root || el === body || el.closest(`[${OUR_ATTR}]`)) continue;

      const fixed = pinnedAncestor(el);
      if (fixed && markEl(fixed, 18, hardCells, 0.4)) continue;
      const control = el.closest(INTERACTIVE);
      if (control && markEl(control, 14, hardCells, 0.3)) continue;
      if ((MEDIA.has(el.tagName) || el instanceof SVGElement) && markEl(el, 12, hardCells, 0.6)) continue;
      let texts = 0;
      for (let n = el.firstChild; n && texts < 160; n = n.nextSibling) {
        if (n.nodeType !== Node.TEXT_NODE || !/\S/.test((n as Text).data)) continue;
        texts++;
        range.selectNodeContents(n);
        const rects = range.getClientRects();
        for (let i = 0; i < rects.length; i++) mark(rects[i].left, rects[i].top, rects[i].right, rects[i].bottom, 12, hardCells);
      }
      // A box with its own background or picture (a banner, a card, a chart) is
      // not text, but darkness spilling over it looks wrong: avoid it softly.
      const r = el.getBoundingClientRect();
      if (r.width * r.height < area * 0.5) {
        const cs = getComputedStyle(el);
        if (cs.backgroundImage !== 'none' || alphaOf(cs.backgroundColor) > 0.05 || parseFloat(cs.borderTopWidth) > 0) {
          mark(r.left, r.top, r.right, r.bottom, 6, softCells);
        }
      }
    }
  }

  return {
    cols,
    rows,
    vw,
    vh,
    hard: summed(hardCells, cols, rows),
    soft: summed(softCells, cols, rows),
    clear: clearance(hardCells, cols, rows),
  };
}

/** Choose where the eyes open. Falls back to the corner farthest from the reader. */
export function chooseSpot(map: FreeMap, o: PlaceOptions): Spot {
  const { vw, vh } = map;
  const scales = [1.2, 1, 0.84, 0.7, 0.58].map((k) => Math.max(20, o.baseW * k));
  let best: Spot | null = null;
  let bestScore = -Infinity;
  for (const w of scales) {
    // The eyes themselves (with lashes and a little room) must sit on nothing.
    const ehx = 1.95 * w + 10;
    const ehy = 0.5 * w + 10;
    // The densest part of the darkness should mostly sit on nothing too.
    const phx = 2.0 * w;
    const phy = 1.15 * w;
    for (let r = 0; r < map.rows; r++) {
      const cy = (r + 0.5) * CELL;
      if (cy - ehy < 6 || cy + ehy > vh - 6) continue;
      for (let c = 0; c < map.cols; c++) {
        const cx = (c + 0.5) * CELL;
        if (cx - ehx < 6 || cx + ehx > vw - 6) continue;
        if (count(map, map.hard, cx - ehx, cy - ehy, cx + ehx, cy + ehy) > 0) continue;
        const poolHard = fraction(map, map.hard, cx - phx, cy - phy, cx + phx, cy + phy);
        const poolSoft = fraction(map, map.soft, cx - phx, cy - phy, cx + phx, cy + phy);
        const eyeSoft = fraction(map, map.soft, cx - ehx, cy - ehy, cx + ehx, cy + ehy);
        // Room to breathe, counting the edge of the window as a wall too.
        const room = Math.min(map.clear[r * map.cols + c], cx, vw - cx, cy * 1.6, (vh - cy) * 1.6);
        let score = w * 2.2 + Math.min(room, 260) * 0.5;
        // The darkness should not be cut off by the window edge.
        const cut = Math.max(0, phx * 1.2 - cx) + Math.max(0, cx + phx * 1.2 - vw) + Math.max(0, phy * 1.5 - cy) + Math.max(0, cy + phy * 1.9 - vh);
        score -= (cut / w) * 70;
        score -= poolHard * 420 + poolSoft * 220 + eyeSoft * 320;
        // Margins and gutters: off to the side, where the reader is not looking.
        score += (Math.abs(cx - vw / 2) / (vw / 2)) * 45;
        score -= (Math.abs(cy - vh * 0.48) / vh) * 50;
        const dc = Math.hypot(cx - o.cursorX, cy - o.cursorY);
        score += dc < o.cursorR ? -(o.cursorR - dc) * o.cursorWeight : Math.min(dc, 900) * 0.04;
        for (const a of o.avoid) {
          const d = Math.hypot(cx - a.x, cy - a.y);
          if (d < a.r) score -= (a.r - d) * 1.4;
        }
        if (o.far) score += Math.min(Math.hypot(cx - o.far.x, cy - o.far.y), 900) * 0.12;
        score += o.rand() * 24;
        if (score > bestScore) {
          bestScore = score;
          best = { x: cx, y: cy, w };
        }
      }
    }
  }
  if (best) return best;
  // Nowhere is empty: tuck a small pair into the corner farthest from the reader.
  const w = Math.max(20, o.baseW * 0.58);
  const left = o.cursorX > vw / 2;
  const top = o.cursorY > vh / 2;
  return { x: left ? 2.2 * w + 8 : vw - 2.2 * w - 8, y: top ? 1.2 * w + 8 : vh - 1.2 * w - 8, w };
}

/** Is the page behind this point dark? Used to decide how deep the darkness must be to read. */
export function pageIsDark(x: number, y: number): boolean {
  let el: Element | null = document.elementFromPoint(x, y);
  while (el) {
    if (!el.closest(`[${OUR_ATTR}]`)) {
      const cs = getComputedStyle(el);
      const rgb = parseColor(cs.backgroundColor);
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

function count(map: FreeMap, s: Int32Array, x0: number, y0: number, x1: number, y1: number): number {
  const W = map.cols + 1;
  const c0 = Math.max(0, Math.floor(x0 / CELL));
  const c1 = Math.min(map.cols, Math.ceil(x1 / CELL));
  const r0 = Math.max(0, Math.floor(y0 / CELL));
  const r1 = Math.min(map.rows, Math.ceil(y1 / CELL));
  if (c1 <= c0 || r1 <= r0) return 0;
  return s[r1 * W + c1] - s[r0 * W + c1] - s[r1 * W + c0] + s[r0 * W + c0];
}

function fraction(map: FreeMap, s: Int32Array, x0: number, y0: number, x1: number, y1: number): number {
  const cells = Math.max(1, ((x1 - x0) / CELL) * ((y1 - y0) / CELL));
  return Math.min(1, count(map, s, x0, y0, x1, y1) / cells);
}

/** Chamfer distance transform: how far each cell is from anything taken, in px. */
function clearance(cells: Uint8Array, cols: number, rows: number): Float32Array {
  const d = new Float32Array(cols * rows);
  const BIG = 1e6;
  for (let i = 0; i < d.length; i++) d[i] = cells[i] ? 0 : BIG;
  const D = Math.SQRT2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!d[i]) continue;
      let v = d[i];
      if (c > 0) v = Math.min(v, d[i - 1] + 1);
      if (r > 0) {
        v = Math.min(v, d[i - cols] + 1);
        if (c > 0) v = Math.min(v, d[i - cols - 1] + D);
        if (c < cols - 1) v = Math.min(v, d[i - cols + 1] + D);
      }
      d[i] = v;
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      if (!d[i]) continue;
      let v = d[i];
      if (c < cols - 1) v = Math.min(v, d[i + 1] + 1);
      if (r < rows - 1) {
        v = Math.min(v, d[i + cols] + 1);
        if (c < cols - 1) v = Math.min(v, d[i + cols + 1] + D);
        if (c > 0) v = Math.min(v, d[i + cols - 1] + D);
      }
      d[i] = v;
    }
  }
  for (let i = 0; i < d.length; i++) d[i] = Math.min(d[i], 1000) * CELL;
  return d;
}
