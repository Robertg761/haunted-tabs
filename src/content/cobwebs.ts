// Cobwebs that gather over a neglected page and tear away when disturbed.
// Each web is a little Verlet cloth drawn on a canvas overlay: radials, a
// capture spiral and a frame, some threads glued to the window frame and some
// to the page content, so scrolling drags them until they snap. A sweeping
// mouse cuts and flings them; torn ends recoil and flutter, and webs that lose
// too much collapse and drift away. A page left alone slowly gets new webs,
// spun thread by thread by a spider. The page itself is never touched: the
// overlay ignores pointer events and is removed once the last strand is gone.

import {
  DRAG,
  FRAME,
  RADIAL,
  SPIRAL,
  STRAY,
  TAIL,
  clamp,
  crossAt,
  curvePoint,
  distToSegment,
  rand,
  tracePart,
  type Leg,
  type Particle,
  type Pin,
  type Strand,
  type StrandKind,
  type Web,
} from './cobwebs-model';
import {
  CORE_WIDTH,
  HUES,
  LEVELS,
  SHADOW_WIDTH,
  backgroundLum,
  dewSprite,
  dropSprites,
  glintSprite,
  paletteFor,
  sheenStyles,
  strokeStyles,
} from './cobwebs-art';
import { Spider, dropSpiderSprites, type SpiderWorld } from './cobwebs-spider';
import { Z } from './effects/overlay';

interface Dew {
  s: Strand;
  u: number;
  r: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Speed along the thread while it slides, px per step. */
  slide: number;
  sliding: boolean;
  placed: boolean;
}

interface Drip {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

interface Spark {
  x: number;
  y: number;
  life: number;
  palette: number;
}

interface Break {
  s: Strand;
  u: number;
  vx: number;
  vy: number;
}

const OUR_ATTR = 'data-haunted-tabs';
const MAX_WEBS = 8;
const STEP_MS = 1000 / 60;
const GRAVITY = 0.05;
const DAMPING = 0.982;
const ITERATIONS = 5;
const STIFFNESS = 0.92;
const CUT_SPEED = 4;
const TOUCH_RADIUS = 34;
const AIR_RADIUS = 90;
const SPIDER_SHY = 72;
const MAX_GLINTS = 240;
const MAX_POINTS = 4000;
/** Steps a torn fragment takes to fade, and a swept one. */
const FALL_FADE = 1 / 150;
const SWEEP_FADE = 1 / 78;
const REDUCED_FADE = 1 / 36;
const TAU = Math.PI * 2;

/** Lay speeds in px per ms, by thread kind, and the speed it walks without spinning. */
const LAY_SPEED: Record<StrandKind, number> = { 0: 0.23, 1: 0.26, 2: 0.2, 3: 0.17, 4: 0.3, 5: 0.25 };
const WALK_SPEED = 0.42;

interface OrbEnd {
  len: number;
  pin?: (x: number, y: number) => Pin | undefined;
  wall: boolean;
}

interface OrbPlan {
  radials: Particle[][];
  radialStrands: Strand[][];
  frame: (Strand | null)[];
  hubRings: Strand[];
  spiral: Strand[];
}

export class Cobwebs {
  private host: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private particles: Particle[] = [];
  private strands: Strand[] = [];
  private webs: Web[] = [];
  private spiders: Spider[] = [];
  private dews: Dew[] = [];
  private drips: Drip[] = [];
  private sparks: Spark[] = [];
  private breaks: Break[] = [];
  private raf = 0;
  private calmFrames = 0;
  private steps = 0;
  private lastNow = 0;
  private acc = 0;
  private simTime = 0;
  private dpr = 1;
  private reported = '';

  private pointer = { x: 0, y: 0, lastX: 0, lastY: 0, seen: false };
  private offX = 0;
  private offY = 0;
  private winX = scrollX;
  private winY = scrollY;
  private elementScroll = new WeakMap<Element, { left: number; top: number }>();

  private gust = { start: -1e9, dur: 1, strength: 0, dx: 1, dy: 0 };
  private windX = 0;
  private windY = 0;
  private tails = 0;
  private falling = 0;

  private growAfterMs = 0;
  private growTimer: number | undefined;
  private idleTimer: number | undefined;
  private lastActivity = Date.now();
  private lastGrowth = Date.now();
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private listening = false;

  // Scratch buffers for the connectivity pass and draw ordering, grown as needed.
  private parent = new Int32Array(0);
  private degree = new Int32Array(0);
  private anchored = new Uint8Array(0);
  private sumX = new Float64Array(0);
  private sumY = new Float64Array(0);
  private sumN = new Int32Array(0);
  private order = new Int32Array(0);
  private bucketCount = new Int32Array(2 * 3 * LEVELS);
  private bucketStart = new Int32Array(2 * 3 * LEVELS);
  private glintS = new Int32Array(MAX_GLINTS);
  private glintU = new Float64Array(MAX_GLINTS);
  private glintI = new Float64Array(MAX_GLINTS);
  private pinOut = { x: 0, y: 0 };

  private readonly world: SpiderWorld = {
    offX: 0,
    offY: 0,
    vw: innerWidth,
    vh: innerHeight,
    windX: 0,
    ptrX: 0,
    ptrY: 0,
    ptrSeen: false,
    near: (web, x, y, r) => this.nearest(web, x, y, r),
  };

  get count(): number {
    let n = 0;
    for (const w of this.webs) if (w.live > 0) n++;
    return n;
  }

  /** Lay `count` webs over the page, already spun as if they grew while you were away, or spin them now. */
  add(count: number, weave = false): void {
    if (count <= 0) return;
    const want = Math.min(MAX_WEBS, this.count + count);
    let guard = 0;
    while (this.count < want && guard++ < MAX_WEBS * 2) {
      const slot = this.freeSlot();
      const web = this.newWeb(slot, weave);
      const plan =
        slot === 'hang'
          ? this.buildHanging(web, weave)
          : slot.startsWith('free')
            ? this.buildFree(web, weave)
            : this.buildCorner(web, slot === 'tr' || slot === 'br' ? 1 : 0, slot === 'bl' || slot === 'br' ? 1 : 0, weave);
      this.finishWeb(web, plan, weave);
    }
    this.ensureCanvas();
    this.report();
    this.scheduleIdle();
    this.wake();
  }

  /** Keep weaving new webs while the page sits untouched for `ms`. */
  arm(ms: number): void {
    this.growAfterMs = Math.max(20_000, ms);
    this.listen();
    if (this.growTimer !== undefined) return;
    this.growTimer = window.setInterval(() => {
      if (!this.growAfterMs || document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - this.lastActivity < this.growAfterMs || now - this.lastGrowth < this.growAfterMs) return;
      this.lastGrowth = now;
      if (this.count < MAX_WEBS) this.add(1, true);
    }, 1000);
  }

  /** Stop growing and let every strand fall away. */
  sweep(): void {
    this.growAfterMs = 0;
    if (this.growTimer !== undefined) clearInterval(this.growTimer);
    this.growTimer = undefined;
    // Hidden pages get no animation frames, so make sure the webs go even then.
    if (document.visibilityState === 'visible' && (this.particles.length || this.spiders.length)) this.fadeAll(SWEEP_FADE);
    else this.teardown();
    setTimeout(() => (this.particles.length || this.host) && this.teardown(), 2500);
  }

  // --- building --------------------------------------------------------------

  private freeSlot(): string {
    const taken = new Set(this.webs.filter((w) => w.live > 0).map((w) => w.slot));
    const corners = ['tl', 'tr', 'bl', 'br'].filter((c) => !taken.has(c)).sort(() => Math.random() - 0.5);
    if (corners.length) return corners[0];
    if (!taken.has('hang')) return 'hang';
    return `free${Math.random()}`;
  }

