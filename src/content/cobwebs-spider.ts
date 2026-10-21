// The spider that spins the webs and lives on them. Eight two-jointed legs
// placed by inverse kinematics, an alternating tetrapod gait while it walks,
// feet that hold on to the threads while it sits, and a dragline it can climb
// or drop on. Body plan in local units: +x is where the head points.

import type { Particle, Web } from './cobwebs-model';
import { clamp, rand } from './cobwebs-model';

export interface SpiderWorld {
  offX: number;
  offY: number;
  vw: number;
  vh: number;
  /** Current breeze, for swinging on a line. */
  windX: number;
  ptrX: number;
  ptrY: number;
  ptrSeen: boolean;
  /** The nearest live point of a web, to hold on to. */
  near(web: Web, x: number, y: number, r: number): Particle | null;
}

/** A place to walk to: a web point (followed as it moves), a page point, or a window point. */
interface Way {
  p: Particle | null;
  x: number;
  y: number;
  page: boolean;
}

interface LegState {
  i: number;
  side: number;
  grp: number;
  fx: number;
  fy: number;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  /** Step progress 0..1, or -1 while the foot is planted. */
  t: number;
  hold: Particle | null;
  hx: number;
  hy: number;
  lift: number;
  femur: number;
  tibia: number;
}

// Hips around the cephalothorax and resting feet, per leg pair (y is mirrored).
const HIP = [
  [4.8, 1.4],
  [3.8, 2.0],
  [2.7, 2.1],
  [1.7, 1.6],
];
const REST = [
  [18.0, 9.6],
  [8.6, 15.0],
  [-3.0, 11.6],
  [-12.6, 8.2],
];
// Legs drawn in, as when it is falling or clinging to a single line.
const TUCK = [
  [14.5, 4.2],
  [8.5, 7.5],
  [-2.5, 6.8],
  [-11.5, 3.8],
];
const SPINNERET = -9.9;
const STEP = 1000 / 60;

const bodySprites: (HTMLCanvasElement | null)[] = [null, null];
let shadowSprite: HTMLCanvasElement | null = null;

export class Spider {
  x: number;
  y: number;
  angle = Math.PI / 2;
  state: 'weave' | 'sit' | 'walk' | 'drop' | 'gone' = 'weave';
  alpha = 0;
  fading = false;
  readonly scale = rand(0.78, 0.95);

  private targetAngle = Math.PI / 2;
  private vx = 0;
  private vy = 0;
  private lastX: number;
  private lastY: number;
  private seat: Particle | null = null;
  private seatX = 0;
  private seatY = 0;
  private path: Way[] = [];
  private pathI = 0;
  private speed = 0;
  private maxSpeed = 4;
  private then: 'sit' | 'gone' = 'gone';
  private anchor: Way | null = null;
  private line = 0;
  private lineTarget = 0;
  private dropPhase: 'fall' | 'dangle' | 'climb' = 'fall';
  private timer = 0;
  private ox = 0;
  private oy = 0;
  private spin = 0;
  private spinV = 0;
  private gather = 0;
  private gatherTarget = 0;
  private t = rand(0, 10_000);
  private gait = 0;
  private twitchLeg = -1;
  private twitchT = 0;
  private palp = 0;
  private palpTarget = 0;
  private legs: LegState[] = [];

  constructor(
    readonly web: Web,
    x: number,
    y: number,
    private readonly world: SpiderWorld,
  ) {
    this.x = this.lastX = x;
    this.y = this.lastY = y;
    for (let i = 0; i < 4; i++) {
      for (const side of [-1, 1]) {
        const reach = Math.hypot(REST[i][0] - HIP[i][0], REST[i][1] - HIP[i][1]) * this.scale;
        const leg: LegState = {
          i,
          side,
          grp: (i + (side > 0 ? 1 : 0)) % 2,
          fx: 0, fy: 0, sx: 0, sy: 0, tx: 0, ty: 0,
          t: -1,
          hold: null,
          hx: 0,
          hy: 0,
          lift: 0,
          femur: reach * 0.56,
          tibia: reach * 0.62,
        };
        this.restWorld(leg);
        leg.fx = rw.x;
        leg.fy = rw.y;
        this.legs.push(leg);
      }
    }
  }

