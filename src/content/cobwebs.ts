// Cobwebs that gather over a neglected page and tear away when disturbed.
// Each web is a little Verlet cloth drawn on a canvas overlay. Some threads are
// glued to the window frame and some to the page content, so scrolling stretches
// them until they snap, and a sweeping mouse cuts and flings them. The page
// itself is never touched: the overlay ignores pointer events and is removed
// once the last strand has fallen away.

type Pin =
  | { kind: 'viewport'; ax: number; ay: number; dx: number; dy: number }
  | { kind: 'page'; x: number; y: number };

interface Web {
  slot: string;
  born: number;
  weaveMs: number;
  /** Strands it was spun with; once too many are torn the rest lets go. */
  total: number;
  spider?: Particle;
}

interface Particle {
  x: number;
  y: number;
  px: number;
  py: number;
  pin?: Pin;
  web: Web;
  alpha: number;
  falling: boolean;
  dew: boolean;
  active: boolean;
}

interface Strand {
  a: Particle;
  b: Particle;
  rest: number;
  snap: number;
  web: Web;
  revealAt: number;
  revealMs: number;
}

const OUR_ATTR = 'data-haunted-tabs';
const MAX_WEBS = 8;
const GRAVITY = 0.06;
const DAMPING = 0.985;
const ITERATIONS = 4;
const CUT_SPEED = 4;
const TOUCH_RADIUS = 34;

const rand = (min: number, max: number) => min + Math.random() * (max - min);

export class Cobwebs {
  private host: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private particles: Particle[] = [];
  private strands: Strand[] = [];
  private raf = 0;
  private calmFrames = 0;
  private frame = 0;
  private liveWebs = new Set<Web>();

  private pointer = { x: 0, y: 0, lastX: 0, lastY: 0, seen: false };
  private offX = 0;
  private offY = 0;
  private winX = scrollX;
  private winY = scrollY;
  private elementScroll = new WeakMap<Element, { left: number; top: number }>();

  private growAfterMs = 0;
  private growTimer: number | undefined;
  private lastActivity = Date.now();
  private lastGrowth = Date.now();
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private listening = false;

  get count(): number {
    return this.liveWebs.size;
  }