  private newWeb(slot: string, weave: boolean): Web {
    const web: Web = {
      slot,
      clock: 0,
      weaving: weave,
      weaveMs: 0,
      fadeIn: weave && this.reduced,
      total: 0,
      intact: 0,
      live: 1,
      hub: null as unknown as Particle,
      radials: [],
      radialStrands: [],
      dragline: [],
      route: [],
      leg: 0,
      palette: 0,
      hue: Math.random(),
      points: 0,
    };
    this.webs.push(web);
    return web;
  }

  private particle(web: Web, x: number, y: number, pin?: Pin): Particle {
    const p: Particle = {
      x, y, px: x, py: y, pin, web,
      alpha: 1, fade: 0, falling: false, active: !web.weaving, tail: false, life: 0, dead: false,
      idx: 0, ri: -1, rk: -1, phase: Math.random() * TAU,
    };
    this.particles.push(p);
    return p;
  }

  private viewportPin(x: number, y: number, ax: number, ay: number): Pin {
    return { kind: 'viewport', ax, ay, dx: x - ax * innerWidth, dy: y - ay * innerHeight };
  }

  private pagePin(x: number, y: number): Pin {
    return { kind: 'page', x: x + this.offX, y: y + this.offY };
  }

  private strand(web: Web, a: Particle, b: Particle, kind: StrandKind, slack = 1, snap = 1.75): Strand {
    const rest = Math.hypot(a.x - b.x, a.y - b.y) * slack;
    const s: Strand = {
      a, b, rest, rest0: rest, snap: snap * rand(0.92, 1.08), web, kind, dead: false,
      t0: 0, t1: 0, rev: false, prev: null, next: null,
      weight: web.weaving ? rand(0.78, 1) : Math.random() < 0.15 ? 1 : rand(0.5, 0.92),
      phase: Math.random(),
      ax: a.x, ay: a.y, c1x: a.x, c1y: a.y, c2x: b.x, c2y: b.y, bx: b.x, by: b.y, qx: a.x, qy: a.y,
      f: web.weaving ? 0 : 1,
      vis: false,
      bucket: -1,
      flat: false,
    };
    this.strands.push(s);
    return s;
  }

  /**
   * An orb web around `hub`: radials out to wherever `end` says they are glued,
   * a tight hub mesh, a true capture spiral (broken where a radial is cut short
   * by the window frame), and frame threads joining the free ends.
   */
  private orb(web: Web, hub: Particle, R: number, spokes: number, turns: number, end: (theta: number) => OrbEnd, old: boolean): OrbPlan {
    const rIn = R * 0.2;
    const outer = R * 0.93;
    const start = rand(0, TAU);
    const radials: Particle[][] = [];
    const radialStrands: Strand[][] = [];
    const ends: { p: Particle; wall: boolean }[] = [];
    // grid[i][k]: k 0,1 hub mesh, then 2.. spiral turns (null where clipped).
    const grid: (Particle | null)[][] = [];
    for (let i = 0; i < spokes; i++) {
      const theta = start + (i / spokes) * TAU + rand(-0.09, 0.09);
      const e = end(theta);
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      const row: (Particle | null)[] = [];
      const chain: Particle[] = [];
      const chainStrands: Strand[] = [];
      let prev = hub;
      let prevS: Strand | null = null;
      const place = (r: number, pin?: Pin): Particle => {
        const p = this.particle(web, hub.x + c * r, hub.y + s * r, pin);
        p.ri = i;
        p.rk = chain.length;
        const st = this.strand(web, prev, p, RADIAL, 1, 1.8);
        if (prevS) {
          prevS.next = st;
          st.prev = prevS;
        }
        chain.push(p);
        chainStrands.push(st);
        prev = p;
        prevS = st;
        return p;
      };
      const hubR = [R * 0.075, R * 0.13];
      for (const r of hubR) row.push(r < e.len - 4 && R * 0.075 > 3 ? place(r) : null);
      for (let k = 0; k < turns; k++) {
        const r = (rIn + ((outer - rIn) * (k + i / spokes)) / turns) * rand(0.975, 1.025);
        row.push(r < e.len - 5 ? place(r) : null);
      }
      const endP = place(e.len, e.pin?.(hub.x + c * e.len, hub.y + s * e.len));
      ends.push({ p: endP, wall: e.wall });
      grid.push(row);
      radials.push(chain);
      radialStrands.push(chainStrands);
    }
    // Hub mesh: two tight rings.
    const hubRings: Strand[] = [];
    for (let h = 0; h < 2; h++) {
      for (let i = 0; i < spokes; i++) {
        const a = grid[i][h];
        const b = grid[(i + 1) % spokes][h];
        if (a && b) hubRings.push(this.strand(web, a, b, SPIRAL, rand(1.0, 1.03), 1.7));
      }
    }
    // The capture spiral, outwards: each turn hands over to the next at the seam.
    const spiral: Strand[] = [];
    for (let k = 0; k < turns; k++) {
      for (let i = 0; i < spokes; i++) {
        const a = grid[i][k + 2];
        const b = i < spokes - 1 ? grid[i + 1][k + 2] : grid[0][k + 3];
        if (!a || !b) continue;
        if (old && Math.random() < 0.07) continue; // old webs have gaps
        const slack = old ? rand(1.025, 1.09) : rand(1.012, 1.04);
        spiral.push(this.strand(web, a, b, SPIRAL, slack, 1.6));
      }
    }
    // Frame threads between neighbouring ends, unless the window edge is the frame.
    const frame: (Strand | null)[] = [];
    for (let i = 0; i < spokes; i++) {
      const a = ends[i];
      const b = ends[(i + 1) % spokes];
      frame.push(a.wall && b.wall ? null : this.strand(web, a.p, b.p, FRAME, rand(1.0, 1.02), 1.7));
    }
    web.hub = hub;
    web.radials = radials;
    web.radialStrands = radialStrands;
    return { radials, radialStrands, frame, hubRings, spiral };
  }

  /** A web filling a corner of the window, hub near the corner, glued to both edges and the page. */
  private buildCorner(web: Web, ax: number, ay: number, weave: boolean): OrbPlan {
    // Glue to the visible frame, not under the page's scrollbars.
    const vw = document.documentElement.clientWidth || innerWidth;
    const vh = document.documentElement.clientHeight || innerHeight;
    const R = clamp(Math.min(vw, vh) * rand(0.26, 0.36), 110, weave ? 190 : 270);
    const cx0 = ax ? vw : 0;
    const cy0 = ay ? vh : 0;
    const sx = ax ? -1 : 1;
    const sy = ay ? -1 : 1;
    const inset = R * rand(0.2, 0.28);
    const hub = this.particle(web, cx0 + sx * inset * rand(0.9, 1.25), cy0 + sy * inset * rand(0.9, 1.25));
    const spokes = Math.round(rand(14, 18));
    const turns = Math.round(rand(weave ? 7 : 8, weave ? 9 : 11));
    const plan = this.orb(web, hub, R, spokes, turns, (theta) => {
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      let t = Infinity;
      if (c * sx < 0) t = Math.min(t, (cx0 - hub.x) / c);
      if (s * sy < 0) t = Math.min(t, (cy0 - hub.y) / s);
      const len = R * rand(0.86, 1.08);
      if (t < len) return { len: t, wall: true, pin: (x, y) => this.viewportPin(x, y, ax, ay) };
      return { len, wall: false, pin: Math.random() < 0.75 ? (x, y) => this.pagePin(x, y) : undefined };
    }, !weave);
    if (!weave) this.dress(web, plan, () => {
      // Stray bridge lines out along the window edges.
      const alongTop = Math.random() < 0.5;
      const x = alongTop ? cx0 + sx * rand(R * 1.1, R * 1.9) : cx0;
      const y = alongTop ? cy0 : cy0 + sy * rand(R * 1.1, R * 1.9);
      return this.particle(web, clamp(x, 0, vw), clamp(y, 0, vh), this.viewportPin(clamp(x, 0, vw), clamp(y, 0, vh), ax, ay));
    });
    return plan;
  }

