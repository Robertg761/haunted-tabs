// Possession: about a second in which something takes over the real page.
// Plays when you return to a dead tab, and when a poltergeist reaches into the
// tab you are on. Everything it adds is removed when it ends, and it leaves no
// style behind on the page.
//
// In Chromium the page itself is pulled apart through SVG backdrop filters: its
// colour channels drift apart, slices of it are thrown sideways and swing back
// with weight, blocks of it crush into macroblocks, and a tracking band rolls
// down it. If the machine cannot keep up, the full-screen split gives way to a
// plain darkening after the first few frames. Other engines get the same scene
// built from CSS backdrop filters.
//
// Photosensitive-safe: one bright full-screen frame (a short negative), one
// darken and lift, and the apparition surfacing once. Nothing strobes. With
// reduced motion it is only a slow darkening with the message fading in and out.

import { OUR_ATTR, Z, seeded } from './overlay';
import { channelMatrix, drawApparition, drawGrain, drawSnow, moshFilter, shearFilter, splitFilter } from './possession-art';

/** The choreography is written for this length; longer runs play it in slow motion. */
const NOMINAL_S = 1.1;
const BANDS = 7;
const BLOCKS = 5;
const TRACK_SLICES = 4;
const HITS = [0.02, 0.15, 0.26, 0.37, 0.5, 0.62, 0.74];
const MOSH_BURSTS: [number, number][] = [
  [0.27, 0.35],
  [0.5, 0.57],
  [0.71, 0.76],
];
const RELEASE = 0.8;
const SETTLED = 0.975;
/** How often glyphs change: about every 30 ms at normal speed. */
const TICKS = 36;
/** Frames slower than this (ms, median) drop the full-screen split. */
const SLOW_FRAME_MS = 40;
const NOISE_GLYPHS = '▓▒░█▚▞▙▟▀▄╳╱╲◢◣◤◥≡ΞЖЯ¥#%&@';
const NEAR_GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const BASE_CSS = `
:host { all: initial; }
.wrap { position: fixed; inset: 0; pointer-events: none; overflow: hidden; z-index: ${Z.possession}; }
.fill { position: absolute; inset: 0; }
.dim { opacity: 0; backdrop-filter: brightness(.36) saturate(.45) contrast(1.12); -webkit-backdrop-filter: brightness(.36) saturate(.45) contrast(1.12); }
.vignette { opacity: 0; background: radial-gradient(ellipse 80% 75% at 50% 48%, transparent 36%, rgba(10,0,6,.5) 68%, rgba(3,0,2,.94) 100%); }
.ghost { position: absolute; left: 50%; top: 43%; opacity: 0; transform: translate(-50%, -50%); }
.ghost canvas { display: block; width: 100%; height: 100%; }
.stage { position: absolute; inset: 0; display: grid; place-items: center; padding: 0 6vw; }
.msg { position: relative; max-width: min(100%, 1180px); text-align: center; color: #f2ece2;
  font-family: "Didot", "Bodoni 72", "Bodoni MT", "Playfair Display", "Cormorant Garamond", Georgia, "Times New Roman", "Liberation Serif", serif;
  font-weight: 500; line-height: 1.12; font-size: 64px; text-rendering: geometricPrecision; -webkit-font-smoothing: antialiased; }
.msg::before { content: ""; position: absolute; inset: -45% -14%; z-index: -1;
  background: radial-gradient(closest-side, rgba(0,0,0,.62), rgba(0,0,0,.34) 55%, transparent); }
.w { display: inline-flex; flex-wrap: wrap; justify-content: center; max-width: 100%; }
.g { display: inline-block; position: relative; margin: 0 .07em; white-space: pre;
  text-shadow: -1.5px 0 rgba(255,40,72,.6), 1.5px 0 rgba(0,220,255,.55), 0 0 .5em rgba(255,240,230,.18); }
.g.h { opacity: 0; }
.g[data-c] > span { visibility: hidden; }
.g[data-c]::after { content: attr(data-c); position: absolute; inset: 0; text-align: center; color: #e8f6ff; }
`;

