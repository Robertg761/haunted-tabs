// Shapes shared by the cobweb simulation, its drawing and its spider, plus the
// little bits of curve maths they all lean on. Nothing here touches the page.

export type Pin =
  | { kind: 'viewport'; ax: number; ay: number; dx: number; dy: number }
  | { kind: 'page'; x: number; y: number };

/** What a thread is for, which decides how thick it is and how it is drawn. */
export const FRAME = 0;
export const RADIAL = 1;
export const SPIRAL = 2;
export const DRAG = 3;
export const TAIL = 4;
export const STRAY = 5;
export type StrandKind = 0 | 1 | 2 | 3 | 4 | 5;

export interface Particle {
  x: number;
  y: number;
  px: number;
  py: number;
  pin?: Pin;
  web: Web;
  alpha: number;
  /** Alpha lost per simulation step once it lets go (0 while it holds). */
  fade: number;
  falling: boolean;
  /** Simulated: glued down, or touched by at least one spun thread. */
  active: boolean;
  /** A broken end left flapping after a snap. */
  tail: boolean;
  /** Steps a tail has left before it frays away. */
  life: number;
  dead: boolean;
  /** Scratch slot for the connectivity pass. */
  idx: number;
  /** Which radial it sits on (-1 for none) and how far out along it. */
  ri: number;
  rk: number;
  /** Per-point phase so the breeze does not move everything in lockstep. */
  phase: number;
  /** Where it was when its web was last drawn, to tell whether it needs drawing again. */
  rx: number;
  ry: number;
}

export interface Strand {
  a: Particle;
  b: Particle;
  rest: number;
  /** Rest length it was spun with (falling fragments crumple below it). */
  rest0: number;
  snap: number;
  web: Web;
  kind: StrandKind;
  dead: boolean;
  /** When the spider lays it (ms of the web's own clock) and from which end. */
  t0: number;
  t1: number;
  rev: boolean;
  /** Neighbours along a chain, for smooth curves through the joints. */
  prev: Strand | null;
  next: Strand | null;
  /** Dust and age: how much this thread shows. */
  weight: number;
  /** Per-thread random phase for shimmer. */
  phase: number;
  // Filled in each frame by the renderer.
  ax: number;
  ay: number;
  c1x: number;
  c1y: number;
  c2x: number;
  c2y: number;
  bx: number;
  by: number;
  /** Quadratic approximation's control point, for finding where light catches. */
  qx: number;
  qy: number;
  /** How much has been spun (0..1) at this frame. */
  f: number;
  /** Drawn this frame, and in which style bucket. */
  vis: boolean;
  bucket: number;
  /** Near enough straight to draw as a line, which is far cheaper to raster. */
  flat: boolean;
}

export interface Leg {
  /** The thread walked along (and laid if `lay`), or null to cross open page. */
  s: Strand | null;
  from: Particle;
  to: Particle;
  rev: boolean;
  lay: boolean;
  t0: number;
  t1: number;
}

export interface Web {
  slot: string;
  /** Milliseconds of animation this web has lived through (pauses with the page). */
  clock: number;
  weaving: boolean;
  weaveMs: number;
  /** Fade the threads in instead of spinning them (reduced motion). */
  fadeIn: boolean;
  /** Load-bearing threads it was spun with; once too many are torn the rest lets go. */
  total: number;
  /** Load-bearing threads still intact, refreshed by the connectivity pass. */
  intact: number;
  live: number;
  hub: Particle;
  radials: Particle[][];
  radialStrands: Strand[][];
  dragline: Strand[];
  route: Leg[];
  leg: number;
  /** 0 light page, 1 mid tones, 2 dark page. */
  palette: number;
  hue: number;
  /** Points still belonging to it, refreshed by the connectivity pass. */
  points: number;
  /** Where it was hung and how big, for keeping webs apart. */
  cx: number;
  cy: number;
  R: number;
  /** Something about it changed since it was last drawn. */
  stir: boolean;
  /** Frames it has stayed still; once calm it is drawn once into `layer` and reused. */
  calm: number;
  layer: HTMLCanvasElement | null;
  layerOk: boolean;
  lx: number;
  ly: number;
  lw: number;
  lh: number;
  /** simTime when it last lost its spider (or never had one), for one to move back in. */
  vacantSince: number;
}

export const rand = (min: number, max: number): number => min + Math.random() * (max - min);
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const smooth = (t: number): number => {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
};

/** Scratch output for curve evaluation, so hot loops allocate nothing. */
export const pt = { x: 0, y: 0, tx: 0, ty: 0 };

/** Point and tangent on a strand's (frame-cached) cubic at u. */
export function curvePoint(s: Strand, u: number): typeof pt {
  const v = 1 - u;
  const a = v * v * v;
  const b = 3 * v * v * u;
  const c = 3 * v * u * u;
  const d = u * u * u;
  pt.x = a * s.ax + b * s.c1x + c * s.c2x + d * s.bx;
  pt.y = a * s.ay + b * s.c1y + c * s.c2y + d * s.by;
  const ta = 3 * v * v;
  const tb = 6 * v * u;
  const tc = 3 * u * u;
  pt.tx = ta * (s.c1x - s.ax) + tb * (s.c2x - s.c1x) + tc * (s.bx - s.c2x);
  pt.ty = ta * (s.c1y - s.ay) + tb * (s.c2y - s.c1y) + tc * (s.by - s.c2y);
  return pt;
}

const sub = new Float64Array(8);

/** Append the part of a strand's cubic between u0 and u1 to the current path. */
export function tracePart(ctx: CanvasRenderingContext2D, s: Strand, u0: number, u1: number): void {
  // Split at u1 and keep the head, then split the head at u0/u1 and keep the tail.
  split(s.ax, s.ay, s.c1x, s.c1y, s.c2x, s.c2y, s.bx, s.by, u1, true);
  if (u0 > 0) {
    const t = u0 / u1;
    split(sub[0], sub[1], sub[2], sub[3], sub[4], sub[5], sub[6], sub[7], t, false);
  }
  ctx.moveTo(sub[0], sub[1]);
  ctx.bezierCurveTo(sub[2], sub[3], sub[4], sub[5], sub[6], sub[7]);
}

function split(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, t: number, head: boolean): void {
  const ax = x0 + (x1 - x0) * t;
  const ay = y0 + (y1 - y0) * t;
  const bx = x1 + (x2 - x1) * t;
  const by = y1 + (y2 - y1) * t;
  const cx = x2 + (x3 - x2) * t;
  const cy = y2 + (y3 - y2) * t;
  const dx = ax + (bx - ax) * t;
  const dy = ay + (by - ay) * t;
  const ex = bx + (cx - bx) * t;
  const ey = by + (cy - by) * t;
  const fx = dx + (ex - dx) * t;
  const fy = dy + (ey - dy) * t;
  if (head) {
    sub[0] = x0; sub[1] = y0; sub[2] = ax; sub[3] = ay; sub[4] = dx; sub[5] = dy; sub[6] = fx; sub[7] = fy;
  } else {
    sub[0] = fx; sub[1] = fy; sub[2] = ex; sub[3] = ey; sub[4] = cx; sub[5] = cy; sub[6] = x3; sub[7] = y3;
  }
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? clamp(((px - ax) * dx + (py - ay) * dy) / len, 0, 1) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Where along c→d the segment a→b crosses it (0..1), or -1 if it does not. */
export function crossAt(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (!den) return -1;
  const qx = cx - ax;
  const qy = cy - ay;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  return t > 0 && t < 1 && u > 0 && u < 1 ? u : -1;
}