  /** A small orb web hanging on one thread from the top of the window. */
  private buildHanging(web: Web, weave: boolean): OrbPlan {
    const vw = innerWidth;
    const topX = rand(0.3, 0.7) * vw;
    const depth = rand(0.22, 0.38) * innerHeight;
    const R = rand(58, 88);
    const top = this.particle(web, topX, 0, this.viewportPin(topX, 0, 0, 0));
    let prev = top;
    let prevS: Strand | null = null;
    const links = 7;
    const drag: Strand[] = [];
    for (let k = 1; k <= links; k++) {
      const p = this.particle(web, topX, (depth * k) / links);
      const s = this.strand(web, prev, p, DRAG, 1, 2.2);
      if (prevS) {
        prevS.next = s;
        s.prev = prevS;
      }
      drag.push(s);
      prev = p;
      prevS = s;
    }
    const plan = this.orb(web, prev, R, Math.round(rand(10, 13)), Math.round(rand(5, 7)), () => ({
      len: R * rand(0.9, 1.1),
      wall: false,
      pin: Math.random() < 0.85 ? (x, y) => this.pagePin(x, y) : undefined,
    }), !weave);
    web.dragline = drag;
    return plan;
  }

  /** An orb web strung across open page, every end glued to the content. */
  private buildFree(web: Web, weave: boolean): OrbPlan {
    const x = rand(0.2, 0.8) * innerWidth;
    const y = rand(0.28, 0.78) * innerHeight;
    const hub = this.particle(web, x, y);
    const R = weave ? rand(80, 120) : rand(80, 140);
    const plan = this.orb(web, hub, R, Math.round(rand(11, 15)), Math.round(rand(6, 8)), () => ({
      len: R * rand(0.88, 1.1),
      wall: false,
      pin: (px, py) => this.pagePin(px, py),
    }), !weave);
    if (!weave) {
      this.dress(web, plan, () => {
        const sx = clamp(x + rand(-1, 1) * R * 1.8, 0, innerWidth);
        const sy = Math.max(0, y - R * rand(1.2, 1.8));
        return this.particle(web, sx, sy, this.pagePin(sx, sy));
      });
    }
    return plan;
  }

  /** Age an old web: stray bridge lines and a broken thread or two hanging loose. */
  private dress(web: Web, plan: OrbPlan, strayAnchor: () => Particle): void {
    const outerPts = plan.radials.map((r) => r[r.length - 2]).filter((p): p is Particle => !!p);
    if (!outerPts.length) return;
    const pick = () => outerPts[Math.floor(Math.random() * outerPts.length)];
    const strays = Math.round(rand(1, 2.6));
    for (let i = 0; i < strays; i++) this.strand(web, pick(), strayAnchor(), STRAY, rand(1.0, 1.03), 2.2);
    const drapes = Math.round(rand(1, 2.8));
    for (let i = 0; i < drapes; i++) {
      let prev = pick();
      let prevS: Strand | null = null;
      const n = Math.round(rand(2, 4));
      const seg = rand(7, 12);
      for (let k = 0; k < n; k++) {
        const p = this.particle(web, prev.x + rand(-2, 2), prev.y + seg);
        const s = this.strand(web, prev, p, STRAY, 1, 4);
        if (prevS) {
          prevS.next = s;
          s.prev = prevS;
        }
        prev = p;
        prevS = s;
      }
    }
  }

  private finishWeb(web: Web, plan: OrbPlan, weave: boolean): void {
    let lum = 0;
    const probes = [web.hub, ...plan.radials.map((r) => r[r.length - 1])].slice(0, 6);
    for (const p of probes) lum += backgroundLum(p.x, p.y);
    web.palette = paletteFor(lum / probes.length);
    let total = 0;
    for (const s of this.strands) {
      if (s.web !== web) continue;
      if (s.kind !== STRAY) total++;
      // Dew: mostly beaded along the sticky spiral.
      const chance = s.kind === SPIRAL ? (weave ? 0.08 : 0.13) : s.kind === RADIAL ? 0.025 : 0;
      if (Math.random() < chance) {
        this.dews.push({ s, u: rand(0.22, 0.78), r: rand(0.75, 1.55), x: 0, y: 0, vx: 0, vy: 0, slide: 0, sliding: false, placed: false });
      }
    }
    web.total = total;
    web.intact = total;
    web.live = total;
    if (weave && !this.reduced) {
      this.planWeave(web, plan);
      const first = web.route[0];
      const spider = new Spider(web, first ? first.from.x : web.hub.x, first ? first.from.y : web.hub.y, this.world);
      this.spiders.push(spider);
    } else if (weave) {
      // Reduced motion: the web simply fades in, its spider already home.
      web.weaveMs = 3500;
      for (const s of this.strands) if (s.web === web) s.f = 1;
      for (const p of this.particles) if (p.web === web) p.active = true;
      const spider = new Spider(web, web.hub.x, web.hub.y + 1, this.world);
      spider.sit(web.hub);
      this.spiders.push(spider);
    } else {
      this.settle(web, web.dragline.length ? 420 : 260);
      if (web.dragline.length) {
        const spider = new Spider(web, web.hub.x, web.hub.y + 1, this.world);
        spider.alpha = 1;
        spider.sit(web.hub);
        this.spiders.push(spider);
      }
    }
  }

  /** Let a freshly laid web sag into place before anyone sees it. */
  private settle(web: Web, steps: number): void {
    for (let i = 0; i < steps; i++) {
      this.integrate(web);
      this.solve(web);
    }
    this.breaks.length = 0;
  }

  // --- the weave -------------------------------------------------------------

  /**
   * The spider's route: frame first, then radials laid alternately in and out,
   * the hub mesh, and the capture spiral from the outside in. Every thread is
   * revealed exactly as the spider walks it.
   */
  private planWeave(web: Web, plan: OrbPlan): void {
    const hub = web.hub;
    const legs: (Leg & { base: number })[] = [];
    const n = plan.radials.length;
    const endOf = (i: number) => plan.radials[i][plan.radials[i].length - 1];
    let cur: Particle;

    const along = (s: Strand, lay: boolean) => {
      const rev = cur === s.b;
      const to = rev ? s.a : s.b;
      const len = Math.hypot(s.a.x - s.b.x, s.a.y - s.b.y);
      legs.push({ s, from: cur, to, rev, lay, t0: 0, t1: 0, base: len / (lay ? LAY_SPEED[s.kind] : WALK_SPEED) });
      cur = to;
    };
    const straight = (to: Particle) => {
      legs.push({ s: null, from: cur, to, rev: false, lay: false, t0: 0, t1: 0, base: Math.hypot(to.x - cur.x, to.y - cur.y) / WALK_SPEED });
      cur = to;
    };
    const radialWalk = (i: number, fromK: number, toK: number) => {
      const rs = plan.radialStrands[i];
      if (toK > fromK) for (let k = fromK + 1; k <= toK; k++) along(rs[k], false);
      else for (let k = fromK; k > toK; k--) along(rs[k], false);
    };
    const goTo = (t: Particle) => {
      if (cur === t) return;
      if (t === hub && cur.ri >= 0) radialWalk(cur.ri, cur.rk, -1);
      else if (cur === hub && t.ri >= 0) radialWalk(t.ri, -1, t.rk);
      else if (cur.ri >= 0 && cur.ri === t.ri) radialWalk(t.ri, cur.rk, t.rk);
      else straight(t);
    };
    const layRadial = (i: number, outward: boolean) => {
      const rs = plan.radialStrands[i];
      if (outward) for (let k = 0; k < rs.length; k++) along(rs[k], true);
      else for (let k = rs.length - 1; k >= 0; k--) along(rs[k], true);
    };
    const phases: number[] = [];
    const mark = () => phases.push(legs.length);

    if (web.dragline.length) {
      // Down from the top of the window on its own dragline, then the radials out and back.
      cur = web.dragline[0].a;
      for (const s of web.dragline) along(s, true);
      mark();
      for (let i = 0; i < n; i++) {
        layRadial(i, true);
        goTo(hub);
      }
      mark();
      goTo(endOf(0));
      for (let i = 0; i < n; i++) {
        const f = plan.frame[i];
        if (f) along(f, true);
        else straight(endOf((i + 1) % n));
      }
    } else {
      // Start on a glued end; corners start on the window edge.
      let i0 = 0;
      for (let i = 0; i < n; i++) if (endOf(i).pin?.kind === 'viewport') { i0 = i; break; }
      cur = endOf(i0);
      for (let j = 0; j < n; j++) {
        const i = (i0 + j) % n;
        const f = plan.frame[i];
        if (f) along(f, true);
        else straight(endOf((i + 1) % n));
      }
      mark();
      for (let j = 0; j < n; j++) {
        const i = (i0 + j) % n;
        if (cur === hub) layRadial(i, true);
        else {
          goTo(endOf(i));
          layRadial(i, false);
        }
      }
    }
    mark();
    for (const s of plan.hubRings) {
      goTo(s.a);
      along(s, true);
    }
    mark();
    for (let j = plan.spiral.length - 1; j >= 0; j--) {
      const s = plan.spiral[j];
      goTo(s.b);
      along(s, true);
    }
    goTo(hub);

    // Fit the whole performance into ten-odd seconds, whatever the web's size.
    let base = 0;
    for (const l of legs) base += l.base;
    const target = web.dragline.length ? rand(8500, 9500) : rand(10500, 12500);
    const k = clamp(target / Math.max(1, base), 0.3, 1.8);
    let t = 300;
    for (const l of legs) {
      l.t0 = t;
      t += Math.max(24, l.base * k);
      l.t1 = t;
      if (l.lay && l.s && l.s.t1 === 0) {
        l.s.t0 = l.t0;
        l.s.t1 = l.t1;
        l.s.rev = l.rev;
      }
    }
    for (const s of this.strands) {
      if (s.web === web && s.t1 === 0) {
        // Anything the route missed is spun in at the end.
        s.t0 = t;
        s.t1 = t + 400;
      }
    }
    web.route = legs;
    web.leg = 0;
    web.weaveMs = t + 450;
  }