const GLITCH_CSS = `
.band, .blk { position: absolute; left: 0; top: 0; visibility: hidden; }
.band { width: 100%; }
.track { position: absolute; left: 0; top: 0; width: 100%; height: 15vh; transform: translateY(-30vh); }
.track > div { position: relative; width: 100%; }
.track canvas { position: absolute; inset: 0; width: 100%; height: 100%; opacity: .8; }
.track::after { content: ""; position: absolute; inset: 0;
  background: linear-gradient(to bottom, rgba(255,255,255,.14) 0, rgba(255,255,255,0) 6%, rgba(255,255,255,0) 90%, rgba(0,0,0,.25) 100%); }
.flash { visibility: hidden; backdrop-filter: invert(.9) contrast(1.1) saturate(.5) brightness(.9); -webkit-backdrop-filter: invert(.9) contrast(1.1) saturate(.5) brightness(.9); }
.vignette.scan { background: repeating-linear-gradient(to bottom, rgba(0,0,0,.2) 0 1px, transparent 1px 3px), radial-gradient(ellipse 80% 75% at 50% 48%, transparent 36%, rgba(10,0,6,.5) 68%, rgba(3,0,2,.94) 100%); }
.grain { position: absolute; left: -3%; top: -3%; width: 106%; height: 106%; opacity: 0; image-rendering: pixelated; }
/* Without SVG backdrop filters: tinted shards of the page instead of displaced ones. */
.css .band { box-shadow: -3px 0 rgba(255,40,72,.45), 3px 0 rgba(0,220,255,.4); }
.css .band.t0 { backdrop-filter: brightness(1.35) contrast(1.3) saturate(2.4) hue-rotate(-25deg); -webkit-backdrop-filter: brightness(1.35) contrast(1.3) saturate(2.4) hue-rotate(-25deg); }
.css .band.t1 { backdrop-filter: invert(.8) hue-rotate(180deg) contrast(1.15); -webkit-backdrop-filter: invert(.8) hue-rotate(180deg) contrast(1.15); }
.css .band.t2 { backdrop-filter: blur(1.5px) brightness(1.25) saturate(1.8) hue-rotate(160deg); -webkit-backdrop-filter: blur(1.5px) brightness(1.25) saturate(1.8) hue-rotate(160deg); }
.css .blk { backdrop-filter: blur(4px) contrast(1.9) saturate(2.2) hue-rotate(70deg); -webkit-backdrop-filter: blur(4px) contrast(1.9) saturate(2.2) hue-rotate(70deg); }
.css .track { backdrop-filter: blur(.8px) brightness(1.2) contrast(1.15) saturate(1.4); -webkit-backdrop-filter: blur(.8px) brightness(1.2) contrast(1.15) saturate(1.4); }
`;

let glitching = false;
let runs = 0;

interface Scene {
  end(): void;
}

/** The tab may still be hidden for a moment right after it is switched to. */
function whenVisible(timeoutMs: number): Promise<boolean> {
  if (document.visibilityState === 'visible') return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => {
      document.removeEventListener('visibilitychange', onChange);
      clearTimeout(timer);
      resolve(document.visibilityState === 'visible');
    };
    const onChange = () => document.visibilityState === 'visible' && done();
    const timer = setTimeout(done, timeoutMs);
    document.addEventListener('visibilitychange', onChange);
  });
}

export async function possess(message: string, durationMs: number): Promise<void> {
  if (glitching || !(await whenVisible(600))) return;
  glitching = true;
  const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 1100;
  let scene: Scene | null = null;
  try {
    // The same message plays the same way on a tab; a repeat varies.
    const seed = hash(message) + 0x9e3779b9 * runs++;
    scene = matchMedia('(prefers-reduced-motion: reduce)').matches ? calm(message, duration, seed) : glitch(message, duration, seed);
  } catch (err) {
    console.warn('[haunted-tabs] possession', err);
  }
  return new Promise((resolve) => {
    setTimeout(() => {
      try {
        scene?.end();
      } finally {
        glitching = false;
        resolve();
      }
    }, duration);
  });
}

// ---------------------------------------------------------------------------
// Shared building blocks

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function div(className: string, parent: Element): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  parent.appendChild(el);
  return el;
}

