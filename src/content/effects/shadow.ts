// Something behind the text: once, while you read, a tall gaunt figure walks past
// behind the page. It slows near the middle, turns its head toward you, then
// walks on and is gone.
//
// Nothing can really be drawn behind a page, so it is faked. The figure is drawn
// small and soft on a little canvas, scaled up and blended with the page:
//  - on light pages with `multiply`, which darkens the background but leaves dark
//    text as dark as it was, so the text seems to sit in front of the shadow;
//  - on dark pages with `lighten`, as a faint cold rim of light around a figure
//    standing in front of it. Light text is brighter than the rim, so it stays
//    exactly as it was and again reads as in front.
// The blur changes with depth: as the figure leans in toward the glass it gets
// sharper and darker, like a shadow through frosted glass.

import type { Effect, EffectContext } from './types';
import { createOverlay, seeded, type Overlay } from './overlay';

interface Pt {
  x: number;
  y: number;
}

type Phase = 'idle' | 'waiting' | 'walking';

/** Longest wait for the user to scroll or move before it walks anyway (ms). */
const MAX_WAIT = 1400;
/** Seconds spent slowing to a stop, and getting going again. */
const DECEL = 1.0;
const ACCEL = 0.9;
/** Fade in and out, seconds. */
const FADE_IN = 0.9;
const FADE_OUT = 1.0;
const STOP_FADE = 0.9;
/** The figure box, in units of the figure's height, and where its feet sit in it. */
const BOX_W = 1.0;
const BOX_H = 1.3;
const ORIGIN_X = 0.5;
const ORIGIN_Y = 1.15;
/** Canvas pixels per figure height. The blur hides the low resolution. */
const RES = 240;

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Integral of smoothstep from 0 to u, for distance travelled while easing. */
const smoothInt = (u: number) => u * u * u - (u * u * u * u) / 2;

const BLUR_STEPS = 0.25;
const blurCache: string[] = [];
function blurFilter(px: number): string {
  const i = Math.max(0, Math.round(px / BLUR_STEPS));
  return (blurCache[i] ??= `blur(${(i * BLUR_STEPS).toFixed(2)}px)`);
}

/** Parse a computed CSS colour into [r, g, b, a] (0..255, alpha 0..1). */
function parseColor(s: string): [number, number, number, number] | null {
  const m = s.match(/-?[\d.]+(e-?\d+)?%?/g);
  if (!m || m.length < 3) return null;
  const n = m.map((v) => parseFloat(v));
  const scale = s.startsWith('color(') ? 255 : 1;
  return [n[0] * scale, n[1] * scale, n[2] * scale, n.length > 3 ? n[3] : 1];
}