  /** Move the weave on by one step: reveal threads, wake their points, steer the spider. */
  private advanceWeave(web: Web): void {
    web.clock += STEP_MS;
    const now = web.clock;
    if (web.fadeIn) {
      if (now >= web.weaveMs) web.weaving = false;
      return;
    }
    for (const s of this.strands) {
      if (s.web !== web || s.dead || s.f >= 1) continue;
      const f = s.t1 > s.t0 ? clamp((now - s.t0) / (s.t1 - s.t0), 0, 1) : now >= s.t1 ? 1 : 0;
      if (f > 0 && s.f <= 0) {
        s.a.active = s.b.active = true;
        // A fresh thread starts exactly where it is anchored.
        for (const p of [s.a, s.b]) {
          p.px = p.x;
          p.py = p.y;
        }
      }
      s.f = f;
    }
    const route = web.route;
    while (web.leg < route.length - 1 && now >= route[web.leg].t1) web.leg++;
    const spider = this.spiderOf(web);
    const leg = route[web.leg];
    if (spider && spider.state === 'weave' && leg) {
      const u = clamp((now - leg.t0) / (leg.t1 - leg.t0), 0, 1);
      if (leg.s) {
        this.geometry(leg.s);
        const q = curvePoint(leg.s, leg.rev ? 1 - u : u);
        spider.follow(q.x, q.y);
      } else {
        spider.follow(leg.from.x + (leg.to.x - leg.from.x) * u, leg.from.y + (leg.to.y - leg.from.y) * u);
      }
    }
    if (now >= web.weaveMs) {
      web.weaving = false;
      for (const s of this.strands) {
        if (s.web !== web || s.dead) continue;
        s.f = 1;
        s.a.active = s.b.active = true;
      }
      if (spider && spider.state === 'weave') spider.sit(web.hub);
    }
  }

  /** Startled mid-weave: keep what is spun, drop the rest, and the spider bolts. */
  private abortWeave(web: Web, fromX: number, fromY: number): void {
    if (!web.weaving) return;
    web.weaving = false;
    let total = 0;
    for (const s of this.strands) {
      if (s.web !== web || s.dead) continue;
      if (s.f <= 0) s.dead = true;
      else {
        s.f = 1;
        if (s.kind !== STRAY) total++;
      }
    }
    for (const p of this.particles) if (p.web === web && !p.active) p.dead = true;
    web.total = web.intact = web.live = total;
    const spider = this.spiderOf(web);
    if (spider && spider.state === 'weave') {
      const seat = this.nearest(web, spider.x, spider.y, 30);
      if (seat) {
        spider.sit(seat);
        spider.flee(fromX, fromY);
      } else spider.drop(null);
    }
  }

  private spiderOf(web: Web): Spider | null {
    for (const s of this.spiders) if (s.web === web) return s;
    return null;
  }