  /** Still worth animating frames for: anything but sitting quietly or gone. */
  get busy(): boolean {
    if (this.state === 'gone') return false;
    if (this.state !== 'sit' || this.fading || this.alpha < 1 || this.twitchLeg >= 0) return true;
    return this.legs.some((l) => l.t >= 0) || Math.abs(this.angle - this.targetAngle) > 0.01;
  }

  get sitting(): boolean {
    return this.state === 'sit';
  }

  // --- orders from the web ---------------------------------------------------

  /** While weaving, the web says where the spinning tip is. */
  follow(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  /** Settle on a point of the web, head down, feet on the threads. */
  sit(p: Particle): void {
    this.state = 'sit';
    this.seat = p;
    this.seatX = this.x - p.x;
    this.seatY = this.y - p.y;
    this.targetAngle = Math.PI / 2 + rand(-0.25, 0.25);
    this.gatherTarget = 0;
    this.grip();
  }

  /** Something came too close or shook the web: get away, one way or another. */
  flee(fromX: number, fromY: number): void {
    if (this.state === 'gone' || this.state === 'walk' || this.state === 'drop') return;
    const web = this.web;
    const drag = web.dragline;
    if (drag.length && drag.every((s) => !s.dead) && this.seat === web.hub) {
      // Straight back up its own dragline and out of the window.
      const way: Way[] = [];
      for (let i = drag.length - 1; i >= 0; i--) way.push(this.way(drag[i].a));
      const top = drag[0].a;
      way.push({ p: null, x: top.x, y: -40, page: false });
      this.walk(way, 4.6, 'gone');
      this.gatherTarget = 0.6;
      return;
    }
    if (fromY < this.y - 6 || !web.radials.length) {
      this.drop(this.seat && !this.seat.falling ? this.seat : null);
      return;
    }
    // Run out along the radial pointing furthest from the trouble, then off the page.
    let best: Particle[] | null = null;
    let bestScore = -Infinity;
    for (const r of web.radials) {
      const end = r[r.length - 1];
      if (!end || end.dead) continue;
      const dx = end.x - this.x;
      const dy = end.y - this.y;
      const d = Math.hypot(dx, dy) || 1;
      const score = (dx * (this.x - fromX) + dy * (this.y - fromY)) / d;
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }
    if (!best) {
      this.drop(null);
      return;
    }
    const way = best.filter((p) => !p.dead).map((p) => this.way(p));
    const end = best[best.length - 1];
    way.push(this.exitFrom(end.x, end.y, end.x - this.x, end.y - this.y));
    this.walk(way, 4.4, 'gone');
  }

  /** Climb in from beyond the window along a radial (outermost point first) to the hub, and settle. */
  enter(radial: Particle[], hub: Particle): void {
    const end = radial[radial.length - 1];
    const from = this.exitFrom(end.x, end.y, end.x - hub.x, end.y - hub.y);
    this.x = this.lastX = from.x;
    this.y = this.lastY = from.y;
    this.angle = this.targetAngle = Math.atan2(hub.y - end.y, hub.x - end.x);
    this.alpha = 0.3;
    const way: Way[] = [];
    for (let i = radial.length - 1; i >= 0; i--) way.push(this.way(radial[i]));
    way.push(this.way(hub));
    for (const l of this.legs) {
      this.restWorld(l);
      l.fx = rw.x;
      l.fy = rw.y;
    }
    this.walk(way, 2.2, 'sit');
  }

  /** Let go of the web on a silk line, fall, bounce, dangle, then climb back. */
  drop(anchor: Particle | null): void {
    this.state = 'drop';
    this.anchor = anchor ? this.way(anchor) : { p: null, x: this.x + this.world.offX, y: this.y + this.world.offY - 2, page: true };
    this.seat = null;
    this.dropPhase = 'fall';
    this.line = 0;
    this.lineTarget = clamp(rand(70, 130), 30, Math.max(30, this.world.vh - this.y - 40));
    // It kicks off sideways a little, so it swings on the silk once it is caught.
    this.ox = this.x - rand(-0.7, 0.7);
    this.oy = this.y;
    this.gatherTarget = 1;
    this.spinV = rand(-0.03, 0.03);
    for (const l of this.legs) l.hold = null;
  }

  /** Idle life: lift and tap a leg, shift a little, flick the palps. */
  twitch(): void {
    if (this.state !== 'sit' || this.twitchLeg >= 0) return;
    const r = Math.random();
    if (r < 0.55) {
      this.twitchLeg = Math.random() < 0.7 ? (Math.random() < 0.5 ? 0 : 1) : Math.floor(Math.random() * 8);
      this.twitchT = 0;
    } else if (r < 0.8) {
      this.targetAngle = Math.PI / 2 + rand(-0.3, 0.3);
      this.twitchLeg = 2 + Math.floor(Math.random() * 4);
      this.twitchT = 0;
    }
    this.palpTarget = rand(-1, 1);
  }

  // --- simulation ------------------------------------------------------------

  step(): void {
    this.t += STEP;
    if (this.fading) this.alpha = Math.max(0, this.alpha - 0.04);
    else if (this.alpha < 1) this.alpha = Math.min(1, this.alpha + 0.035);
    if (this.fading && this.alpha <= 0) this.state = 'gone';

    switch (this.state) {
      case 'sit':
        this.stepSit();
        break;
      case 'walk':
        this.stepWalk();
        break;
      case 'drop':
        this.stepDrop();
        break;
    }
    this.vx = this.x - this.lastX;
    this.vy = this.y - this.lastY;
    this.lastX = this.x;
    this.lastY = this.y;
    const speed = Math.hypot(this.vx, this.vy);
    if (this.state === 'weave' && speed > 0.25) this.targetAngle = Math.atan2(this.vy, this.vx);
    let da = this.targetAngle - this.angle;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    this.angle += da * (this.state === 'sit' ? 0.06 : 0.22);
    this.gather += (this.gatherTarget - this.gather) * 0.12;
    this.palp += (this.palpTarget - this.palp) * 0.2;
    if (Math.random() < 0.01) this.palpTarget = rand(-0.4, 0.4);
    this.gait += speed * 0.32;
    this.stepLegs(speed);
  }

  private stepSit(): void {
    const s = this.seat;
    if (!s || s.dead || s.falling) {
      // The web gave way under it: it drops on a line spun from where it sat.
      this.drop(null);
      return;
    }
    // Ease its offset to the seat towards a small breathing bob.
    this.seatX *= 0.92;
    this.seatY += (Math.sin(this.t * 0.0019) * 0.35 - this.seatY) * 0.08;
    this.x = s.x + this.seatX;
    this.y = s.y + this.seatY;
  }

  private stepWalk(): void {
    // Face where it is going first: it slows to turn, then runs.
    const next = this.path[Math.min(this.pathI, this.path.length - 1)];
    if (next) {
      const dx = this.wx(next) - this.x;
      const dy = this.wy(next) - this.y;
      if (dx * dx + dy * dy > 1) this.targetAngle = Math.atan2(dy, dx);
    }
    let da = this.targetAngle - this.angle;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    const facing = clamp(Math.cos(da), 0.12, 1);
    this.speed = Math.min(this.maxSpeed * facing, this.speed + 0.35);
    let budget = this.speed;
    while (budget > 0 && this.pathI < this.path.length) {
      const w = this.path[this.pathI];
      const tx = this.wx(w);
      const ty = this.wy(w);
      const dx = tx - this.x;
      const dy = ty - this.y;
      const d = Math.hypot(dx, dy);
      if (d <= budget) {
        this.x = tx;
        this.y = ty;
        budget -= d;
        this.pathI++;
      } else {
        this.x += (dx / d) * budget;
        this.y += (dy / d) * budget;
        budget = 0;
      }
    }
    if (this.pathI >= this.path.length) {
      const last = this.path[this.path.length - 1];
      if (this.then === 'sit' && last?.p && !last.p.dead && !last.p.falling) this.sit(last.p);
      else this.state = 'gone';
    }
  }

  private stepDrop(): void {
    const a = this.anchor!;
    if (a.p && (a.p.dead || a.p.falling)) {
      // What it hung from is falling away: keep the line glued where it was.
      this.anchor = { p: null, x: a.p.x + this.world.offX, y: a.p.y + this.world.offY, page: true };
    }
    const ax = this.wx(this.anchor!);
    const ay = this.wy(this.anchor!);
    const vx = (this.x - this.ox) * 0.985;
    const vy = (this.y - this.oy) * 0.985;
    this.ox = this.x;
    this.oy = this.y;
    this.x += vx + this.world.windX * 0.25 + Math.sin(this.t * 0.0013) * 0.006;
    this.y += vy + (this.dropPhase === 'climb' ? 0.15 : 0.3);
    let dx = this.x - ax;
    let dy = this.y - ay;
    let d = Math.hypot(dx, dy) || 0.001;
    if (this.dropPhase === 'fall') {
      this.line = Math.max(this.line, Math.min(d, this.lineTarget));
      if (d >= this.lineTarget) {
        this.dropPhase = 'dangle';
        this.timer = rand(1800, 3200);
        this.gatherTarget = 0.3;
      }
    } else if (this.dropPhase === 'dangle') {
      this.timer -= STEP;
      const p = this.world;
      const near = p.ptrSeen && Math.hypot(p.ptrX - this.x, p.ptrY - this.y) < 110;
      if ((this.timer <= 0 && !near) || this.timer < -6000) {
        this.dropPhase = 'climb';
        this.gatherTarget = 0.65;
      }
    } else {
      this.line -= 1.35;
      if (this.line <= 3) {
        this.x = ax;
        this.y = ay;
        this.ox = ax;
        this.oy = ay;
        const p = this.anchor!.p;
        if (p && !p.dead && !p.falling) {
          this.sit(p);
        } else {
          const ptr = this.world;
          const fx = ptr.ptrSeen ? this.x - ptr.ptrX : 0;
          const fy = ptr.ptrSeen ? this.y - ptr.ptrY : -1;
          this.walk([this.exitFrom(this.x, this.y, fx, fy)], 4.2, 'gone');
        }
        return;
      }
    }
    // The line: stiff while falling, a little springy at the end of the drop.
    if (d > this.line) {
      const k = this.dropPhase === 'dangle' ? 0.45 : 1;
      const corr = ((d - this.line) / d) * k;
      this.x -= dx * corr;
      this.y -= dy * corr;
      dx = this.x - ax;
      dy = this.y - ay;
      d = Math.hypot(dx, dy) || 0.001;
    }
    // Head down, spinnerets up the line; a slow twist on the silk.
    this.targetAngle = Math.atan2(dy, dx);
    this.spinV += -this.spin * 0.0016 + this.world.windX * 0.0008;
    this.spinV *= 0.995;
    this.spin += this.spinV;
  }

  private walk(way: Way[], speed: number, then: 'sit' | 'gone'): void {
    this.state = 'walk';
    this.path = way;
    this.pathI = 0;
    this.speed = 0.5;
    this.maxSpeed = speed;
    this.then = then;
    this.seat = null;
    for (const l of this.legs) l.hold = null;
  }

  private way(p: Particle): Way {
    return { p, x: 0, y: 0, page: false };
  }

  private wx(w: Way): number {
    return w.p ? w.p.x : w.page ? w.x - this.world.offX : w.x;
  }

  private wy(w: Way): number {
    return w.p ? w.p.y : w.page ? w.y - this.world.offY : w.y;
  }

  /** A point just outside the window, heading roughly along (dx, dy). */
  private exitFrom(x: number, y: number, dx: number, dy: number): Way {
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    let uy = dy / d;
    if (Math.abs(ux) < 0.05 && Math.abs(uy) < 0.05) uy = -1;
    const { vw, vh } = this.world;
    const tx = ux > 0 ? (vw + 40 - x) / ux : ux < 0 ? (-40 - x) / ux : Infinity;
    const ty = uy > 0 ? (vh + 40 - y) / uy : uy < 0 ? (-40 - y) / uy : Infinity;
    const t = Math.min(tx, ty);
    if (!Number.isFinite(t)) return { p: null, x, y: -40, page: false };
    return { p: null, x: x + ux * t, y: y + uy * t, page: false };
  }

  // --- legs ------------------------------------------------------------------

  private grip(): void {
    for (const l of this.legs) {
      this.restWorld(l);
      const p = this.world.near(this.web, rw.x, rw.y, 18 * this.scale);
      l.hold = p;
      if (p) {
        l.hx = rw.x - p.x;
        l.hy = rw.y - p.y;
      }
      l.t = -1;
    }
  }

  private stepLegs(speed: number): void {
    const free = this.state === 'drop';
    const fast = speed > 2;
    const stride = Math.max(4 * this.scale, speed * 2.2);
    const stepMs = fast ? 58 : 110;
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    const stepping = [false, false];
    for (const l of this.legs) if (l.t >= 0) stepping[l.grp] = true;
    for (let n = 0; n < this.legs.length; n++) {
      const l = this.legs[n];
      this.restWorld(l);
      const restX = rw.x;
      const restY = rw.y;
      if (free) {
        // Nothing to stand on: feet trail the pose a little, and paddle.
        const paddle = Math.sin(this.t * 0.012 + n * 1.7) * (this.dropPhase === 'climb' ? 1.6 : 0.6) * this.scale;
        l.fx += (restX + paddle - l.fx) * 0.35;
        l.fy += (restY - l.fy) * 0.35;
        l.lift = 0.3;
        l.t = -1;
        continue;
      }
      if (n === this.twitchLeg) {
        this.twitchT += STEP / 340;
        const k = Math.sin(Math.PI * Math.min(1, this.twitchT));
        const hx = this.hipX(l);
        const hy = this.hipY(l);
        const base = l.hold ? l.hold.x + l.hx : l.fx;
        const baseY = l.hold ? l.hold.y + l.hy : l.fy;
        const ux = base - hx;
        const uy = baseY - hy;
        const d = Math.hypot(ux, uy) || 1;
        l.fx = base + (ux / d) * k * 3 * this.scale - (uy / d) * k * 1.2 * l.side;
        l.fy = baseY + (uy / d) * k * 3 * this.scale + (ux / d) * k * 1.2 * l.side;
        l.lift = k;
        if (this.twitchT >= 1) this.twitchLeg = -1;
        continue;
      }
      if (l.t >= 0) {
        l.t = Math.min(1, l.t + STEP / stepMs);
        const e = l.t * l.t * (3 - 2 * l.t);
        l.fx = l.sx + (l.tx - l.sx) * e;
        l.fy = l.sy + (l.ty - l.sy) * e;
        l.lift = Math.sin(Math.PI * l.t);
        if (l.t >= 1) {
          l.t = -1;
          l.lift = 0;
          if (this.state === 'sit') {
            const p = this.world.near(this.web, l.fx, l.fy, 14 * this.scale);
            l.hold = p;
            if (p) {
              l.hx = l.fx - p.x;
              l.hy = l.fy - p.y;
            }
          }
        }
        continue;
      }
      l.lift *= 0.7;
      if (l.hold) {
        if (l.hold.dead || l.hold.falling) l.hold = null;
        else {
          l.fx = l.hold.x + l.hx;
          l.fy = l.hold.y + l.hy;
        }
      }
      if (this.state === 'sit') {
        // Sitting: feet ride the threads they hold; loose ones settle back to the pose.
        if (!l.hold) {
          l.fx += (restX - l.fx) * 0.2;
          l.fy += (restY - l.fy) * 0.2;
        } else if (Math.hypot(l.fx - restX, l.fy - restY) > stride * 2.5) {
          l.hold = null;
        }
        continue;
      }
      const off = Math.hypot(l.fx - restX, l.fy - restY);
      const reach = Math.hypot(l.fx - this.hipX(l), l.fy - this.hipY(l));
      // A foot that has ended up on the wrong side of the body (after a sharp
      // turn) is moved at once, whatever the gait says.
      const sideOf = (-(l.fx - this.x) * s + (l.fy - this.y) * c) * l.side;
      const crossed = sideOf < 1.5 * this.scale;
      if ((crossed || ((off > stride || reach > (l.femur + l.tibia) * 0.98) && !stepping[1 - l.grp])) && l.t < 0) {
        stepping[l.grp] = true;
        l.t = 0;
        l.sx = l.fx;
        l.sy = l.fy;
        const lead = stepMs / STEP;
        l.tx = restX + this.vx * lead;
        l.ty = restY + this.vy * lead;
        l.hold = null;
      }
    }
  }

  private squash(): number {
    return this.state === 'drop' ? 0.4 + 0.6 * Math.abs(Math.cos(this.spin)) : 1;
  }

  private restWorld(l: LegState): void {
    const g = this.gather;
    const lx = REST[l.i][0] + (TUCK[l.i][0] - REST[l.i][0]) * g;
    const ly = (REST[l.i][1] + (TUCK[l.i][1] - REST[l.i][1]) * g) * l.side;
    this.local(lx, ly);
  }

  private hipX(l: LegState): number {
    this.local(HIP[l.i][0], HIP[l.i][1] * l.side);
    return rw.x;
  }

  private hipY(l: LegState): number {
    this.local(HIP[l.i][0], HIP[l.i][1] * l.side);
    return rw.y;
  }

  /** Body-local units to window coordinates, into `rw`. */
  private local(lx: number, ly: number): void {
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    const sx = lx * this.scale;
    const sy = ly * this.scale * this.squash();
    rw.x = this.x + c * sx - s * sy;
    rw.y = this.y + s * sx + c * sy;
  }

  // --- drawing ---------------------------------------------------------------

  /**
   * `palette` is the page under its web: 0 light, 1 mid, 2 dark. On darker
   * pages a near-black spider would vanish, so it gets a pale rim light.
   */
  draw(ctx: CanvasRenderingContext2D, palette: number): void {
    if (this.alpha <= 0.01 || this.state === 'gone') return;
    const light = palette === 0;
    ctx.save();
    ctx.globalAlpha = this.alpha;
    const sc = this.scale;
    const sq = this.squash();

    if (this.state === 'drop' && this.anchor) {
      this.local(SPINNERET, 0);
      const ax = this.wx(this.anchor);
      const ay = this.wy(this.anchor);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(rw.x, rw.y);
      ctx.strokeStyle = light ? 'rgba(10,12,22,0.16)' : 'rgba(16,18,26,0.3)';
      ctx.lineWidth = 1.3;
      ctx.stroke();
      ctx.strokeStyle = light ? 'rgba(118,122,136,0.8)' : 'rgba(238,241,250,0.75)';
      ctx.lineWidth = light ? 0.9 : 0.6;
      ctx.stroke();
    }

    // A soft shadow on the page behind, so it sits above the wall.
    if (light) {
      ctx.save();
      ctx.translate(this.x + 2.5 * sc, this.y + 4 * sc);
      ctx.rotate(this.angle);
      ctx.scale(sc, sc * sq);
      ctx.globalAlpha = this.alpha * 0.5;
      ctx.drawImage(getShadow(), -16, -12, 30, 24);
      ctx.restore();
    }

    // Legs: hip, knee, ankle, foot for each, worked out once into `joints`.
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    for (let n = 0; n < this.legs.length; n++) {
      const l = this.legs[n];
      this.local(HIP[l.i][0], HIP[l.i][1] * l.side);
      const hx = rw.x;
      const hy = rw.y;
      let dx = l.fx - hx;
      let dy = l.fy - hy;
      const total = l.femur + l.tibia;
      let d = Math.hypot(dx, dy) || 0.001;
      const dc = clamp(d, total * 0.25, total * 0.995);
      dx = (dx / d) * dc;
      dy = (dy / d) * dc;
      d = dc;
      const fx = hx + dx;
      const fy = hy + dy;
      const a = (l.femur * l.femur - l.tibia * l.tibia + d * d) / (2 * d);
      let h = Math.sqrt(Math.max(0, l.femur * l.femur - a * a));
      h *= 1 + l.lift * 0.7;
      let nx = -dy / d;
      let ny = dx / d;
      // Knees bend away from the body.
      if (nx * -s * l.side + ny * c * l.side < 0) {
        nx = -nx;
        ny = -ny;
      }
      const kx = hx + (dx / d) * a + nx * h * sq;
      const ky = hy + (dy / d) * a + ny * h * sq;
      const j = n * 8;
      joints[j] = hx;
      joints[j + 1] = hy;
      joints[j + 2] = kx;
      joints[j + 3] = ky;
      joints[j + 4] = kx + (fx - kx) * 0.74 + nx * 0.7 * sc;
      joints[j + 5] = ky + (fy - ky) * 0.74 + ny * 0.7 * sc;
      joints[j + 6] = fx;
      joints[j + 7] = fy;
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Rim light first (strong on dark pages, a whisper on white), then the legs.
    const rim = light ? 'rgba(230,225,235,0.22)' : 'rgba(214,208,222,0.5)';
    const extra = light ? 0 : 0.5;
    this.strokeLegs(ctx, 0, rim, (2.1 + extra) * sc);
    this.strokeLegs(ctx, 1, rim, (1.7 + extra) * sc);
    this.strokeLegs(ctx, 2, rim, (1.3 + extra) * sc);
    this.strokeLegs(ctx, 0, '#0c0a0d', 1.35 * sc);
    this.strokeLegs(ctx, 1, '#120f12', 1.0 * sc);
    this.strokeLegs(ctx, 2, '#1a1519', 0.65 * sc);
    ctx.fillStyle = light ? '#3a2e30' : '#5a4a4e';
    for (let n = 0; n < this.legs.length; n++) {
      ctx.beginPath();
      ctx.arc(joints[n * 8 + 2], joints[n * 8 + 3], 0.75 * sc, 0, Math.PI * 2);
      ctx.fill();
    }

    // Body, breathing, and the palps that never quite keep still.
    const breathe = 1 + Math.sin(this.t * 0.0019) * 0.025;
    const bob = this.state === 'walk' ? Math.sin(this.gait) * 0.25 : 0;
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);
    ctx.scale(sc, sc * sq);
    ctx.translate(bob, 0);
    ctx.save();
    ctx.translate(-0.6, 0);
    ctx.scale(breathe, breathe);
    ctx.translate(0.6, 0);
    ctx.drawImage(getBody(!light), -11.5, -5.5, 21, 11);
    ctx.restore();
    ctx.strokeStyle = light ? '#140f12' : '#3a3034';
    ctx.lineWidth = 0.75;
    for (let side = -1; side <= 1; side += 2) {
      const p = this.palp * 0.35 * side;
      ctx.beginPath();
      ctx.moveTo(6.0, 1.0 * side);
      const mx = 7.4 + Math.cos(p) * 0.4;
      const my = (1.9 + p) * side;
      ctx.lineTo(mx, my);
      ctx.lineTo(mx + 1.1, my - 0.4 * side + p * 0.5);
      ctx.stroke();
    }
    // Two eyes that catch the light, a dull red.
    ctx.fillStyle = EYES[Math.round((0.5 + 0.5 * Math.sin(this.t * 0.0023)) * (EYES.length - 1))];
    for (let side = -1; side <= 1; side += 2) {
      ctx.beginPath();
      ctx.arc(5.85, 0.55 * side, 0.42, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Stroke one segment (0 femur, 1 tibia, 2 tarsus) of all eight legs in one path. */
  private strokeLegs(ctx: CanvasRenderingContext2D, seg: number, style: string, width: number): void {
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let n = 0; n < this.legs.length; n++) {
      const j = n * 8 + seg * 2;
      ctx.moveTo(joints[j], joints[j + 1]);
      ctx.lineTo(joints[j + 2], joints[j + 3]);
    }
    ctx.stroke();
  }
}

/** Leg joints for the spider being drawn: 8 legs x (hip, knee, ankle, foot). */
const joints = new Float64Array(64);
/** The eyes' slow glow, as ready-made colours. */
const EYES = Array.from({ length: 9 }, (_, i) => `rgba(255, 46, 36, ${(0.2 + (i / 8) * 0.7).toFixed(3)})`);

/** Scratch point for `local`, so the per-frame maths allocates nothing. */
const rw = { x: 0, y: 0 };

/** Abdomen, cephalothorax, eyes and mouthparts, pre-rendered in detail at 8px per unit. */
function getBody(dark: boolean): HTMLCanvasElement {
  const cached = bodySprites[dark ? 1 : 0];
  if (cached) return cached;
  const k = 8;
  const c = document.createElement('canvas');
  c.width = 21 * k;
  c.height = 11 * k;
  const g = c.getContext('2d')!;
  g.scale(k, k);
  g.translate(11.5, 5.5);
  const ellipse = (x: number, y: number, rx: number, ry: number) => {
    g.beginPath();
    g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  };

  // Chelicerae, under the head.
  g.fillStyle = '#100c0e';
  for (const side of [-1, 1]) {
    ellipse(6.3, 0.75 * side, 1.0, 0.7);
    g.fill();
  }

  // Abdomen: glossy, near black with a dark wine undertone, and fine hairs.
  g.strokeStyle = 'rgba(40,32,36,0.8)';
  g.lineWidth = 0.12;
  for (let i = 0; i < 70; i++) {
    const a = (i / 70) * Math.PI * 2;
    const x = -4.7 + Math.cos(a) * 5.15;
    const y = Math.sin(a) * 4.0;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * 0.55, y + Math.sin(a) * 0.55);
    g.stroke();
  }
  let grad = g.createRadialGradient(-3.4, -1.3, 0.3, -4.7, 0, 5.6);
  grad.addColorStop(0, '#45363b');
  grad.addColorStop(0.4, '#1c1417');
  grad.addColorStop(1, '#050304');
  g.fillStyle = grad;
  ellipse(-4.7, 0, 5.2, 4.0);
  g.fill();
  // The folium: a pale leaf pattern down the back, very faint.
  g.strokeStyle = 'rgba(205,190,176,0.2)';
  g.lineWidth = 0.32;
  for (let j = 0; j < 4; j++) {
    const x = -1.9 - j * 1.85;
    const w = 2.3 - j * 0.35;
    g.beginPath();
    g.moveTo(x - 0.9, -w);
    g.quadraticCurveTo(x + 0.5, 0, x - 0.9, w);
    g.stroke();
  }
  g.fillStyle = 'rgba(215,200,186,0.28)';
  for (let j = 0; j < 4; j++) {
    for (const side of [-1, 1]) {
      g.beginPath();
      g.arc(-2.3 - j * 1.8, side * (1.55 - j * 0.15), 0.28, 0, Math.PI * 2);
      g.fill();
    }
  }
  // Wet-looking highlight and a fine rim.
  grad = g.createRadialGradient(-3.2, -1.9, 0, -3.2, -1.9, 2.2);
  grad.addColorStop(0, 'rgba(255,255,255,0.42)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  ellipse(-3.4, -1.8, 2.4, 1.3);
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.2)';
  g.lineWidth = 0.18;
  ellipse(-4.7, 0, 5.2, 4.0);
  g.stroke();

  // Pedicel, the narrow waist.
  g.fillStyle = '#0b0809';
  ellipse(-0.1, 0, 0.9, 0.75);
  g.fill();

  // Cephalothorax with its radial grooves.
  grad = g.createRadialGradient(3.6, -0.6, 0.2, 3.2, 0, 3.4);
  grad.addColorStop(0, '#3a2d31');
  grad.addColorStop(0.55, '#171114');
  grad.addColorStop(1, '#050304');
  g.fillStyle = grad;
  ellipse(3.2, 0, 3.2, 2.5);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.lineWidth = 0.14;
  for (let i = 0; i < 6; i++) {
    const a = Math.PI * 0.25 + (i / 5) * Math.PI * 1.5;
    g.beginPath();
    g.moveTo(2.6, 0);
    g.lineTo(2.6 + Math.cos(a + Math.PI) * 2.1, Math.sin(a + Math.PI) * 1.7);
    g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,0.2)';
  g.lineWidth = 0.18;
  ellipse(3.2, 0, 3.2, 2.5);
  g.stroke();
  grad = g.createRadialGradient(3.9, -1.0, 0, 3.9, -1.0, 1.2);
  grad.addColorStop(0, 'rgba(255,255,255,0.32)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  ellipse(3.9, -1.0, 1.3, 0.7);
  g.fill();

  // Eight glossy eyes in two rows.
  const eyes = [
    [5.85, 0.55, 0.42],
    [5.5, 1.25, 0.3],
    [4.9, 0.45, 0.3],
    [4.75, 1.3, 0.26],
  ];
  for (const [x, y, r] of eyes) {
    for (const side of [-1, 1]) {
      g.fillStyle = '#020102';
      g.beginPath();
      g.arc(x, y * side, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.75)';
      g.beginPath();
      g.arc(x - r * 0.3, y * side - r * 0.35, r * 0.32, 0, Math.PI * 2);
      g.fill();
    }
  }
  if (dark) {
    // On dark pages: a pale rim of light round abdomen and head so it reads.
    g.strokeStyle = 'rgba(222,214,228,0.55)';
    g.lineWidth = 0.3;
    ellipse(-4.7, 0, 5.25, 4.05);
    g.stroke();
    ellipse(3.2, 0, 3.25, 2.55);
    g.stroke();
    g.globalCompositeOperation = 'lighter';
    const tint = g.createRadialGradient(-3.4, -1.3, 0.3, -4.7, 0, 5.6);
    tint.addColorStop(0, 'rgba(70,58,62,0.55)');
    tint.addColorStop(1, 'rgba(30,24,26,0.2)');
    g.fillStyle = tint;
    ellipse(-4.7, 0, 5.2, 4.0);
    g.fill();
    g.globalCompositeOperation = 'source-over';
  }
  bodySprites[dark ? 1 : 0] = c;
  return c;
}

function getShadow(): HTMLCanvasElement {
  if (shadowSprite) return shadowSprite;
  const c = document.createElement('canvas');
  c.width = 60;
  c.height = 48;
  const g = c.getContext('2d')!;
  g.translate(30, 24);
  g.scale(1.25, 0.8);
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, 24);
  grad.addColorStop(0, 'rgba(0,0,0,0.35)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(0, 0, 24, 0, Math.PI * 2);
  g.fill();
  shadowSprite = c;
  return c;
}

export function dropSpiderSprites(): void {
  bodySprites[0] = bodySprites[1] = null;
  shadowSprite = null;
}