function luminance(r: number, g: number, b: number): number {
  const ch = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** Is what sits behind the reading area light? Sampled once, where the figure will pass. */
function pageIsLight(): boolean {
  let total = 0;
  let count = 0;
  const w = innerWidth;
  const h = innerHeight;
  for (const fx of [0.2, 0.5, 0.8]) {
    for (const fy of [0.3, 0.6, 0.85]) {
      let el: Element | null = document.elementFromPoint(w * fx, h * fy);
      while (el) {
        const c = parseColor(getComputedStyle(el).backgroundColor);
        if (c && c[3] > 0.5) {
          total += luminance(c[0], c[1], c[2]);
          count++;
          break;
        }
        el = el.parentElement;
      }
    }
  }
  if (count) return total / count > 0.3;
  // Nothing painted a background: the browser's canvas shows, which is dark
  // only when the page opted into a dark colour scheme.
  const scheme = getComputedStyle(document.documentElement).colorScheme || '';
  return !(/dark/.test(scheme) && matchMedia('(prefers-color-scheme: dark)').matches);
}

export class Shadow implements Effect {
  readonly name = 'shadow' as const;

  private phase: Phase = 'idle';
  private overlay: Overlay | null = null;
  private box: HTMLDivElement | null = null;
  private vctx: CanvasRenderingContext2D | null = null;
  private sharp: HTMLCanvasElement | null = null;
  private sctx: CanvasRenderingContext2D | null = null;
  private canFilter = true;
  private legFade: CanvasGradient | null = null;
  // Blend modes push the page through an extra compositing pass. On a GPU that
  // is nothing; on a software compositor it can halve the frame rate, so frame
  // times are watched and the blend is dropped if it gets slow. Over plain
  // backgrounds the dark shadow (or the cold haze on dark pages) looks the same
  // either way; only text and saturated colours lose a little.
  private perfFrames = 0;
  private perfTime = 0;
  private perfDone = false;
  private blendK = 1;

  private raf = 0;
  private waitTimer: number | undefined;
  private beginTimer: number | undefined;
  private killTimer: number | undefined;
  private listening = false;
  private startedAt = 0;

  private reduced = false;
  private light = true;
  private rand: () => number = Math.random;
  private intensity = 1;

  // Clock: seconds of visible walking, paused while the tab is hidden.
  private t = 0;
  private lastNow = 0;
  private stopAt = -1;

  // Layout, recomputed on resize.
  private vw = 0;
  private vh = 0;
  private figH = 0;
  private feetY = 0;

  // The path, in px and seconds.
  private dir = 1;
  private x0 = 0;
  private xP = 0;
  private x1 = 0;
  private speed = 0;
  private run1 = 0;
  private run2 = 0;
  private tDecel = 0;
  private tStop = 0;
  private tResume = 0;
  private tGo = 0;
  private tEnd = 0;
  private stride = 1;
  private phase0 = 0;
  private holdX = 0;

  // Per-tab variety.
  private armK = 1;
  private legK = 1;
  private hunch = 0;
  private cockSide = 1;
  private cockAmt = 0;

  // Pointer and scroll, fed by passive listeners.
  private pointerX = -1;
  private pointerY = -1;
  private lookX = 0;
  private lookY = 0;
  private scroll0 = 0;
  private scrollNow = 0;
  private parallax = 0;

  // The pose, reused every frame.
  private readonly pelvis: Pt = { x: 0, y: 0 };
  private readonly neck: Pt = { x: 0, y: 0 };
  private readonly headBase: Pt = { x: 0, y: 0 };
  private readonly head: Pt = { x: 0, y: 0 };
  private readonly sh = [this.pt(), this.pt()];
  private readonly el = [this.pt(), this.pt()];
  private readonly wr = [this.pt(), this.pt()];
  private readonly tip = [this.pt(), this.pt()];
  private readonly hip = [this.pt(), this.pt()];
  private readonly kn = [this.pt(), this.pt()];
  private readonly an = [this.pt(), this.pt()];
  private readonly toe = [this.pt(), this.pt()];
  private readonly torso = Array.from({ length: 10 }, () => this.pt());

  get active(): boolean {
    return this.phase !== 'idle';
  }

  start(ctx: EffectContext): void {
    // A one-shot: while it is already waiting or walking, a second call changes nothing.
    if (this.phase !== 'idle') return;
    this.phase = 'waiting';
    this.reduced = ctx.reduced;
    this.rand = seeded((ctx.seed ^ 0x5badc0de) >>> 0);
    this.intensity = clamp(0.85 + 0.05 * ctx.stage, 0.85, 1.05);
    this.light = pageIsLight();
    this.startedAt = performance.now();
    this.listen(true);
    this.armWait();
  }

  stop(): void {
    if (this.phase === 'idle') return;
    if (this.phase === 'waiting' || document.hidden || !this.overlay) {
      this.destroy();
      return;
    }
    if (this.stopAt < 0) this.stopAt = this.t;
    clearTimeout(this.killTimer);
    this.killTimer = window.setTimeout(() => this.destroy(), 1500);
    this.wake();
  }

  destroy(): void {
    this.phase = 'idle';
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    clearTimeout(this.waitTimer);
    clearTimeout(this.beginTimer);
    clearTimeout(this.killTimer);
    this.waitTimer = this.beginTimer = this.killTimer = undefined;
    this.listen(false);
    this.overlay?.remove();
    this.overlay = null;
    this.box = null;
    this.sharp = null;
    this.legFade = null;
    this.vctx = this.sctx = null;
    this.stopAt = -1;
  }

  // ---------------------------------------------------------------------------
  // Waiting: it is best glimpsed while you read, so it waits for a scroll or a
  // move, but not for long.

  private armWait(): void {
    clearTimeout(this.waitTimer);
    if (document.hidden) return; // visibilitychange re-arms it
    this.waitTimer = window.setTimeout(() => this.begin(), MAX_WAIT);
  }

  private onActivity = (): void => {
    if (this.phase !== 'waiting' || this.beginTimer !== undefined || document.hidden) return;
    if (performance.now() - this.startedAt < 150) return;
    this.beginTimer = window.setTimeout(() => this.begin(), 260);
  };

  private onPointer = (e: PointerEvent): void => {
    this.pointerX = e.clientX;
    this.pointerY = e.clientY;
    this.onActivity();
  };

  private onScroll = (): void => {
    this.scrollNow = scrollY;
    this.onActivity();
    this.wake();
  };

  private onVisibility = (): void => {
    if (document.hidden) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      clearTimeout(this.waitTimer);
      return;
    }
    if (this.phase === 'waiting') this.armWait();
    else this.wake();
  };

  private onResize = (): void => {
    if (this.phase !== 'walking') return;
    const r = innerWidth / (this.vw || innerWidth);
    this.layout();
    // Keep the timing, stretch the path to the new width.
    this.x0 *= r;
    this.xP *= r;
    this.x1 *= r;
    this.speed *= r;
    this.run1 *= r;
    this.run2 *= r;
    this.holdX *= r;
    this.wake();
  };

  private listen(on: boolean): void {
    if (on === this.listening) return;
    this.listening = on;
    const opts: AddEventListenerOptions = { passive: true };
    const m = on ? 'addEventListener' : 'removeEventListener';
    window[m]('pointermove', this.onPointer as EventListener, opts);
    window[m]('scroll', this.onScroll, opts);
    window[m]('wheel', this.onActivity, opts);
    window[m]('touchmove', this.onActivity, opts);
    window[m]('keydown', this.onActivity, opts);
    window[m]('resize', this.onResize, opts);
    document[m]('visibilitychange', this.onVisibility);
  }

  // ---------------------------------------------------------------------------
  // Walking.

  private begin(): void {
    if (this.phase !== 'waiting') return;
    clearTimeout(this.waitTimer);
    clearTimeout(this.beginTimer);
    this.waitTimer = this.beginTimer = undefined;
    this.phase = 'walking';

    const r = this.rand;
    this.armK = 0.97 + r() * 0.1;
    this.legK = 0.98 + r() * 0.05;
    this.hunch = 0.15 + r() * 0.12;
    this.cockSide = r() < 0.5 ? -1 : 1;
    this.cockAmt = 0.1 + r() * 0.08;
    this.phase0 = r() * TAU;
    this.dir = r() < 0.5 ? 1 : -1;
    const stopAt = 0.42 + r() * 0.16;
    const pause = 1.0 + r() * 0.5;

    this.layout();
    const H = this.figH;
    const margin = ORIGIN_X * H + 0.12 * H;
    if (this.dir > 0) {
      this.x0 = -margin;
      this.xP = this.vw * stopAt;
      this.x1 = this.vw + margin;
    } else {
      this.x0 = this.vw + margin;
      this.xP = this.vw * (1 - stopAt);
      this.x1 = -margin;
    }
    this.holdX = this.vw * (this.dir > 0 ? 0.3 + r() * 0.12 : 0.58 + r() * 0.12);

    // A slow, deliberate walk: about two seconds to reach the middle.
    const d1 = Math.abs(this.xP - this.x0);
    const d2 = Math.abs(this.x1 - this.xP);
    this.speed = clamp(d1 / (2.15 - DECEL / 2), 0.32 * H, 0.72 * H);
    this.run1 = d1 - (this.speed * DECEL) / 2;
    this.run2 = d2 - (this.speed * ACCEL) / 2;
    this.tDecel = this.run1 / this.speed;
    this.tStop = this.tDecel + DECEL;
    this.tResume = this.tStop + pause;
    this.tGo = this.tResume + ACCEL;
    this.tEnd = this.tGo + this.run2 / this.speed;
    // One full gait cycle (two steps) is a little under the figure's height.
    this.stride = 0.86 * H;
    if (this.reduced) this.tEnd = 5.6;

    this.scroll0 = this.scrollNow = scrollY;

    // The overlay: one little canvas, scaled up. The blend mode has to sit on
    // the overlay layer itself to mix with the page rather than with our own
    // layer. The layer shrinks to the figure's box and is moved around instead
    // of covering the viewport, so the blended area stays small.
    const blend = this.light ? 'multiply' : 'lighten';
    this.overlay = createOverlay(
      this.name,
      `.layer { inset: auto; left: 0; top: 0; width: 0; height: 0; mix-blend-mode: ${blend};
         transform-origin: 0 0; will-change: transform, opacity; opacity: 0; }
       canvas { position: absolute; inset: 0; width: 100%; height: 100%; }`,
    );
    this.box = this.overlay.layer;
    const view = document.createElement('canvas');
    view.width = Math.round(BOX_W * RES);
    view.height = Math.round(BOX_H * RES);
    this.box.appendChild(view);
    this.vctx = view.getContext('2d');
    const sharp = document.createElement('canvas');
    sharp.width = view.width;
    sharp.height = view.height;
    this.sharp = sharp;
    this.sctx = sharp.getContext('2d');
    if (this.sctx) {
      // Solid down to the knees, thinning toward the feet.
      const g = this.sctx.createLinearGradient(0, (ORIGIN_Y - 0.3) * RES, 0, ORIGIN_Y * RES);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0.4)');
      this.legFade = g;
    }
    if (!this.vctx || !this.sctx) {
      this.destroy();
      return;
    }
    this.canFilter = typeof this.vctx.filter === 'string';
    if (!this.canFilter) view.style.filter = 'blur(6px)';
    this.sizeView();

    this.t = 0;
    this.perfFrames = 0;
    this.perfTime = 0;
    this.perfDone = false;
    this.blendK = 1;
    this.lastNow = performance.now();
    this.wake();
  }

  private layout(): void {
    this.vw = innerWidth;
    this.vh = innerHeight;
    // Tall: the head clears the top of the page, the feet sit at the bottom edge.
    this.figH = clamp(this.vh * 0.9, 380, 1250);
    this.feetY = this.vh * 1.02;
    this.sizeView();
  }

  private sizeView(): void {
    if (!this.box) return;
    this.box.style.width = `${(BOX_W * this.figH).toFixed(1)}px`;
    this.box.style.height = `${(BOX_H * this.figH).toFixed(1)}px`;
  }

  private wake(): void {
    if (this.raf || this.phase !== 'walking' || document.hidden) return;
    this.lastNow = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    this.raf = 0;
    if (this.phase !== 'walking') return;
    const dt = clamp((now - this.lastNow) / 1000, 0, 0.1);
    this.lastNow = now;
    this.t += dt;
    if (!this.perfDone) this.checkPerf(dt);

    const fadeOut = this.stopAt >= 0 ? 1 - smooth(0, STOP_FADE, this.t - this.stopAt) : 1;
    if (this.t >= this.tEnd || fadeOut <= 0) {
      this.destroy();
      return;
    }
    this.render(dt, fadeOut);
    this.raf = requestAnimationFrame(this.frame);
  };

  private checkPerf(dt: number): void {
    if (this.t < 0.2) return;
    this.perfFrames++;
    this.perfTime += dt;
    if (this.perfTime < 0.5) return;
    // Half a second at under ~40 fps: blend no more, for the rest of the walk.
    if (this.perfTime / this.perfFrames > 1 / 40) {
      this.perfDone = true;
      if (this.box) this.box.style.mixBlendMode = 'normal';
      // Without `lighten` the haze would veil text and bright colours: thin it.
      if (!this.light) this.blendK = 0.65;
    }
    this.perfFrames = 0;
    this.perfTime = 0;
  }

  /** Distance along the path at time t, and how hard it is walking (0..1). */
  private travelled(t: number): [number, number] {
    const v = this.speed;
    if (t < this.tDecel) return [v * t, 1];
    if (t < this.tStop) {
      const u = (t - this.tDecel) / DECEL;
      return [this.run1 + v * DECEL * (u - smoothInt(u)), 1 - smooth(0, 1, u)];
    }
    const d1 = this.run1 + (v * DECEL) / 2;
    if (t < this.tResume) return [d1, 0];
    if (t < this.tGo) {
      const u = (t - this.tResume) / ACCEL;
      return [d1 + v * ACCEL * smoothInt(u), smooth(0, 1, u)];
    }
    return [d1 + (v * ACCEL) / 2 + v * (t - this.tGo), 1];
  }

  private render(dt: number, fadeOut: number): void {
    const t = this.t;
    const H = this.figH;
    let x: number;
    let walk: number;
    let phi: number;
    let faceTorso: number;
    let faceHead: number;
    let cock: number;
    let z: number;
    let env: number;

    if (this.reduced) {
      // No walking: it gathers in place, looks at you, and thins away.
      x = this.holdX;
      walk = 0;
      phi = 0;
      faceTorso = 0.3;
      faceHead = 0.55 + 0.35 * smooth(1.2, 3.2, t);
      cock = smooth(2.0, 4.0, t);
      z = 0.3 + 0.4 * smooth(0, 4, t);
      env = smooth(0, 1.8, t) * (1 - smooth(this.tEnd - 1.8, this.tEnd, t));
    } else {
      const [dist, w] = this.travelled(t);
      x = this.x0 + this.dir * dist;
      walk = w;
      phi = this.phase0 + (TAU * dist) / this.stride;
      // It notices you as it slows; the head turns first and the shoulders follow.
      const turnIn = smooth(this.tStop - 0.45, this.tStop + 0.35, t);
      const turnBack = smooth(this.tResume - 0.4, this.tResume + 0.35, t);
      faceHead = 0.92 * turnIn * (1 - turnBack);
      faceTorso = 0.62 * smooth(this.tStop - 0.15, this.tStop + 0.7, t) * (1 - smooth(this.tResume - 0.55, this.tResume + 0.1, t));
      cock = smooth(this.tStop + 0.35, this.tStop + 1.0, t) * (1 - smooth(this.tResume - 0.45, this.tResume, t));
      // Depth: it drifts nearer the glass, leans in while it looks, then recedes.
      z =
        0.3 +
        0.35 * smooth(0, this.tStop, t) +
        0.3 * smooth(this.tStop, this.tStop + 0.8, t) * (1 - smooth(this.tResume - 0.4, this.tResume + 0.3, t)) -
        0.5 * smooth(this.tResume, this.tEnd, t);
      env = smooth(0, FADE_IN, t) * (1 - smooth(this.tEnd - FADE_OUT, this.tEnd, t));
    }
    z = clamp(z, 0, 1);

    // Where it looks: toward the pointer if we know it, otherwise straight out.
    const headScreenY = this.feetY - H * 0.9;
    const tx = this.pointerX >= 0 ? clamp((this.pointerX - x) / (0.35 * this.vw), -1, 1) : 0;
    const ty = this.pointerY >= 0 ? clamp((this.pointerY - headScreenY) / (0.6 * this.vh), -1, 1) : 0.2;
    const k = 1 - Math.exp(-dt * 3);
    this.lookX += (tx - this.lookX) * k;
    this.lookY += (ty - this.lookY) * k;

    // A sliver of parallax when the page scrolls: it is further back than the text.
    const target = clamp(-(this.scrollNow - this.scroll0) * 0.06, -0.05 * this.vh, 0.05 * this.vh);
    this.parallax += (target - this.parallax) * (1 - Math.exp(-dt * 4));

    const sway = (1 - walk) * 0.012 * Math.sin(t * TAU * 0.28) + walk * 0.018 * Math.sin(phi);
    this.pose(walk, phi, faceTorso, faceHead, sway, cock);
    this.paint(z);

    const scale = 0.92 + 0.1 * z;
    const left = x - ORIGIN_X * H * scale;
    const top = this.feetY + (z - 0.5) * 0.025 * this.vh + this.parallax - ORIGIN_Y * H * scale;
    const box = this.box!;
    box.style.transform = `translate3d(${left.toFixed(1)}px,${top.toFixed(1)}px,0) scale(${scale.toFixed(4)})`;
    const base = this.light ? 0.18 : 0.9;
    box.style.opacity = (base * this.blendK * this.intensity * env * fadeOut * lerp(0.72, 1, z)).toFixed(3);
  }

  // ---------------------------------------------------------------------------
  // The figure, in units of its height: feet on y = 0, y grows downward.

  private pose(walk: number, phi: number, ft: number, fh: number, sway: number, cock: number): void {
    const d = this.dir;
    const thigh = 0.252 * this.legK;
    const shin = 0.248 * this.legK;

    // Legs hang from a pelvis at the origin; the whole body is then dropped
    // until the lower foot touches the ground, which gives the gait its bob.
    let lowest = -1;
    for (let i = 0; i < 2; i++) {
      const p = phi + i * Math.PI;
      // Thigh swings a little more forward than back. The knee folds while the
      // leg swings through and is straight again by the time the heel lands.
      const aT = d * walk * (0.34 * Math.sin(p) + 0.04);
      let q = (p - 0.4) % TAU;
      if (q > Math.PI) q -= TAU;
      else if (q < -Math.PI) q += TAU;
      const c = Math.max(0, Math.cos(q * 1.3));
      const bend = walk * (0.72 * c * c + 0.05);
      const aS = aT - d * bend;
      const hp = this.hip[i];
      hp.x = (i ? 1 : -1) * lerp(0.014, 0.04, ft);
      hp.y = 0;
      const kn = this.kn[i];
      kn.x = hp.x + thigh * Math.sin(aT);
      kn.y = hp.y + thigh * Math.cos(aT);
      const an = this.an[i];
      an.x = kn.x + shin * Math.sin(aS);
      an.y = kn.y + shin * Math.cos(aS);
      // Toes drop a little while the foot swings through.
      const lift = walk * c * 0.03;
      const tp = this.toe[i];
      tp.x = an.x + d * 0.062 * (1 - ft * 0.5);
      tp.y = an.y + 0.012 + lift;
      if (an.y > lowest) lowest = an.y;
    }
    const drop = -(lowest + 0.014);
    for (let i = 0; i < 2; i++) {
      this.hip[i].y += drop;
      this.kn[i].y += drop;
      this.an[i].y += drop;
      this.toe[i].y += drop;
    }
    const pv = this.pelvis;
    pv.x = 0;
    pv.y = drop;

    // Spine, a little hunched forward, more so when walking.
    const a = d * (0.035 + 0.05 * walk) + sway;
    const sinA = Math.sin(a);
    const cosA = Math.cos(a);
    const spine = 0.318;
    const nk = this.neck;
    nk.x = pv.x + spine * sinA;
    nk.y = pv.y - spine * cosA;

    // Shoulders: narrow in profile, a little wider as it turns toward you.
    const hw = lerp(0.03, 0.082, ft);
    for (let i = 0; i < 2; i++) {
      const side = i ? 1 : -1;
      const s = this.sh[i];
      s.x = nk.x - 0.022 * sinA + side * hw * cosA - (i ? d * 0.01 * (1 - ft) : 0);
      s.y = nk.y + 0.022 * cosA + side * hw * sinA + 0.012 * ft;
      // Arms swing against the legs: arm i with leg 1 - i.
      const swing = -Math.sin(phi + i * Math.PI);
      const aU = d * (walk * 0.3 * swing + 0.035) + side * ft * 0.1;
      const up = 0.19 * this.armK;
      const e = this.el[i];
      e.x = s.x + up * Math.sin(aU);
      e.y = s.y + up * Math.cos(aU);
      const aF = aU + d * (0.08 + walk * 0.22 * Math.max(0, swing));
      const fore = 0.182 * this.armK;
      const w = this.wr[i];
      w.x = e.x + fore * Math.sin(aF);
      w.y = e.y + fore * Math.cos(aF);
      const aH = aF + d * 0.05;
      const hand = 0.105 * this.armK;
      const tp = this.tip[i];
      tp.x = w.x + hand * Math.sin(aH);
      tp.y = w.y + hand * Math.cos(aH);
    }

    // Head on a long neck, pushed forward in profile, upright when it faces you.
    const nA = a + d * this.hunch * (1 - fh);
    const hb = this.headBase;
    hb.x = nk.x + 0.058 * Math.sin(nA);
    hb.y = nk.y - 0.058 * Math.cos(nA);
    const hd = this.head;
    hd.x = hb.x + d * 0.012 * (1 - fh) + this.lookX * 0.012 * fh;
    hd.y = hb.y - 0.05 + this.lookY * 0.005 * fh;
    this.headRot = d * 0.12 * (1 - fh) + this.lookX * 0.07 * fh + this.cockSide * this.cockAmt * cock;
    this.headRx = lerp(0.045, 0.035, fh);
    this.jaw = 1 - fh;

    // Torso outline: down the back from the shoulder, round the hips, up the front.
    const chest = lerp(0.05, 0.066, ft);
    const waist = lerp(0.036, 0.044, ft);
    const hips = lerp(0.044, 0.056, ft);
    const prof = d * (1 - ft);
    // [t along the spine, half width, forward bulge]
    this.torsoAt(0, 0.02, hw + 0.016, 0, -1);
    this.torsoAt(1, 0.28, chest, prof * 0.01, -1);
    this.torsoAt(2, 0.66, waist, -prof * 0.004, -1);
    this.torsoAt(3, 0.98, hips, 0, -1);
    this.torsoAt(4, 1.08, hips * 0.5, 0, -1);
    this.torsoAt(5, 1.08, hips * 0.5, 0, 1);
    this.torsoAt(6, 0.98, hips, 0, 1);
    this.torsoAt(7, 0.66, waist, -prof * 0.004, 1);
    this.torsoAt(8, 0.28, chest, prof * 0.01, 1);
    this.torsoAt(9, 0.02, hw + 0.016, 0, 1);
  }

  private headRot = 0;
  private headRx = 0.04;
  private jaw = 1;

  private torsoAt(i: number, along: number, half: number, bulge: number, side: number): void {
    const nk = this.neck;
    const pv = this.pelvis;
    const dx = pv.x - nk.x;
    const dy = pv.y - nk.y;
    const len = Math.hypot(dx, dy) || 1;
    // Perpendicular to the spine, pointing to screen-right when upright.
    const px = -dy / len;
    const py = dx / len;
    const p = this.torso[i];
    p.x = nk.x + dx * along + px * (side * half + bulge);
    p.y = nk.y + dy * along + py * (side * half + bulge);
  }

  /** Draw the pose sharp, then soften it into the visible canvas. */
  private paint(z: number): void {
    const s = this.sctx!;
    const v = this.vctx!;
    const sharp = this.sharp!;
    const W = sharp.width;
    const Hc = sharp.height;

    s.setTransform(1, 0, 0, 1, 0, 0);
    s.clearRect(0, 0, W, Hc);
    s.setTransform(RES, 0, 0, RES, ORIGIN_X * RES, ORIGIN_Y * RES);
    s.fillStyle = s.strokeStyle = this.light ? 'rgb(24,28,44)' : 'rgb(98,114,142)';
    s.lineCap = 'round';
    s.lineJoin = 'round';

    // Torso: a smooth closed curve through the outline points.
    const tp = this.torso;
    const n = tp.length;
    s.beginPath();
    s.moveTo((tp[n - 1].x + tp[0].x) / 2, (tp[n - 1].y + tp[0].y) / 2);
    for (let i = 0; i < n; i++) {
      const a = tp[i];
      const b = tp[(i + 1) % n];
      s.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    s.fill();

    // Neck and shoulders.
    this.seg(this.neck, this.headBase, 0.03);
    this.seg(this.neck, this.sh[0], 0.044);
    this.seg(this.neck, this.sh[1], 0.044);

    for (let i = 0; i < 2; i++) {
      // Legs: thin thighs tapering to bony knees, thinner shins, long feet.
      this.limb(this.hip[i], this.kn[i], 0.066, 0.036);
      this.limb(this.kn[i], this.an[i], 0.038, 0.022);
      this.limb(this.an[i], this.toe[i], 0.026, 0.014);
      // Arms: long, with long narrow hands.
      this.limb(this.sh[i], this.el[i], 0.04, 0.026);
      this.limb(this.el[i], this.wr[i], 0.027, 0.018);
      this.limb(this.wr[i], this.tip[i], 0.022, 0.007);
    }

    // Head, and a jaw that shows in profile.
    const hd = this.head;
    s.beginPath();
    s.ellipse(hd.x, hd.y, this.headRx, 0.058, this.headRot, 0, TAU);
    s.fill();
    if (this.jaw > 0.05) {
      const c = Math.cos(this.headRot);
      const sn = Math.sin(this.headRot);
      const jx = this.dir * 0.022 * this.jaw;
      const jy = 0.03;
      s.beginPath();
      s.ellipse(hd.x + jx * c - jy * sn, hd.y + jx * sn + jy * c, 0.022 * this.jaw + 0.012, 0.02, this.headRot, 0, TAU);
      s.fill();
    }

    if (this.legFade) {
      s.setTransform(1, 0, 0, 1, 0, 0);
      s.globalCompositeOperation = 'destination-in';
      s.fillStyle = this.legFade;
      s.fillRect(0, 0, W, Hc);
      s.globalCompositeOperation = 'source-over';
    }

    // Soften. Nearer the glass means a tighter, darker core.
    v.setTransform(1, 0, 0, 1, 0, 0);
    v.globalCompositeOperation = 'source-over';
    v.clearRect(0, 0, W, Hc);
    const f = this.canFilter;
    if (this.light) {
      // A wide, faint penumbra, then the core.
      v.globalAlpha = 0.35;
      if (f) v.filter = blurFilter(lerp(12, 8, z));
      v.drawImage(sharp, 0, 0);
      v.globalAlpha = 1;
      if (f) v.filter = blurFilter(lerp(4.6, 2.4, z));
      v.drawImage(sharp, 0, 0);
    } else {
      // A faint cold haze and rim, hollowed out by the figure standing in front of it.
      v.globalAlpha = 0.9;
      if (f) v.filter = blurFilter(lerp(13, 9, z));
      v.drawImage(sharp, 0, 0);
      v.globalAlpha = 0.3;
      if (f) v.filter = blurFilter(lerp(6, 4, z));
      v.drawImage(sharp, 0, 0);
      // Cut the figure out twice so even thin limbs are solid dark, not outlines.
      v.globalCompositeOperation = 'destination-out';
      v.globalAlpha = 1;
      if (f) v.filter = blurFilter(lerp(2.2, 1.2, z));
      v.drawImage(sharp, 0, 0);
      v.drawImage(sharp, 0, 0);
      v.globalCompositeOperation = 'source-over';
    }
    v.globalAlpha = 1;
    if (f) v.filter = 'none';
  }

  private seg(a: Pt, b: Pt, width: number): void {
    const s = this.sctx!;
    s.lineWidth = width;
    s.beginPath();
    s.moveTo(a.x, a.y);
    s.lineTo(b.x, b.y);
    s.stroke();
  }

  /** A tapered limb: round at both ends, width wa at a and wb at b. */
  private limb(a: Pt, b: Pt, wa: number, wb: number): void {
    const s = this.sctx!;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const h = Math.PI / 2;
    s.beginPath();
    s.arc(a.x, a.y, wa / 2, ang + h, ang - h);
    s.arc(b.x, b.y, wb / 2, ang - h, ang + h);
    s.closePath();
    s.fill();
  }

  private pt(): Pt {
    return { x: 0, y: 0 };
  }
}