  private nearest(web: Web, x: number, y: number, r: number): Particle | null {
    let best: Particle | null = null;
    let bd = r * r;
    for (const p of this.particles) {
      if (p.web !== web || p.dead || p.falling || !p.active || p.tail) continue;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  // --- canvas and input ------------------------------------------------------

  private ensureCanvas(): void {
    if (this.host?.isConnected) return;
    const host = document.createElement('div');
    host.setAttribute(OUR_ATTR, 'cobwebs');
    const root = host.attachShadow({ mode: 'closed' });
    const canvas = document.createElement('canvas');
    canvas.style.cssText = `position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:${Z.cobwebs};`;
    root.append(canvas);
    document.documentElement.appendChild(host);
    this.host = host;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.reported = '';
    this.resize();
    this.listen();
  }

  private resize = (): void => {
    this.world.vw = innerWidth;
    this.world.vh = innerHeight;
    if (!this.canvas || !this.ctx) return;
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = Math.round(innerWidth * this.dpr);
    this.canvas.height = Math.round(innerHeight * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.wake();
  };

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    const opts = { capture: true, passive: true };
    addEventListener('pointermove', this.onPointer, opts);
    addEventListener('scroll', this.onScroll, opts);
    addEventListener('wheel', this.onActivity, opts);
    addEventListener('keydown', this.onActivity, opts);
    addEventListener('touchmove', this.onActivity, opts);
    addEventListener('resize', this.resize, opts);
    document.addEventListener('visibilitychange', this.onVisibility, opts);
  }

  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') this.wake();
  };

  private onActivity = (): void => {
    this.lastActivity = Date.now();
    if (this.reduced && this.particles.length) this.fadeAll(REDUCED_FADE);
  };

  private onPointer = (e: PointerEvent): void => {
    this.lastActivity = Date.now();
    if (!this.pointer.seen || !this.raf) {
      // Start the stroke here, not wherever the pointer was when the webs went still.
      this.pointer.lastX = e.clientX - e.movementX;
      this.pointer.lastY = e.clientY - e.movementY;
      this.pointer.seen = true;
    }
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
    if (this.reduced && Math.hypot(e.movementX, e.movementY) > 2) this.fadeAll(REDUCED_FADE);
    this.wake();
  };

  /** Track how far the content moved, whether the window or an inner panel scrolled. */
  private onScroll = (e: Event): void => {
    this.lastActivity = Date.now();
    let dx = 0;
    let dy = 0;
    const target = e.target;
    if (target === document || target === document.documentElement || target === document.body) {
      dx = scrollX - this.winX;
      dy = scrollY - this.winY;
      this.winX = scrollX;
      this.winY = scrollY;
    } else if (target instanceof Element) {
      const last = this.elementScroll.get(target);
      if (last) {
        dx = target.scrollLeft - last.left;
        dy = target.scrollTop - last.top;
      }
      this.elementScroll.set(target, { left: target.scrollLeft, top: target.scrollTop });
    }
    if (!dx && !dy) return;
    this.offX += dx;
    this.offY += dy;
    // The air moves with the page: loose threads swing the way the content went.
    for (const p of this.particles) {
      if (!p.pin && p.active) {
        p.px += clamp(dx, -60, 60) * 0.12;
        p.py += clamp(dy, -60, 60) * 0.12;
      }
    }
    for (const w of this.webs) if (w.weaving) this.abortWeave(w, this.pointer.x, this.pointer.y);
    if (this.reduced) this.fadeAll(REDUCED_FADE);
    this.wake();
  };

  private fadeAll(rate: number): void {
    for (const p of this.particles) {
      p.pin = undefined;
      p.falling = true;
      p.fade = Math.max(p.fade, rate);
    }
    for (const w of this.webs) w.weaving = false;
    for (const s of this.spiders) s.fading = true;
    this.wake();
  }

  private wake(): void {
    this.calmFrames = 0;
    if (!this.raf && (this.particles.length || this.spiders.length) && this.ctx) {
      this.lastNow = 0;
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  /** Now and then the air stirs, the spider fidgets, a dew drop runs. */
  private scheduleIdle(): void {
    if (this.idleTimer !== undefined || this.reduced) return;
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = undefined;
      if (!this.host || (!this.particles.length && !this.spiders.length)) return;
      if (document.visibilityState === 'visible') {
        if (Math.random() < 0.75 && this.simTime > this.gust.start + this.gust.dur) {
          const a = rand(-0.5, 0.5) + (Math.random() < 0.5 ? 0 : Math.PI);
          this.gust = { start: this.simTime, dur: rand(2400, 4200), strength: rand(0.4, 1), dx: Math.cos(a), dy: Math.sin(a) * 0.4 };
        }
        for (const s of this.spiders) if (s.sitting && Math.random() < 0.6) s.twitch();
        if (Math.random() < 0.3) this.startSlide();
        this.wake();
      }
      this.scheduleIdle();
    }, rand(7000, 16000));
  }

  private startSlide(): void {
    const candidates = this.dews.filter((d) => !d.sliding && d.placed && !d.s.dead && !d.s.a.falling);
    for (let tries = 0; tries < 6 && candidates.length; tries++) {
      const d = candidates[Math.floor(Math.random() * candidates.length)];
      const q = curvePoint(d.s, d.u);
      const len = Math.hypot(q.tx, q.ty) || 1;
      if (Math.abs(q.ty / len) > 0.35) {
        d.sliding = true;
        d.slide = 0;
        return;
      }
    }
  }

  // --- simulation ------------------------------------------------------------

  private tick = (now: number): void => {
    this.raf = 0;
    if (!this.ctx) return;
    const dt = this.lastNow ? Math.min(64, now - this.lastNow) : STEP_MS;
    this.lastNow = now;
    this.acc += dt;
    let motion = this.pointerSweep();
    let n = 0;
    while (this.acc >= STEP_MS - 0.5 && n < 4) {
      motion = Math.max(motion, this.step());
      this.acc -= STEP_MS;
      n++;
    }
    if (n === 4) this.acc = 0;
    this.cull();
    this.draw();

    let busy = this.falling > 0 || this.tails > 0 || this.drips.length > 0 || this.sparks.length > 0;
    busy ||= this.simTime < this.gust.start + this.gust.dur;
    for (const w of this.webs) busy ||= w.weaving;
    for (const s of this.spiders) busy ||= s.busy;
    for (const d of this.dews) busy ||= d.sliding;
    this.calmFrames = motion < 0.05 && !busy ? this.calmFrames + 1 : 0;
    if (this.particles.length === 0 && this.spiders.length === 0) {
      this.teardown();
    } else if (this.calmFrames < 40) {
      this.raf = requestAnimationFrame(this.tick);
    }
  };

  private step(): number {
    this.simTime += STEP_MS;
    this.steps++;
    const g = this.gust;
    const gt = (this.simTime - g.start) / g.dur;
    const env = gt > 0 && gt < 1 ? Math.sin(Math.PI * gt) ** 2 * g.strength : 0;
    this.windX = env * g.dx * 0.03;
    this.windY = env * g.dy * 0.03;
    const w = this.world;
    w.offX = this.offX;
    w.offY = this.offY;
    w.windX = this.windX;
    w.ptrX = this.pointer.x;
    w.ptrY = this.pointer.y;
    w.ptrSeen = this.pointer.seen;

    for (const web of this.webs) if (web.weaving) this.advanceWeave(web);
    const motion = this.integrate(null);
    this.solve(null);
    if (this.breaks.length) this.applyBreaks();
    this.stepDew();
    for (const s of this.spiders) s.step();
    for (let i = this.sparks.length - 1; i >= 0; i--) if (--this.sparks[i].life <= 0) this.sparks.splice(i, 1);
    if (this.steps % 6 === 0) this.findFallen();
    return motion;
  }

  /** The mouse brushes threads aside, cuts the ones it crosses fast, and tears loose glued ends. */
  private pointerSweep(): number {
    const ptr = this.pointer;
    const mx = ptr.x - ptr.lastX;
    const my = ptr.y - ptr.lastY;
    ptr.lastX = ptr.x;
    ptr.lastY = ptr.y;
    const speed = Math.hypot(mx, my);
    if (!ptr.seen || speed < 0.5) return 0;
    const ax = ptr.x - mx;
    const ay = ptr.y - my;
    // Spiders are shy.
    for (const sp of this.spiders) {
      if (sp.state === 'gone' || sp.fading) continue;
      if (distToSegment(sp.x, sp.y, ax, ay, ptr.x, ptr.y) < SPIDER_SHY) this.startle(sp.web, ptr.x, ptr.y);
    }
    const air = Math.min(speed, 40) * 0.018;
    for (const p of this.particles) {
      if (!p.active || p.dead) continue;
      const d = distToSegment(p.x, p.y, ax, ay, ptr.x, ptr.y);
      if (d > AIR_RADIUS) continue;
      if (d < TOUCH_RADIUS) {
        const push = (1 - d / TOUCH_RADIUS) * 0.7;
        if (p.pin && speed > CUT_SPEED * 1.5 && d < TOUCH_RADIUS / 2) p.pin = undefined;
        if (!p.pin) {
          p.x += mx * push;
          p.y += my * push;
        }
      } else if (!p.pin) {
        // The wake of a passing hand stirs threads it never touches.
        const k = (1 - d / AIR_RADIUS) * air;
        p.px -= (mx / speed) * k;
        p.py -= (my / speed) * k;
      }
    }
    if (speed > CUT_SPEED) {
      for (const s of this.strands) {
        if (s.dead || s.f <= 0 || !s.a.active || !s.b.active) continue;
        const u = crossAt(ax, ay, ptr.x, ptr.y, s.a.x, s.a.y, s.b.x, s.b.y);
        if (u < 0) continue;
        this.breaks.push({ s, u, vx: mx, vy: my });
      }
      if (this.breaks.length) this.applyBreaks();
    }
    return speed;
  }

  /** Something disturbed this web: an unfinished one is abandoned and its spider bolts. */
  private startle(web: Web, x: number, y: number): void {
    if (web.weaving) this.abortWeave(web, x, y);
    else this.spiderOf(web)?.flee(x, y);
  }

  private pin(p: Particle): { x: number; y: number } {
    const pin = p.pin!;
    const o = this.pinOut;
    if (pin.kind === 'viewport') {
      o.x = pin.ax * innerWidth + pin.dx;
      o.y = pin.ay * innerHeight + pin.dy;
    } else {
      o.x = pin.x - this.offX;
      o.y = pin.y - this.offY;
    }
    return o;
  }

  private integrate(only: Web | null): number {
    let motion = 0;
    let tails = 0;
    let falling = 0;
    const t = this.simTime;
    const wx = this.windX;
    const wy = this.windY;
    const windy = wx !== 0 || wy !== 0;
    for (const p of this.particles) {
      if (p.dead || (only && p.web !== only)) continue;
      if (p.pin) {
        const o = this.pin(p);
        motion += Math.abs(o.x - p.x) + Math.abs(o.y - p.y);
        p.x = p.px = o.x;
        p.y = p.py = o.y;
        continue;
      }
      if (!p.active) continue;
      let damping = DAMPING;
      let gravity = GRAVITY;
      let gustK = 1;
      if (p.falling) {
        falling++;
        damping = 0.955;
        gravity = this.reduced ? 0 : 0.07;
        gustK = 3;
        p.alpha -= p.fade;
      } else if (p.tail) {
        tails++;
        damping = 0.95;
        gravity = 0.022;
        gustK = 2.4;
        if (--p.life < 60) p.alpha = Math.max(0, p.life / 60);
      } else if (p.web.weaving) {
        damping = 0.9;
        gravity = 0;
        gustK = 0;
      }
      const vx = (p.x - p.px) * damping;
      const vy = (p.y - p.py) * damping;
      p.px = p.x;
      p.py = p.y;
      let fx = 0;
      let fy = 0;
      if (windy && gustK) {
        const swirl = Math.sin(p.x * 0.011 + t * 0.0021 + p.phase);
        const k = gustK * (0.55 + 0.45 * swirl);
        fx = wx * k;
        fy = wy * k + Math.cos(p.y * 0.013 + t * 0.0017 + p.phase) * Math.abs(wx) * 0.35 * gustK;
      }
      if (p.falling && !this.reduced) {
        // Air drag tumbles falling silk: it eddies rather than drops.
        fx += Math.sin(p.y * 0.02 + t * 0.003 + p.phase) * 0.035;
        fy -= Math.max(0, vy) * 0.02;
      }
      p.x += vx + fx;
      p.y += vy + gravity + fy;
      const m = Math.abs(vx) + Math.abs(vy);
      if (m > motion) motion = m;
    }
    if (!only) {
      this.tails = tails;
      this.falling = falling;
    }
    return motion;
  }

  private solve(only: Web | null): void {
    const strands = this.strands;
    for (let it = 0; it < ITERATIONS; it++) {
      for (let i = 0; i < strands.length; i++) {
        const s = strands[i];
        if (s.dead || s.f <= 0 || (only && s.web !== only)) continue;
        const a = s.a;
        const b = s.b;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
        if (it === 0 && a.falling && b.falling && s.rest > s.rest0 * 0.55) s.rest *= 0.996; // crumpling as it falls
        if (dist > s.rest * s.snap) {
          // Stretched too far: it snaps, somewhere along its length.
          if (s.kind === TAIL) s.dead = true;
          else this.breaks.push({ s, u: rand(0.3, 0.7), vx: 0, vy: 0 });
          s.dead = true;
          continue;
        }
        if (dist <= s.rest) continue; // slack threads just hang
        const wa = a.pin || !a.active ? 0 : 1;
        const wb = b.pin || !b.active ? 0 : 1;
        const total = wa + wb;
        if (!total) continue;
        const diff = ((dist - s.rest) / dist) * STIFFNESS;
        const ka = (diff * wa) / total;
        const kb = (diff * wb) / total;
        a.x += dx * ka;
        a.y += dy * ka;
        b.x -= dx * kb;
        b.y -= dy * kb;
      }
    }
  }

  /** Threads that just broke: recoil, curl, spark, and shake whoever lives there. */
  private applyBreaks(): void {
    const list = this.breaks;
    for (let i = 0; i < list.length; i++) {
      const { s, u, vx, vy } = list[i];
      if (s.dead && s.kind === TAIL) continue;
      const strain = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) / Math.max(1, s.rest);
      s.dead = true;
      if (s.kind === TAIL) continue;
      const x = s.a.x + (s.b.x - s.a.x) * u;
      const y = s.a.y + (s.b.y - s.a.y) * u;
      if (!this.reduced && this.sparks.length < 24) this.sparks.push({ x, y, life: 14, palette: s.web.palette });
      if (!this.reduced && this.particles.length < MAX_POINTS && !(s.a.falling && s.b.falling)) {
        this.spawnTail(s, s.a, x, y, u, strain, vx, vy, 1);
        this.spawnTail(s, s.b, x, y, 1 - u, strain, vx, vy, -1);
      }
      if (!s.web.weaving) this.spiderOf(s.web)?.flee(x, y);
      else this.abortWeave(s.web, x, y);
    }
    list.length = 0;
  }