function mountHost(css: string): { host: HTMLElement; root: ShadowRoot; wrap: HTMLDivElement } {
  const host = document.createElement('div');
  host.setAttribute(OUR_ATTR, 'glitch');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = css;
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  root.append(style, wrap);
  return { host, root, wrap };
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Keyframes on a 0..1 timeline, each with the easing into the next one. */
type Key = [offset: number, props: Record<string, string | number>, easing?: string];
function keys(list: Key[]): Keyframe[] {
  return list.map(([offset, props, easing]) => ({ ...props, offset, easing: easing ?? 'linear' }));
}
const EASE_OUT = 'cubic-bezier(.16,1,.3,1)';
const EASE_IN = 'cubic-bezier(.7,0,.84,0)';
const EASE_IN_OUT = 'cubic-bezier(.65,0,.35,1)';
const CUT = 'steps(1, end)';

/** How dark the page is: slammed down as it takes hold, lifted as it lets go. Matches DIM_KEYS. */
function darkness(u: number): number {
  if (u < 0.07) return 1 - (1 - u / 0.07) ** 4;
  if (u < RELEASE) return 1;
  const t = clamp01((u - RELEASE) / 0.15);
  return 1 - (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
}
const DIM_KEYS: Key[] = [[0, { opacity: 0 }, EASE_OUT], [0.07, { opacity: 1 }], [RELEASE, { opacity: 1 }, EASE_IN_OUT], [0.95, { opacity: 0 }], [1, { opacity: 0 }]];

interface Glyph {
  el: HTMLSpanElement;
  at: number;
  out: number;
  shown: string;
  corrupt: string;
  shadow: string;
  transform: string;
}

/**
 * The message as words of glyphs. Words wrap as a whole at spaces, and a word too
 * long for the screen wraps inside itself, so nothing ever runs off the edge.
 */
function buildMessage(parent: HTMLElement, text: string, rand: () => number): { msg: HTMLDivElement; glyphs: Glyph[] } {
  const stage = div('stage', parent);
  const msg = div('msg', stage);
  const glyphs: Glyph[] = [];
  const words = text.trim().split(/\s+/).filter(Boolean);
  const count = words.reduce((n, w) => n + [...w].length, 0);
  let i = 0;
  words.forEach((word, wi) => {
    if (wi > 0) msg.appendChild(document.createTextNode(' '));
    const w = document.createElement('span');
    w.className = 'w';
    for (const ch of word) {
      const g = document.createElement('span');
      g.className = 'g h';
      const inner = document.createElement('span');
      inner.textContent = ch;
      g.appendChild(inner);
      w.appendChild(g);
      const p = count > 1 ? i / (count - 1) : 0;
      glyphs.push({ el: g, at: p, out: rand(), shown: 'h', corrupt: '', shadow: '', transform: '' });
      i++;
    }
    msg.appendChild(w);
  });
  return { msg, glyphs };
}

/** Big enough to own the screen, small enough to fit it, at any width. */
function fitMessage(msg: HTMLDivElement, length: number): void {
  const vw = innerWidth;
  const vh = innerHeight;
  const avail = Math.min(vw * 0.88, 1180);
  const lines = length <= 18 ? 1 : length <= 40 ? 2 : 3;
  const perLine = Math.ceil(length / lines) + 1;
  let size = Math.max(20, Math.min(avail / (perLine * 0.9), (vh * 0.48) / (lines * 1.15), 124));
  const words = Array.from(msg.children) as HTMLElement[];
  for (let n = 0; n < 10; n++) {
    msg.style.fontSize = `${size.toFixed(1)}px`;
    // Fits when no word had to break inside itself and the block is not too tall.
    const whole = words.every((w) => w.offsetHeight < size * 1.7);
    if ((whole && msg.offsetHeight <= vh * 0.6) || size <= 18) break;
    size *= 0.92;
  }
}

function placeGhost(wrap: HTMLElement, rand: () => number): HTMLDivElement {
  const ghost = div('ghost', wrap);
  const h = Math.min(innerHeight * 0.64, innerWidth * 0.95);
  ghost.style.width = `${Math.round(h * 0.75)}px`;
  ghost.style.height = `${Math.round(h)}px`;
  ghost.appendChild(drawApparition(rand));
  return ghost;
}

/** Undo-able inline style, restored exactly, including removing a style attribute we created. */
function tempStyle(el: HTMLElement, prop: string, value: string): () => void {
  const hadAttr = el.hasAttribute('style');
  const prev = el.style.getPropertyValue(prop);
  const priority = el.style.getPropertyPriority(prop);
  el.style.setProperty(prop, value);
  return () => {
    el.style.setProperty(prop, prev, priority);
    if (!hadAttr && el.getAttribute('style') === '') el.removeAttribute('style');
  };
}

/**
 * Can backdrop-filter take an SVG filter here? Only Chromium renders it; others
 * accept the syntax and draw nothing. userAgentData is Chromium-only but needs a
 * secure context, so plain http pages are recognised by the UA token instead.
 */
function svgBackdrops(): boolean {
  const chromium = 'userAgentData' in navigator || /\bChrom(e|ium)\/\d/.test(navigator.userAgent);
  return chromium && CSS.supports('backdrop-filter', 'url(#a)');
}

/** A damped spring on the nominal timeline: things with weight overshoot and settle. */
class Spring {
  x = 0;
  v = 0;
  target = 0;
  constructor(
    private hz: number,
    public damping: number,
  ) {}
  step(dt: number): void {
    const w = 2 * Math.PI * this.hz;
    for (let t = 0; t < dt; t += 0.004) {
      const h = Math.min(0.004, dt - t);
      this.v += (w * w * (this.target - this.x) - 2 * this.damping * w * this.v) * h;
      this.x += this.v * h;
    }
  }
}

// ---------------------------------------------------------------------------
// The full glitch

function glitch(message: string, duration: number, seed: number): Scene {
  const rand = seeded(seed);
  const pick = <T>(list: ArrayLike<T>): T => list[Math.floor(rand() * list.length)];
  const vw = innerWidth;
  const vh = innerHeight;
  const scale = Math.min(1.5, Math.max(0.6, vw / 1280));
  // The filters are static markup; a page enforcing Trusted Types refuses it, and
  // then the CSS version plays instead.
  const holder = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  let svg = svgBackdrops();
  try {
    if (svg) holder.innerHTML = '<filter id="probe"/>';
  } catch {
    svg = false;
  }
  const { host, root, wrap } = mountHost(BASE_CSS + GLITCH_CSS);
  if (!svg) wrap.classList.add('css');
  let filters = '';
  const useFilter = (el: HTMLElement, id: string, markup: string) => {
    filters += markup;
    el.style.backdropFilter = `url(#${id})`;
  };

  // Bottom to top. The page is split and darkened first; the words and the face
  // sit above that, under the slices, blocks and tracking that tear them too.
  const split = svg ? div('fill', wrap) : null;
  if (split) useFilter(split, 'pg', splitFilter('pg'));
  const dim = div('fill dim', wrap);
  if (split) dim.style.display = 'none';
  const ghost = placeGhost(wrap, rand);
  const { msg, glyphs } = buildMessage(wrap, message, rand);

  const bands = Array.from({ length: BANDS }, (_, i) => {
    const el = div(`band t${i % 3}`, wrap);
    const h = Math.round(vh * (0.02 + rand() * rand() * 0.12));
    el.style.height = `${h}px`;
    if (svg) useFilter(el, `b${i}`, splitFilter(`b${i}`));
    else el.style.width = `${Math.round(40 + rand() * 50)}%`;
    return { el, h, y: 0, spring: new Spring(8 + rand() * 3, 0.26), shown: false };
  });
  const blocks = Array.from({ length: BLOCKS }, (_, i) => {
    const el = div('blk', wrap);
    if (svg) useFilter(el, `m${i}`, moshFilter(`m${i}`, pick([6, 8, 8, 10])));
    return el;
  });
  const track = div('track', wrap);
  if (svg) {
    // Rows of the page sheared by different amounts, the way a bad tracking band does.
    let left = 1;
    for (let i = 0; i < TRACK_SLICES; i++) {
      const el = div('', track);
      const part = i === TRACK_SLICES - 1 ? left : left * (0.15 + rand() * 0.4);
      left -= part;
      el.style.height = `${(part * 100).toFixed(2)}%`;
      useFilter(el, `t${i}`, shearFilter(`t${i}`, (rand() - 0.35) * 46 * scale));
    }
  }
  const snow = drawSnow(rand);
  track.appendChild(snow);
  const flash = div('fill flash', wrap);
  // The screen itself: scanlines and a dark vignette over everything, edges first.
  const screen = div('fill vignette scan', wrap);
  const grain = drawGrain(vw, vh, rand);
  grain.className = 'grain';
  wrap.appendChild(grain);

  const hooks = (id: string) => {
    const f = root.getElementById(id);
    const get = (k: string) => f?.querySelector(`[data-k="${k}"]`) ?? null;
    return { r: get('r'), g: get('g'), b: get('b'), mr: get('mr'), mg: get('mg'), mb: get('mb'), o: get('o') };
  };
  if (filters) {
    holder.setAttribute('width', '0');
    holder.setAttribute('height', '0');
    holder.setAttribute('aria-hidden', 'true');
    holder.style.position = 'absolute';
    holder.innerHTML = filters;
    root.appendChild(holder);
  }
  const written = new Map<Element, string>();
  const setAttrs = (el: Element | null, attrs: Record<string, string>) => {
    if (!el) return;
    const key = Object.values(attrs).join('|');
    if (written.get(el) === key) return;
    written.set(el, key);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  };
  const setOffset = (el: Element | null, dx: number, dy = 0) => setAttrs(el, { dx: dx.toFixed(1), dy: dy.toFixed(1) });

  document.documentElement.appendChild(host);
  fitMessage(msg, glyphs.length);

  const cleanups: (() => void)[] = [];
  const opts: KeyframeAnimationOptions = { duration, fill: 'both' };
  const anims: Animation[] = [
    dim.animate(keys(DIM_KEYS), opts),
    screen.animate(keys([[0, { opacity: 0 }, EASE_OUT], [0.1, { opacity: 1 }], [RELEASE, { opacity: 1 }, EASE_IN_OUT], [0.95, { opacity: 0 }], [1, { opacity: 0 }]]), opts),
    // The one bright frame: a short photographic negative as it takes hold.
    flash.animate(keys([[0, { visibility: 'hidden' }, CUT], [0.035, { visibility: 'visible' }, CUT], [0.085, { visibility: 'hidden' }], [1, { visibility: 'hidden' }]]), opts),
    track.animate(
      keys([
        [0, { transform: 'translateY(-30vh)' }],
        [0.06, { transform: 'translateY(-18vh)' }, 'cubic-bezier(.45,.05,.55,.95)'],
        [0.72, { transform: 'translateY(112vh)' }],
        [1, { transform: 'translateY(112vh)' }],
      ]),
      opts,
    ),
    // It surfaces once, drifts closer, and sinks back into the noise.
    ghost.animate(
      keys([
        [0, { opacity: 0, transform: 'translate(-50%, -50%) scale(.94)' }],
        [0.27, { opacity: 0, transform: 'translate(-50%, -50%) scale(.95)' }, EASE_OUT],
        [0.33, { opacity: 0.3, transform: 'translate(-50%, -50%) scale(.965)' }, CUT],
        [0.355, { opacity: 0.22, transform: 'translate(-49%, -50%) scale(.97)' }, CUT],
        [0.375, { opacity: 0.38, transform: 'translate(-50%, -50%) scale(.975)' }],
        [0.5, { opacity: 0.34, transform: 'translate(-50%, -50.5%) scale(1.01)' }, EASE_IN],
        [0.6, { opacity: 0, transform: 'translate(-50%, -51%) scale(1.03)' }],
        [1, { opacity: 0, transform: 'translate(-50%, -51%) scale(1.03)' }],
      ]),
      opts,
    ),
    // Signal lost: the words collapse into a line and go out.
    msg.animate(
      keys([
        [0, { transform: 'none', opacity: 1 }],
        [0.79, { transform: 'none', opacity: 1 }, 'cubic-bezier(.55,0,.85,.35)'],
        [0.86, { transform: 'scale(1.35, .012)', opacity: 1 }, CUT],
        [0.875, { transform: 'scale(1.35, .012)', opacity: 0 }],
        [1, { transform: 'scale(1.35, .012)', opacity: 0 }],
      ]),
      opts,
    ),
  ];
  // Film grain, jittered about 24 times a second. Its average brightness never changes.
  const grainKeys: Key[] = [];
  for (let i = 0; i <= 26; i++) {
    const t = i / 26;
    const op = 0.55 * smooth(0.02, 0.1, t) * (1 - smooth(0.84, 0.96, t));
    grainKeys.push([t, { opacity: op, transform: `translate(${((rand() - 0.5) * 4).toFixed(2)}%, ${((rand() - 0.5) * 4).toFixed(2)}%)` }, CUT]);
  }
  anims.push(grain.animate(keys(grainKeys), opts));

  // Without SVG filters the page itself shudders: the body moves, never <html>,
  // and sideways overflow is clipped meanwhile so no scrollbar flashes up.
  if (!svg && document.body) {
    const sim = { x: new Spring(7, 0.38), y: new Spring(7, 0.38) };
    const frames: Keyframe[] = [];
    let last = 0;
    for (let i = 0; i <= 60; i++) {
      const u = i / 60;
      sim.x.target = u > 0.02 && u < 0.09 ? 12 * scale : 0;
      sim.y.target = u > 0.02 && u < 0.09 ? -14 * scale : 0;
      if (u >= 0.84 && last < 0.84) sim.x.v += 260 * scale;
      if (u > 0.94) sim.x.damping = sim.y.damping = 1.2;
      sim.x.step((u - last) * NOMINAL_S);
      sim.y.step((u - last) * NOMINAL_S);
      last = u;
      const still = u >= SETTLED;
      frames.push({ offset: u, transform: still ? 'none' : `translate(${sim.x.x.toFixed(1)}px, ${sim.y.x.toFixed(1)}px)` });
    }
    cleanups.push(tempStyle(document.documentElement, 'overflow-x', 'clip'));
    anims.push(document.body.animate(frames, { duration, fill: 'none' }));
  }

  // --- Per frame: filter offsets, springs, blocks and glyphs.
  const page = split ? hooks('pg') : null;
  const bandHooks = svg ? bands.map((_, i) => hooks(`b${i}`)) : [];
  const blockHooks = svg ? blocks.map((_, i) => hooks(`m${i}`)) : [];
  const gx = new Spring(7, 0.4);
  const gy = new Spring(7, 0.4);

  const placeBand = (band: (typeof bands)[number]) => {
    // Bands gather around the middle of the screen, where the eye is.
    const centre = vh * (0.5 + (rand() - 0.5) * (rand() < 0.6 ? 0.5 : 1.1));
    band.y = Math.round(Math.min(vh - band.h, Math.max(0, centre - band.h / 2)));
    if (!svg) band.el.style.transform = `translate(${Math.round(rand() * vw * 0.6)}px, ${band.y}px)`;
    else band.el.style.transform = `translateY(${band.y}px)`;
  };
  bands.forEach(placeBand);

  let lastU = 0;
  let hitIndex = 0;
  let lastHit = -1;
  let tick = -1;
  let moshTick = -1;
  let raf = 0;
  let lite = !split;
  const gaps: number[] = [];
  let lastNow = 0;
  const goLite = () => {
    lite = true;
    if (split) split.style.display = 'none';
    dim.style.display = '';
  };
  const clock = anims[0];
  const setupDone = performance.now();

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const u = clamp01(Number(clock.currentTime ?? 0) / duration);
    const dt = Math.max(0, (u - lastU) * NOMINAL_S);
    const tau = u * NOMINAL_S;
    const crossed = (at: number) => lastU < at && u >= at;
    // A machine that cannot keep up loses the full-screen split, not the scene.
    if (!lite && lastNow >= 0) {
      // The first frame pays for setting up; judge the ones after it, quickly.
      if (lastNow) gaps.push(now - lastNow);
      else if (now - setupDone > 250) goLite();
      lastNow = now;
      const judged = gaps.slice(1);
      const spent = judged.reduce((a, b) => a + b, 0);
      if (judged.length >= 3 || spent > 150) {
        const sorted = judged.sort((a, b) => a - b);
        if (sorted[sorted.length >> 1] > SLOW_FRAME_MS) goLite();
        gaps.length = 0;
        lastNow = -1;
      }
    }
    lastU = u;
    const env = smooth(0, 0.05, u) * (1 - smooth(0.78, 0.92, u));
    const still = u >= SETTLED;

    // Hits: the page is struck, slices are thrown and swing back with weight.
    while (hitIndex < HITS.length && u >= HITS[hitIndex]) {
      lastHit = HITS[hitIndex];
      const strength = hitIndex === 0 ? 1.3 : 0.6 + rand() * 0.5;
      for (const band of bands) {
        const thrown = rand() < (hitIndex === 0 ? 0.85 : 0.5);
        band.spring.target = thrown ? (rand() < 0.5 ? -1 : 1) * vw * 0.05 * strength * (0.35 + rand() * 0.65) : 0;
        if (rand() < 0.5) placeBand(band);
      }
      gx.v += (rand() - 0.5) * 360 * scale * strength;
      hitIndex++;
    }
    const slam = u >= 0.02 && u < 0.09;
    gx.target = slam ? 12 * scale : 0;
    gy.target = slam ? -16 * scale : 0;
    if (u >= RELEASE) for (const band of bands) band.spring.target = 0;
    if (crossed(0.84)) gx.v += 240 * scale;
    const settling = u > 0.94;
    gx.damping = gy.damping = settling ? 1.2 : 0.4;
    gx.step(dt);
    gy.step(dt);

    // The whole page: displaced, darkened, colour channels pulled apart.
    if (page && !lite) {
      const sinceHit = lastHit < 0 ? 9 : tau - lastHit * NOMINAL_S;
      const kick = 11 * Math.exp(-sinceHit / 0.05);
      const s = still ? 0 : env * (3.5 + 2 * Math.sin(tau * 19) + 1.2 * Math.sin(tau * 41 + 1) + kick) * scale;
      const sy = s * 0.2 * Math.sin(tau * 13);
      const x = still ? 0 : gx.x;
      const y = still ? 0 : gy.x;
      setOffset(page.r, x - s, y + sy);
      setOffset(page.g, x, y);
      setOffset(page.b, x + s, y - sy);
      const d = Math.round(darkness(u) * 200) / 200;
      setAttrs(page.mr, { values: channelMatrix(0, d) });
      setAttrs(page.mg, { values: channelMatrix(1, d) });
      setAttrs(page.mb, { values: channelMatrix(2, d) });
    }

    bands.forEach((band, i) => {
      band.spring.damping = settling ? 1.2 : 0.26;
      band.spring.step(dt);
      const x = still ? 0 : band.spring.x;
      // Fast-moving slices smear their colours apart: motion you can see the weight of.
      const fringe = (1.5 + Math.min(6, Math.abs(band.spring.v) * 0.005)) * scale;
      const visible = !still && Math.abs(x) > 0.5;
      if (visible !== band.shown) {
        band.el.style.visibility = visible ? 'visible' : 'hidden';
        band.shown = visible;
      }
      if (!visible) return;
      if (svg) {
        const h = bandHooks[i];
        setOffset(h.r, x - fringe);
        setOffset(h.g, x);
        setOffset(h.b, x + fringe);
      } else {
        band.el.style.transform = `translate(${(x * 3).toFixed(1)}px, ${band.y}px)`;
      }
    });

    // Datamosh bursts: blocks of the page crushed and dragged, held a few frames each.
    const burst = MOSH_BURSTS.find(([a, b]) => u >= a && u < b);
    const mt = burst ? Math.floor(u / 0.035) : -1;
    if (mt !== moshTick) {
      moshTick = mt;
      blocks.forEach((el, i) => {
        if (!burst || still || rand() < 0.3) {
          el.style.visibility = 'hidden';
          return;
        }
        // Snapped to a 16 px grid, like the macroblocks of real video.
        const q = (n: number) => Math.max(16, Math.round(n / 16) * 16);
        const w = q(vw * (0.04 + rand() * rand() * 0.22));
        const h = q(vh * (0.02 + rand() * rand() * 0.1));
        const x = q(rand() * (vw - w));
        const y = q(vh * (0.15 + rand() * 0.7) - h / 2);
        // The element is three blocks tall and shows only the middle one, so the
        // block can be filled with page from above or below it: a misplaced macroblock.
        el.style.width = `${w}px`;
        el.style.height = `${h * 3}px`;
        el.style.clipPath = `inset(${h}px 0)`;
        el.style.transform = `translate(${x}px, ${y - h}px)`;
        el.style.visibility = 'visible';
        if (svg) setOffset(blockHooks[i].o, Math.round((rand() - 0.5) * w * 0.4), (rand() < 0.5 ? -1 : 1) * Math.round(h * (0.5 + rand() * 0.5)));
      });
    }

    // Glyphs: they type themselves in through noise, twitch, and corrupt as it lets go.
    const t = Math.floor(u * TICKS);
    if (t !== tick) {
      const hitNow = lastHit >= 0 && u - lastHit < 1 / TICKS;
      tick = t;
      for (const g of glyphs) updateGlyph(g, u, hitNow, rand, pick);
    }
  };
  raf = requestAnimationFrame(frame);

  return {
    end() {
      cancelAnimationFrame(raf);
      anims.forEach((a) => a.cancel());
      cleanups.forEach((fn) => fn());
      host.remove();
    },
  };
}

const REVEAL_START = 0.09;
const REVEAL_SPREAD = 0.3;
const CORRUPT_FOR = 0.06;

function updateGlyph(g: Glyph, u: number, hitNow: boolean, rand: () => number, pick: (s: string) => string): void {
  const at = REVEAL_START + g.at * REVEAL_SPREAD;
  const outAt = 0.7 + g.out * 0.1;
  let shown = 'v';
  let corrupt = '';
  let jx = (rand() - 0.5) * 1.4;
  let jy = (rand() - 0.5) * 1;
  let chroma = 0;
  if (u < at || u >= 0.875) {
    shown = 'h';
  } else if (u < at + CORRUPT_FOR) {
    // Arriving: noise first, then a near-miss letter, then the real one.
    corrupt = u < at + CORRUPT_FOR * 0.55 ? pick(NOISE_GLYPHS) : pick(NEAR_GLYPHS);
    jx = (rand() - 0.5) * 10;
    jy = (rand() - 0.5) * 5;
    chroma = 4;
  } else if (u >= outAt) {
    if (rand() < 0.55) corrupt = pick(rand() < 0.6 ? NOISE_GLYPHS : NEAR_GLYPHS);
    jx = (rand() - 0.5) * 8;
    chroma = 3;
  } else if (hitNow && rand() < 0.35) {
    jx = (rand() - 0.5) * 14;
    chroma = 5;
    if (rand() < 0.3) corrupt = pick(NOISE_GLYPHS);
  } else if (u > 0.42 && rand() < 0.035) {
    corrupt = pick(NOISE_GLYPHS);
  }
  if (shown !== g.shown) {
    g.el.classList.toggle('h', shown === 'h');
    g.shown = shown;
  }
  if (shown === 'h') return;
  if (corrupt !== g.corrupt) {
    if (corrupt) g.el.setAttribute('data-c', corrupt);
    else g.el.removeAttribute('data-c');
    g.corrupt = corrupt;
  }
  const transform = `translate(${jx.toFixed(1)}px, ${jy.toFixed(1)}px)`;
  if (transform !== g.transform) {
    g.el.style.transform = transform;
    g.transform = transform;
  }
  const shadow = chroma ? `${-chroma}px 0 rgba(255,40,72,.8), ${chroma}px 0 rgba(0,220,255,.7), 0 0 .5em rgba(255,240,230,.2)` : '';
  if (shadow !== g.shadow) {
    g.el.style.textShadow = shadow;
    g.shadow = shadow;
  }
}

// ---------------------------------------------------------------------------
// Reduced motion: the page darkens, the words and the face fade in and out.

function calm(message: string, duration: number, seed: number): Scene {
  const rand = seeded(seed);
  const { host, wrap } = mountHost(BASE_CSS);
  const dim = div('fill dim', wrap);
  const vignette = div('fill vignette', wrap);
  const ghost = placeGhost(wrap, rand);
  const { msg, glyphs } = buildMessage(wrap, message, rand);
  for (const g of glyphs) g.el.classList.remove('h');
  document.documentElement.appendChild(host);
  fitMessage(msg, glyphs.length);

  const opts: KeyframeAnimationOptions = { duration, fill: 'both' };
  const fade = (peak: number, from: number, to: number) =>
    keys([[0, { opacity: 0 }], [from, { opacity: 0 }, EASE_IN_OUT], [from + 0.28, { opacity: peak }], [to - 0.26, { opacity: peak }, EASE_IN_OUT], [to, { opacity: 0 }], [1, { opacity: 0 }]]);
  const anims = [
    dim.animate(fade(1, 0, 1), opts),
    vignette.animate(fade(1, 0, 1), opts),
    ghost.animate(fade(0.12, 0.08, 0.92), opts),
    msg.animate(fade(1, 0.06, 0.94), opts),
  ];
  ghost.style.transform = 'translate(-50%, -50%)';
  return {
    end() {
      anims.forEach((a) => a.cancel());
      host.remove();
    },
  };
}