  /** Lay `count` webs over the page, already spun, as if they grew while you were away. */
  add(count: number, weave = false): void {
    if (count <= 0) return;
    const want = Math.min(MAX_WEBS, this.liveWebs.size + count);
    while (this.liveWebs.size < want) {
      const slot = this.freeSlot();
      const web: Web = { slot, born: weave ? performance.now() : -Infinity, weaveMs: weave ? 9000 : 0, total: 0 };
      if (slot === 'hang') this.buildHanging(web);
      else if (slot.startsWith('free')) this.buildFree(web);
      else this.buildCorner(web, slot === 'tr' || slot === 'br' ? 1 : 0, slot === 'bl' || slot === 'br' ? 1 : 0);
      this.liveWebs.add(web);
    }
    this.updateActive();
    this.ensureCanvas();
    this.report();
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
      if (this.liveWebs.size < MAX_WEBS) this.add(1, true);
    }, 1000);
  }

  /** Stop growing and let every strand fall away. */
  sweep(): void {
    this.growAfterMs = 0;
    if (this.growTimer !== undefined) clearInterval(this.growTimer);
    this.growTimer = undefined;
    // Hidden pages get no animation frames, so make sure the webs go even then.
    if (document.visibilityState === 'visible' && this.particles.length) this.fadeAll();
    else this.teardown();
    setTimeout(() => (this.particles.length || this.host) && this.teardown(), 2500);
  }

  // --- building --------------------------------------------------------------

  private freeSlot(): string {
    const taken = new Set([...this.liveWebs].map((w) => w.slot));
    const corners = ['tl', 'tr', 'bl', 'br'].filter((c) => !taken.has(c)).sort(() => Math.random() - 0.5);
    if (corners.length) return corners[0];
    if (!taken.has('hang')) return 'hang';
    return `free${Math.random()}`;
  }

  private particle(web: Web, x: number, y: number, pin?: Pin): Particle {
    const p: Particle = { x, y, px: x, py: y, pin, web, alpha: 1, falling: false, dew: Math.random() < 0.12, active: false };
    this.particles.push(p);
    return p;
  }

  private viewportPin(x: number, y: number, ax: number, ay: number): Pin {
    return { kind: 'viewport', ax, ay, dx: x - ax * innerWidth, dy: y - ay * innerHeight };
  }

  private pagePin(x: number, y: number): Pin {
    return { kind: 'page', x: x + this.offX, y: y + this.offY };
  }

  private strand(web: Web, a: Particle, b: Particle, snap: number, slack = 1): Strand {
    const s: Strand = { a, b, rest: Math.hypot(a.x - b.x, a.y - b.y) * slack, snap, web, revealAt: 0, revealMs: 1 };
    this.strands.push(s);
    return s;
  }

  /** Spokes first, then the rings spiralling outwards, like a spider would. */
  private schedule(web: Web, order: Strand[]): void {
    web.total = order.length;
    const step = web.weaveMs / Math.max(1, order.length);
    order.forEach((s, i) => {
      s.revealAt = i * step;
      s.revealMs = Math.max(1, step * 1.6);
    });
  }

  /** A web filling a corner of the window: two edges glued to the frame, the rest to the page. */
  private buildCorner(web: Web, ax: number, ay: number): void {
    const vw = innerWidth;
    const vh = innerHeight;
    const radius = Math.min(280, Math.max(110, Math.min(vw, vh) * rand(0.2, 0.32)));
    const cx = ax ? vw - 1 : 1;
    const cy = ay ? vh - 1 : 1;
    const sx = ax ? -1 : 1;
    const sy = ay ? -1 : 1;
    const spokes = Math.round(rand(6, 9));
    const rings = Math.round(rand(5, 8));
    const hub = this.particle(web, cx, cy, this.viewportPin(cx, cy, ax, ay));
    const grid: Particle[][] = [];
    const spokeStrands: Strand[] = [];
    for (let i = 0; i < spokes; i++) {
      const theta = (i / (spokes - 1)) * (Math.PI / 2) + (i > 0 && i < spokes - 1 ? rand(-0.06, 0.06) : 0);
      const edge = i === 0 || i === spokes - 1;
      const row: Particle[] = [];
      let prev = hub;
      for (let k = 1; k <= rings; k++) {
        const r = radius * Math.pow(k / rings, 0.85) * (edge ? 1 : rand(0.94, 1.06));
        const x = cx + sx * Math.cos(theta) * r;
        const y = cy + sy * Math.sin(theta) * r;
        let pin: Pin | undefined;
        if (edge) pin = this.viewportPin(x, y, ax, ay);
        else if (k === rings && Math.random() < 0.6) pin = this.pagePin(x, y);
        const p = this.particle(web, x, y, pin);
        spokeStrands.push(this.strand(web, prev, p, 1.8));
        row.push(p);
        prev = p;
      }
      grid.push(row);
    }
    const ringStrands: Strand[] = [];
    for (let k = 0; k < rings; k++) {
      for (let i = 0; i < spokes - 1; i++) ringStrands.push(this.strand(web, grid[i][k], grid[i + 1][k], 1.6, 1.07));
    }
    this.schedule(web, [...spokeStrands, ...ringStrands]);
  }

  /** A small orb web hanging on one thread from the top of the window, with its spider. */
  private buildHanging(web: Web): void {
    const vw = innerWidth;
    const topX = rand(0.3, 0.7) * vw;
    const depth = rand(0.22, 0.4) * innerHeight;
    const radius = rand(46, 78);
    const top = this.particle(web, topX, 0, this.viewportPin(topX, 0, 0, 0));
    const order: Strand[] = [];
    let prev = top;
    const links = 7;
    for (let k = 1; k <= links; k++) {
      const p = this.particle(web, topX, (depth * k) / links);
      p.dew = false;
      order.push(this.strand(web, prev, p, 2.2));
      prev = p;
    }
    const hub = prev;
    web.spider = hub;
    this.orb(web, hub, radius, Math.round(rand(8, 11)), 4, 0.35, order);
  }

  /** An orb web strung across open page, every spoke glued to the content. */
  private buildFree(web: Web): void {
    const x = rand(0.2, 0.8) * innerWidth;
    const y = rand(0.25, 0.8) * innerHeight;
    const hub = this.particle(web, x, y);
    this.orb(web, hub, rand(70, 140), Math.round(rand(9, 13)), Math.round(rand(5, 7)), 1, []);
  }

  private orb(web: Web, hub: Particle, radius: number, spokes: number, rings: number, pinChance: number, order: Strand[]): void {
    const grid: Particle[][] = [];
    const spokeStrands: Strand[] = [];
    for (let i = 0; i < spokes; i++) {
      const theta = (i / spokes) * Math.PI * 2 + rand(-0.08, 0.08);
      const row: Particle[] = [];
      let prev = hub;
      for (let k = 1; k <= rings; k++) {
        const r = radius * (k / rings) * rand(0.93, 1.07);
        const px = hub.x + Math.cos(theta) * r;
        const py = hub.y + Math.sin(theta) * r;
        const pin = k === rings && Math.random() < pinChance ? this.pagePin(px, py) : undefined;
        const p = this.particle(web, px, py, pin);
        spokeStrands.push(this.strand(web, prev, p, 1.8));
        row.push(p);
        prev = p;
      }
      grid.push(row);
    }
    const ringStrands: Strand[] = [];
    for (let k = 0; k < rings; k++) {
      for (let i = 0; i < spokes; i++) ringStrands.push(this.strand(web, grid[i][k], grid[(i + 1) % spokes][k], 1.6, 1.05));
    }
    this.schedule(web, [...order, ...spokeStrands, ...ringStrands]);
  }

  // --- canvas and input ------------------------------------------------------

  private ensureCanvas(): void {
    if (this.host?.isConnected) return;
    const host = document.createElement('div');
    host.setAttribute(OUR_ATTR, 'cobwebs');
    const root = host.attachShadow({ mode: 'closed' });
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646;';
    root.append(canvas);
    document.documentElement.appendChild(host);
    this.host = host;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resize();
    this.listen();
  }

  private resize = (): void => {
    if (!this.canvas || !this.ctx) return;
    const dpr = devicePixelRatio || 1;
    this.canvas.width = Math.round(innerWidth * dpr);
    this.canvas.height = Math.round(innerHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
  }

  private onActivity = (): void => {
    this.lastActivity = Date.now();
    if (this.reduced && this.particles.length) this.fadeAll();
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
    if (this.reduced && Math.hypot(e.movementX, e.movementY) > 2) this.fadeAll();
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
      if (!p.pin) {
        p.px += dx * 0.25;
        p.py += dy * 0.25;
      }
    }
    if (this.reduced) this.fadeAll();
    this.wake();
  };

  private fadeAll(): void {
    for (const p of this.particles) {
      p.pin = undefined;
      p.falling = true;
    }
    this.wake();
  }

  private wake(): void {
    this.calmFrames = 0;
    if (!this.raf && this.particles.length) this.raf = requestAnimationFrame(this.tick);
  }

  // --- simulation ------------------------------------------------------------

  private reveal(s: Strand, now: number): number {
    if (s.web.born === -Infinity) return 1;
    return Math.min(1, Math.max(0, (now - s.web.born - s.revealAt) / s.revealMs));
  }

  private updateActive(): void {
    const now = performance.now();
    for (const p of this.particles) p.active = !!p.pin || p.falling;
    for (const s of this.strands) {
      if (this.reveal(s, now) > 0) s.a.active = s.b.active = true;
    }
  }

  private tick = (): void => {
    this.raf = 0;
    const now = performance.now();
    this.frame++;
    this.updateActive();
    let motion = this.pointerSweep();
    motion += this.integrate(now);
    this.solve(now);
    if (this.frame % 6 === 0) this.findFallen(now);
    this.cull();
    this.draw(now);

    const weaving = [...this.liveWebs].some((w) => now - w.born < w.weaveMs + 2000);
    const falling = this.particles.some((p) => p.falling);
    this.calmFrames = motion < 0.05 && !weaving && !falling ? this.calmFrames + 1 : 0;
    if (this.particles.length === 0) {
      this.teardown();
    } else if (this.calmFrames < 45) {
      this.raf = requestAnimationFrame(this.tick);
    }
  };

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
    for (const p of this.particles) {
      if (!p.active) continue;
      const d = distToSegment(p.x, p.y, ax, ay, ptr.x, ptr.y);
      if (d > TOUCH_RADIUS) continue;
      const push = (1 - d / TOUCH_RADIUS) * 0.7;
      if (p.pin && speed > CUT_SPEED * 1.5 && d < TOUCH_RADIUS / 2) p.pin = undefined;
      if (!p.pin) {
        p.x += mx * push;
        p.y += my * push;
      }
    }
    if (speed > CUT_SPEED) {
      this.strands = this.strands.filter((s) => !(s.a.active && s.b.active && segmentsCross(ax, ay, ptr.x, ptr.y, s.a.x, s.a.y, s.b.x, s.b.y)));
    }
    return speed;
  }

  private weaving(web: Web, now: number): boolean {
    return now - web.born < web.weaveMs;
  }

  private integrate(now: number): number {
    let motion = 0;
    for (const p of this.particles) {
      if (p.pin) {
        const t = this.pinTarget(p.pin);
        motion += Math.abs(t.x - p.x) + Math.abs(t.y - p.y);
        p.x = p.px = t.x;
        p.y = p.py = t.y;
        continue;
      }
      if (!p.active) continue;
      const damping = p.falling ? 0.97 : DAMPING;
      const vx = (p.x - p.px) * damping;
      const vy = (p.y - p.py) * damping;
      p.px = p.x;
      p.py = p.y;
      p.x += vx;
      // Half-spun webs hold their shape until the spider is done.
      const gravity = p.falling ? (this.reduced ? 0 : 0.16) : this.weaving(p.web, now) ? 0 : GRAVITY;
      p.y += vy + gravity;
      if (p.falling) p.alpha -= this.reduced ? 0.03 : 0.012;
      motion = Math.max(motion, Math.abs(vx) + Math.abs(vy));
    }
    return motion;
  }

  private pinTarget(pin: Pin): { x: number; y: number } {
    if (pin.kind === 'viewport') return { x: pin.ax * innerWidth + pin.dx, y: pin.ay * innerHeight + pin.dy };
    return { x: pin.x - this.offX, y: pin.y - this.offY };
  }

  private solve(now: number): void {
    for (let it = 0; it < ITERATIONS; it++) {
      const kept: Strand[] = [];
      for (const s of this.strands) {
        if (this.reveal(s, now) <= 0) {
          kept.push(s);
          continue;
        }
        const { a, b } = s;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.0001;
        if (dist > s.rest * s.snap) continue; // stretched too far: it snaps
        kept.push(s);
        if (dist <= s.rest) continue; // slack threads just hang
        const diff = (dist - s.rest) / dist;
        const wa = a.pin ? 0 : 1;
        const wb = b.pin ? 0 : 1;
        const total = wa + wb;
        if (!total) continue;
        a.x += dx * diff * (wa / total);
        a.y += dy * diff * (wa / total);
        b.x -= dx * diff * (wb / total);
        b.y -= dy * diff * (wb / total);
      }
      this.strands = kept;
    }
  }

  /** Pieces no longer held by anything glued down drop away and fade. */
  private findFallen(now: number): void {
    const parent = new Map<Particle, Particle>();
    const find = (p: Particle): Particle => {
      let r = p;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(p, r);
      return r;
    };
    for (const p of this.particles) parent.set(p, p);
    for (const s of this.strands) {
      if (this.reveal(s, now) <= 0) continue;
      const ra = find(s.a);
      const rb = find(s.b);
      if (ra !== rb) parent.set(ra, rb);
    }
    const anchored = new Set<Particle>();
    for (const p of this.particles) if (p.pin) anchored.add(find(p));
    const left = new Map<Web, number>();
    for (const s of this.strands) left.set(s.web, (left.get(s.web) ?? 0) + 1);
    for (const p of this.particles) {
      // Inactive points in a finished web have had every thread cut: orphans fall too.
      if (p.falling || this.weaving(p.web, now)) continue;
      const torn = (left.get(p.web) ?? 0) < p.web.total * 0.6;
      if (torn) p.pin = undefined; // too damaged to hold: the whole web lets go
      if (torn || !anchored.has(find(p))) p.falling = true;
    }
    this.liveWebs = new Set(this.strands.filter((s) => !s.a.falling && !s.b.falling).map((s) => s.web));
    this.report();
  }

  /** Expose the web count on the host element, for tests and the curious. */
  private report(): void {
    if (this.host) this.host.dataset.webs = String(this.liveWebs.size);
  }

  private cull(): void {
    const h = innerHeight + 80;
    const gone = (p: Particle) => p.alpha <= 0 || (p.falling && p.y > h);
    if (!this.particles.some(gone)) return;
    this.particles = this.particles.filter((p) => !gone(p));
    const alive = new Set(this.particles);
    this.strands = this.strands.filter((s) => alive.has(s.a) && alive.has(s.b));
  }

  // --- drawing ---------------------------------------------------------------

  private draw(now: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.lineCap = 'round';
    // Two passes, dark under light, so threads show on white pages and dark ones.
    for (const pass of [0, 1]) {
      ctx.lineWidth = pass ? 0.8 : 1.8;
      for (const s of this.strands) {
        const f = this.reveal(s, now);
        if (f <= 0) continue;
        const alpha = Math.max(0, Math.min(s.a.alpha, s.b.alpha));
        ctx.strokeStyle = pass ? `rgba(240, 241, 248, ${0.75 * alpha})` : `rgba(0, 0, 0, ${0.2 * alpha})`;
        ctx.beginPath();
        ctx.moveTo(s.a.x, s.a.y);
        ctx.lineTo(s.a.x + (s.b.x - s.a.x) * f, s.a.y + (s.b.y - s.a.y) * f);
        ctx.stroke();
      }
    }
    for (const p of this.particles) {
      if (!p.dew || !p.active || p.pin) continue;
      ctx.fillStyle = `rgba(255, 255, 255, ${0.9 * p.alpha})`;
      ctx.strokeStyle = `rgba(0, 0, 0, ${0.3 * p.alpha})`;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    for (const web of new Set(this.particles.map((p) => p.web))) {
      if (web.spider && web.spider.active && this.particles.includes(web.spider)) this.drawSpider(ctx, web.spider, now);
    }
  }

  private drawSpider(ctx: CanvasRenderingContext2D, p: Particle, now: number): void {
    ctx.save();
    ctx.translate(p.x, p.y + 6);
    ctx.globalAlpha = Math.max(0, p.alpha);
    const twitch = Math.sin(now / 180) * (p.falling ? 0.5 : 0.08);
    ctx.strokeStyle = '#141414';
    ctx.lineWidth = 1.3;
    for (const side of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const a = (-0.9 + i * 0.6 + twitch * (i % 2 ? 1 : -1)) * side;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        const kx = side * 7 + Math.sin(a) * 2;
        const ky = -4 + i * 3;
        ctx.lineTo(kx, ky - 3);
        ctx.lineTo(kx + side * 4, ky + 3);
        ctx.stroke();
      }
    }
    ctx.fillStyle = '#121212';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.ellipse(0, 3, 4.2, 5.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -3.2, 2.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ff2a2a';
    ctx.fillRect(-1.4, -3.8, 0.9, 0.9);
    ctx.fillRect(0.5, -3.8, 0.9, 0.9);
    ctx.restore();
  }

  private teardown(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.host?.remove();
    this.host = this.canvas = null;
    this.ctx = null;
    this.particles = [];
    this.strands = [];
    this.liveWebs.clear();
  }
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function segmentsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