  /** The broken end still tied to `anchor`: it whips back towards it and curls. */
  private spawnTail(s: Strand, anchor: Particle, bx: number, by: number, frac: number, strain: number, vx: number, vy: number, curl: number): void {
    const len = s.rest * frac;
    if (len < 7) return;
    const n = len > 34 ? 3 : len > 16 ? 2 : 1;
    const recoil = clamp((strain - 1) * 7 + 1, 1, 5);
    let prev = anchor;
    let prevS: Strand | null = null;
    for (let j = 1; j <= n; j++) {
      const t = j / n;
      const x = anchor.x + (bx - anchor.x) * t;
      const y = anchor.y + (by - anchor.y) * t;
      const p = this.particle(s.web, x, y);
      p.tail = true;
      p.active = true;
      p.life = Math.round(rand(160, 340));
      p.alpha = Math.min(s.a.alpha, s.b.alpha);
      const dx = anchor.x - x;
      const dy = anchor.y - y;
      const d = Math.hypot(dx, dy) || 1;
      const k = recoil * t;
      const side = curl * rand(0.4, 1.3) * t;
      const ivx = (dx / d) * k - (dy / d) * side + vx * 0.3 * t;
      const ivy = (dy / d) * k + (dx / d) * side + vy * 0.3 * t;
      p.px = x - ivx;
      p.py = y - ivy;
      if (s.a.falling || s.b.falling) {
        p.falling = true;
        p.fade = Math.max(s.a.fade, s.b.fade, FALL_FADE);
      }
      const st = this.strand(s.web, prev, p, TAIL, 0.9, 50);
      st.f = 1;
      st.weight = s.weight;
      if (prevS) {
        prevS.next = st;
        st.prev = prevS;
      }
      prev = p;
      prevS = st;
    }
  }

  private stepDew(): void {
    for (const d of this.dews) {
      const s = d.s;
      if (s.dead || !d.placed) continue;
      if (d.sliding) {
        const q = curvePoint(s, d.u);
        const len = Math.hypot(q.tx, q.ty) || 1;
        d.slide = (d.slide + (0.035 * q.ty) / len) * 0.965;
        d.u += d.slide / len;
        if (d.u < 0.05 || d.u > 0.95) {
          d.u = clamp(d.u, 0.05, 0.95);
          d.sliding = false;
          d.slide = 0;
        }
      }
      // The bead lags its thread a little, then swings back: a wobble.
      const q = curvePoint(s, d.u);
      const tx = q.x;
      const ty = q.y + d.r * 0.55;
      d.vx = (d.vx + (tx - d.x) * 0.22) * 0.78;
      d.vy = (d.vy + (ty - d.y) * 0.22) * 0.78;
      d.x += d.vx;
      d.y += d.vy;
    }
    for (let i = this.drips.length - 1; i >= 0; i--) {
      const r = this.drips[i];
      r.vy += 0.22;
      r.vx *= 0.99;
      r.x += r.vx;
      r.y += r.vy;
      if (r.y > innerHeight + 20) this.drips.splice(i, 1);
    }
  }

  /** Pieces no longer held by anything glued down drop away, tumbling, and fade. */
  private findFallen(): void {
    const ps = this.particles;
    const n = ps.length;
    if (this.parent.length < n) {
      const size = Math.max(256, n * 2);
      this.parent = new Int32Array(size);
      this.degree = new Int32Array(size);
      this.anchored = new Uint8Array(size);
      this.sumX = new Float64Array(size);
      this.sumY = new Float64Array(size);
      this.sumN = new Int32Array(size);
    }
    const parent = this.parent;
    const deg = this.degree;
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    for (let i = 0; i < n; i++) {
      ps[i].idx = i;
      parent[i] = i;
      deg[i] = 0;
    }
    for (const w of this.webs) {
      w.intact = 0;
      w.points = 0;
    }
    for (const s of this.strands) {
      if (s.dead || s.a.dead || s.b.dead) continue;
      if (s.kind !== STRAY && s.kind !== TAIL) s.web.intact++;
      if (s.f <= 0) continue;
      const ra = find(s.a.idx);
      const rb = find(s.b.idx);
      if (ra !== rb) parent[ra] = rb;
      deg[s.a.idx]++;
      deg[s.b.idx]++;
    }
    this.anchored.fill(0, 0, n);
    for (let i = 0; i < n; i++) if (ps[i].pin && !ps[i].dead) this.anchored[find(i)] = 1;
    this.sumN.fill(0, 0, n);
    let newlyFalling = false;
    for (let i = 0; i < n; i++) {
      const p = ps[i];
      if (p.dead) continue;
      p.web.points++;
      if (p.falling || p.web.weaving) continue;
      const web = p.web;
      const torn = web.total > 0 && web.intact < web.total * 0.6;
      if (torn) p.pin = undefined; // too damaged to hold: the whole web lets go
      const root = find(i);
      if (torn || !this.anchored[root]) {
        p.falling = true;
        p.active = true;
        p.fade = Math.max(p.fade, this.reduced ? REDUCED_FADE : FALL_FADE);
        this.sumX[root] += p.x;
        this.sumY[root] += p.y;
        this.sumN[root]++;
        newlyFalling = true;
      } else if (p.pin && deg[i] === 0) {
        p.dead = true; // a glued point with every thread cut is just gone
      }
    }
    if (newlyFalling && !this.reduced) {
      // Each fragment that lets go gets its own little spin and drift.
      for (let i = 0; i < n; i++) {
        const p = ps[i];
        if (p.dead || !p.falling) continue;
        const root = find(i);
        const m = this.sumN[root];
        if (!m) continue;
        const h = Math.sin(root * 12.9898 + m * 78.233) * 43758.5453;
        const r = h - Math.floor(h);
        const omega = (r - 0.5) * 0.018;
        const cx = this.sumX[root] / m;
        const cy = this.sumY[root] / m;
        p.px -= -omega * (p.y - cy) + (r - 0.5) * 0.5;
        p.py -= omega * (p.x - cx);
      }
    }
    for (const w of this.webs) w.live = 0;
    for (const s of this.strands) {
      if (s.dead || s.kind === STRAY || s.kind === TAIL || s.a.falling || s.b.falling || s.a.dead || s.b.dead) continue;
      s.web.live++;
    }
    for (const w of this.webs) if (w.weaving) w.live = Math.max(1, w.live);
    this.webs = this.webs.filter((w) => w.points > 0 || w.weaving);
    this.report();
  }

  /** Expose the web count on the host element, for tests and the curious. */
  private report(): void {
    const v = String(this.count);
    if (this.host && v !== this.reported) {
      this.host.dataset.webs = v;
      this.reported = v;
    }
  }

  private cull(): void {
    const h = innerHeight + 80;
    let any = false;
    for (const p of this.particles) {
      if (!p.dead && (p.alpha <= 0 || (p.falling && p.y > h) || (p.tail && p.life <= 0))) p.dead = true;
      if (p.dead) any = true;
    }
    if (any) {
      let j = 0;
      for (const p of this.particles) if (!p.dead) this.particles[j++] = p;
      this.particles.length = j;
    }
    let dead = false;
    for (const s of this.strands) {
      if (!s.dead && (s.a.dead || s.b.dead)) s.dead = true;
      if (s.dead) dead = true;
    }
    if (dead) {
      let j = 0;
      for (const s of this.strands) if (!s.dead) this.strands[j++] = s;
      this.strands.length = j;
      let k = 0;
      for (const d of this.dews) {
        if (!d.s.dead) this.dews[k++] = d;
        else if (d.placed && !this.reduced && !d.s.a.falling && this.drips.length < 40) {
          // Its thread broke: the bead falls.
          this.drips.push({ x: d.x, y: d.y, vx: d.vx * 0.5, vy: Math.max(0, d.vy), r: d.r });
        }
      }
      this.dews.length = k;
    }
    let s = 0;
    for (const sp of this.spiders) if (sp.state !== 'gone') this.spiders[s++] = sp;
    this.spiders.length = s;
  }

  // --- drawing ---------------------------------------------------------------

  /** Cache a strand's curve: smooth through a chain's joints, or sagging if slack. */
  private geometry(s: Strand): void {
    const a = s.a;
    const b = s.b;
    s.ax = a.x;
    s.ay = a.y;
    s.bx = b.x;
    s.by = b.y;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.0001;
    const chain = s.kind === RADIAL || s.kind === DRAG || s.kind === TAIL || (s.kind === STRAY && (s.prev || s.next));
    if (chain) {
      const p0 = s.prev && !s.prev.dead ? s.prev.a : a;
      const p3 = s.next && !s.next.dead ? s.next.b : b;
      s.c1x = a.x + (b.x - p0.x) / 6;
      s.c1y = a.y + (b.y - p0.y) / 6;
      s.c2x = b.x - (p3.x - a.x) / 6;
      s.c2y = b.y - (p3.y - a.y) / 6;
      s.qx = (3 * (s.c1x + s.c2x) - (a.x + b.x)) / 4;
      s.qy = (3 * (s.c1y + s.c2y) - (a.y + b.y)) / 4;
      s.flat = Math.abs((s.qx - a.x) * dy - (s.qy - a.y) * dx) / d < 0.4;
      return;
    }
    let qx = (a.x + b.x) / 2;
    let qy = (a.y + b.y) / 2;
    const slack = s.rest - d;
    s.flat = true;
    if (slack > 0.02) {
      // A slack thread sags like a catenary: depth from its spare length.
      let h = Math.min(Math.sqrt((3 * d * slack) / 8), d * 0.32);
      let nx = -dy / d;
      let ny = dx / d;
      const gx = this.windX * 8;
      const gy = 1;
      const dot = nx * gx + ny * gy;
      if (dot < 0) {
        nx = -nx;
        ny = -ny;
      }
      h *= 0.3 + 0.7 * Math.min(1, Math.abs(dot));
      qx += nx * h * 2;
      qy += ny * h * 2;
      s.flat = h < 0.2;
    }
    s.qx = qx;
    s.qy = qy;
    s.c1x = a.x + ((qx - a.x) * 2) / 3;
    s.c1y = a.y + ((qy - a.y) * 2) / 3;
    s.c2x = b.x + ((qx - b.x) * 2) / 3;
    s.c2y = b.y + ((qy - b.y) * 2) / 3;
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.lineCap = 'round';
    const strands = this.strands;
    const n = strands.length;
    if (this.order.length < n) this.order = new Int32Array(Math.max(512, n * 2));
    const counts = this.bucketCount;
    counts.fill(0);
    // Pass 0: geometry and bucket (palette x width x opacity), counting sort.
    for (let i = 0; i < n; i++) {
      const s = strands[i];
      s.vis = false;
      if (s.dead || s.f <= 0) continue;
      this.geometry(s);
      const b = this.bucket(s);
      s.bucket = b;
      if (b < 0) continue;
      s.vis = true;
      counts[b]++;
    }
    let acc = 0;
    for (let b = 0; b < counts.length; b++) {
      this.bucketStart[b] = acc;
      acc += counts[b];
    }
    const fill = this.bucketCount;
    fill.fill(0);
    for (let i = 0; i < n; i++) {
      const s = strands[i];
      if (!s.vis) continue;
      const b = s.bucket;
      this.order[this.bucketStart[b] + fill[b]++] = i;
    }

    // Pass 1 and 2: a soft dark line under a fine light one.
    for (let pass = 0; pass < 2; pass++) {
      for (let b = 0; b < fill.length; b++) {
        const count = fill[b];
        if (!count) continue;
        const level = (b % LEVELS) + 1;
        const cls = Math.floor(b / LEVELS) % 2;
        const pal = Math.floor(b / (LEVELS * 2));
        if (pass === 0 && pal === 2) continue; // a dark shadow on a dark page shows nothing
        ctx.strokeStyle = strokeStyles[pal][pass][cls][level];
        ctx.lineWidth = pass ? CORE_WIDTH[cls] : SHADOW_WIDTH[cls];
        ctx.beginPath();
        const start = this.bucketStart[b];
        for (let k = 0; k < count; k++) this.trace(ctx, strands[this.order[start + k]]);
        ctx.stroke();
      }
    }

    if (!this.reduced) this.drawLight(ctx);
    this.drawDew(ctx);

    for (const sp of this.spiders) sp.draw(ctx, sp.web.palette === 0);
  }

  private bucket(s: Strand): number {
    let alpha = s.weight * Math.min(s.a.alpha, s.b.alpha);
    if (s.web.fadeIn && s.web.weaving) alpha *= clamp(s.web.clock / s.web.weaveMs, 0, 1);
    if (s.kind === TAIL) alpha *= 0.85;
    const level = Math.round(clamp(alpha, 0, 1) * LEVELS);
    if (level <= 0) return -1;
    const cls = s.kind === RADIAL || s.kind === FRAME || s.kind === DRAG ? 0 : 1;
    return (s.web.palette * 2 + cls) * LEVELS + level - 1;
  }

  private trace(ctx: CanvasRenderingContext2D, s: Strand): void {
    if (s.f >= 1) {
      ctx.moveTo(s.ax, s.ay);
      if (s.flat) ctx.lineTo(s.bx, s.by);
      else ctx.bezierCurveTo(s.c1x, s.c1y, s.c2x, s.c2y, s.bx, s.by);
    } else if (s.rev) {
      tracePart(ctx, s, 1 - s.f, 1);
    } else {
      tracePart(ctx, s, 0, s.f);
    }
  }

  /**
   * Light on silk: where a thread's tangent turns square to the light it
   * flashes, with a rainbow sheen around the spot. The light drifts slowly,
   * and as threads sway the glints slide along them.
   */
  private drawLight(ctx: CanvasRenderingContext2D): void {
    const t = this.simTime;
    const phi = 0.85 + 0.55 * Math.sin(t * 0.00009);
    const lx = Math.cos(phi);
    const ly = Math.sin(phi);
    const vw = innerWidth;
    const vh = innerHeight;
    const cx = vw * (0.5 + 0.38 * Math.sin(t * 0.00006));
    const cy = vh * (0.4 + 0.3 * Math.sin(t * 0.000083 + 1.3));
    const sigma2 = 2 * (0.42 * Math.max(vw, vh)) ** 2;
    let g = 0;
    const strands = this.strands;
    for (let i = 0; i < strands.length && g < MAX_GLINTS; i++) {
      const s = strands[i];
      if (!s.vis || s.kind === TAIL) continue;
      const pLx = (s.qx - s.ax) * lx + (s.qy - s.ay) * ly;
      const qLx = (s.bx - s.qx) * lx + (s.by - s.qy) * ly;
      if (pLx * qLx >= 0) continue;
      const u = pLx / (pLx - qLx);
      if (u < 0.04 || u > 0.96) continue;
      if (s.f < 1 && (s.rev ? u < 1 - s.f : u > s.f)) continue;
      const q = curvePoint(s, u);
      const pool = Math.exp(-((q.x - cx) ** 2 + (q.y - cy) ** 2) / sigma2);
      const shimmer = 0.85 + 0.15 * Math.sin(t * 0.004 + s.phase * 40);
      const intensity = (0.15 + 0.85 * pool) * s.weight * Math.min(s.a.alpha, s.b.alpha) * shimmer;
      if (intensity < 0.18) continue;
      this.glintS[g] = i;
      this.glintU[g] = u;
      this.glintI[g] = intensity;
      g++;
    }
    // Sheen: a short iridescent stretch of thread around each glint.
    ctx.lineWidth = 1.1;
    for (let k = 0; k < g; k++) {
      const s = strands[this.glintS[k]];
      const u = this.glintU[k];
      const len = Math.hypot(s.bx - s.ax, s.by - s.ay) || 1;
      const du = clamp(9 / len, 0.05, 0.35);
      const hue = Math.floor(((s.web.hue + u * 0.3 + s.phase * 0.25 + (s.ax + s.ay) * 0.0012 + t * 0.00003) % 1) * HUES) % HUES;
      const level = Math.round(clamp(this.glintI[k], 0, 1) * LEVELS);
      if (!level) continue;
      ctx.strokeStyle = sheenStyles[s.web.palette][hue][level];
      ctx.beginPath();
      tracePart(ctx, s, Math.max(0, u - du), Math.min(1, u + du));
      ctx.stroke();
    }
    // Glints and the sparks of snapping threads.
    for (const lighter of [true, false]) {
      ctx.globalCompositeOperation = lighter ? 'lighter' : 'source-over';
      for (let k = 0; k < g; k++) {
        const s = strands[this.glintS[k]];
        if ((s.web.palette !== 0) !== lighter) continue;
        const i = this.glintI[k];
        if (i < 0.32) continue;
        const q = curvePoint(s, this.glintU[k]);
        const size = 3 + 6 * i;
        const hue = Math.floor((s.web.hue + s.phase) * HUES) % HUES;
        ctx.globalAlpha = Math.min(1, i * (lighter ? 0.95 : 0.7));
        ctx.drawImage(glintSprite(hue), q.x - size / 2, q.y - size / 2, size, size);
      }
      for (const sp of this.sparks) {
        if ((sp.palette !== 0) !== lighter) continue;
        const k = sp.life / 14;
        const size = 4 + 10 * k;
        ctx.globalAlpha = k * 0.9;
        ctx.drawImage(glintSprite(Math.floor(sp.x + sp.y) % HUES), sp.x - size / 2, sp.y - size / 2, size, size);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawDew(ctx: CanvasRenderingContext2D): void {
    const sprite = dewSprite();
    for (const d of this.dews) {
      const s = d.s;
      if (s.dead || !s.vis) continue;
      if (s.f < 1 && (s.rev ? d.u < 1 - s.f : d.u > s.f)) continue;
      if (!d.placed) {
        const q = curvePoint(s, d.u);
        d.x = q.x;
        d.y = q.y + d.r * 0.55;
        d.placed = true;
      }
      const alpha = Math.min(s.a.alpha, s.b.alpha) * (s.web.fadeIn && s.web.weaving ? clamp(s.web.clock / s.web.weaveMs, 0, 1) : 1);
      if (alpha <= 0.02) continue;
      // Squash and stretch with the wobble.
      const v = clamp(Math.hypot(d.vx, d.vy) * 0.25, 0, 0.35);
      const sx = d.r * (1 + v);
      const sy = d.r * (1 - v * 0.6) * 1.08;
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprite, d.x - 1.6 * sx, d.y - 1.6 * sy, 3.2 * sx, 3.2 * sy);
    }
    for (const r of this.drips) {
      ctx.globalAlpha = clamp(1 - r.vy / 14, 0.2, 1);
      ctx.drawImage(sprite, r.x - 1.6 * r.r, r.y - 1.6 * r.r * 1.2, 3.2 * r.r, 3.2 * r.r * 1.2);
    }
    ctx.globalAlpha = 1;
  }

  private teardown(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.host?.remove();
    this.host = this.canvas = null;
    this.ctx = null;
    this.particles = [];
    this.strands = [];
    this.webs = [];
    this.spiders = [];
    this.dews = [];
    this.drips = [];
    this.sparks = [];
    this.breaks = [];
    this.falling = this.tails = 0;
    dropSprites();
    dropSpiderSprites();
  }
}
