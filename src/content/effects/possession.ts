// Possession: about a second in which something takes over the real page.
// Plays when you return to a dead tab, and when a poltergeist reaches into the
// tab you are on. Everything it adds is removed when it ends, and it never
// touches the page's own elements or styles.
//
// In Chromium the page itself is pulled apart through SVG backdrop filters: red
// drifts off cyan, slices of it are thrown sideways and swing back with weight,
// blocks of it crush into macroblocks, and a tracking band rolls down it. If the
// machine cannot keep up, it drops to the CSS version mid-flight. Other engines
// get the CSS version from the start.
//
// Choreography: the words type themselves in through noise, then hold clean
// (nothing tears through them but one twitch), then corrupt and collapse into a
// line as the page lets go.
//
// Photosensitive-safe: one bright full-screen frame (a short negative), one
// darken and lift, the apparition surfacing once. Nothing strobes. With reduced
// motion it is only a slow darkening with the message fading in and out.

import { OUR_ATTR, Z, seeded } from './overlay';
import { APPARITION_CHIN, channelMatrix, drawApparition, drawGrain, drawSnow, moshFilter, shearFilter, splitFilter, svgEl } from './possession-art';

const BANDS = 6;
const BLOCKS = 4;
const TRACK_SLICES = 3;
/** Moments the page is struck. Only TEAR_HIT may reach through the words. */
const HITS = [0.02, 0.12, 0.22, 0.37, 0.5, 0.63, 0.74];
const TEAR_HIT = 0.5;
/** Colour shocks for the CSS version, on these hits. */
const SHOCKS = [0.12, 0.37, 0.63];
const MOSH_BURSTS: [number, number][] = [
  [0.16, 0.24],
  [0.52, 0.58],
  [0.79, 0.85],
];
/** The words are whole and still between these. */
const HOLD_START = 0.28;
const HOLD_END = 0.78;
const RELEASE = 0.8;
const SETTLED = 0.975;
const REVEAL_START = 0.06;
const REVEAL_SPREAD = 0.16;
const CORRUPT_FOR = 0.05;
const GONE = 0.885;
/** Rolling median frame time (ms) above which the SVG version gives way. */
const SLOW_FRAME_MS = 40;
const NOISE_GLYPHS = '▓▒░█▚▞▙▟▀▄╳╱╲◢◣◤◥≡ΞЖЯ¥#%&@';
const NEAR_GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
/** Scripts whose letters join or reorder: these are animated word by word, never split. */
const SHAPED = /[֐-ࣿऀ-෿฀-࿿က-႟ក-᢯ᨀ-᪯ꠀ-꯿יִ-﷿ﹰ-﻿]|[\u{10800}-\u{10FFF}\u{1E900}-\u{1E95F}]/u;

const BASE_CSS = `
:host { all: initial; }
@media print { :host { display: none !important; } }
.wrap { position: fixed; inset: 0; pointer-events: none; overflow: hidden; z-index: ${Z.possession}; }
.fill { position: absolute; inset: 0; }
.dim { opacity: 0; backdrop-filter: contrast(.72) brightness(.36) saturate(.4); -webkit-backdrop-filter: contrast(.72) brightness(.36) saturate(.4); }
/* A real tint under the filter: still dark where backdrop-filter draws nothing. */
.dim.tint { background: rgba(6,3,5,.52); backdrop-filter: contrast(.6) brightness(.7) saturate(.45); -webkit-backdrop-filter: contrast(.6) brightness(.7) saturate(.45); }
.vignette { opacity: 0; background: radial-gradient(ellipse 80% 75% at 50% 48%, transparent 36%, rgba(10,0,6,.5) 68%, rgba(3,0,2,.94) 100%); }
.ghost { position: absolute; left: 50%; top: 0; opacity: 0; transform: translateX(-50%); }
.ghost canvas { display: block; width: 100%; height: 100%; }
.stage { position: absolute; inset: 0; display: grid; place-items: center; padding: 0 6vw; }
.msg { position: relative; max-width: min(100%, 1180px); text-align: center; color: #f2ece2; opacity: 0;
  font-family: "Didot", "Bodoni 72", "Bodoni MT", "Playfair Display", "Cormorant Garamond", Georgia, "Times New Roman", "Liberation Serif", serif;
  font-weight: 500; line-height: 1.12; font-size: 64px; text-rendering: geometricPrecision; -webkit-font-smoothing: antialiased; }
.msg::before { content: ""; position: absolute; inset: -45% -14%; z-index: -1;
  background: radial-gradient(closest-side, rgba(0,0,0,.78), rgba(0,0,0,.46) 55%, transparent); }
.w { display: inline-flex; flex-wrap: wrap; justify-content: center; max-width: 100%; }
.g { display: inline-block; position: relative; margin: 0 .07em; white-space: pre; }
.g, .wd { text-shadow: -1.5px 0 rgba(255,40,72,.6), 1.5px 0 rgba(0,220,255,.55), 0 0 .5em rgba(255,240,230,.18); }
.wd { letter-spacing: .04em; }
.h { opacity: 0; }
.g[data-c] { color: transparent !important; text-shadow: none !important; }
.g[data-c]::after { content: attr(data-c); position: absolute; inset: 0; text-align: center; color: #e8f6ff;
  text-shadow: -3px 0 rgba(255,40,72,.8), 3px 0 rgba(0,220,255,.7); }
`;

const GLITCH_CSS = `
.band, .blk { position: absolute; left: 0; top: 0; visibility: hidden; }
.band { width: 100%; }
.track { position: absolute; left: 0; top: 0; width: 100%; height: 15vh; transform: translateY(-30vh); }
.track > div { position: relative; width: 100%; }
.track canvas { position: absolute; inset: 0; width: 100%; height: 100%; opacity: .8; }
.track::after { content: ""; position: absolute; inset: 0;
  background: linear-gradient(to bottom, rgba(255,255,255,.16) 0, rgba(255,255,255,.04) 6%, rgba(255,255,255,.04) 90%, rgba(0,0,0,.25) 100%); }
.flash { visibility: hidden; backdrop-filter: invert(.9) contrast(1.1) saturate(.5) brightness(.9); -webkit-backdrop-filter: invert(.9) contrast(1.1) saturate(.5) brightness(.9); }
.shock { visibility: hidden; backdrop-filter: hue-rotate(150deg) saturate(2.4); -webkit-backdrop-filter: hue-rotate(150deg) saturate(2.4); }
.vignette.scan { background: repeating-linear-gradient(to bottom, rgba(0,0,0,.2) 0 1px, transparent 1px 3px), radial-gradient(ellipse 80% 75% at 50% 48%, transparent 36%, rgba(10,0,6,.5) 68%, rgba(3,0,2,.94) 100%); }
.grain { position: absolute; left: -3%; top: -3%; width: 106%; height: 106%; opacity: 0; image-rendering: pixelated; }
/* The CSS version: shards of the page shifted in colour and contrast instead of displaced. */
.css .band.t0 { backdrop-filter: hue-rotate(-35deg) saturate(3.2) brightness(1.08); -webkit-backdrop-filter: hue-rotate(-35deg) saturate(3.2) brightness(1.08); }
.css .band.t1 { backdrop-filter: blur(2px) hue-rotate(150deg) saturate(2.4); -webkit-backdrop-filter: blur(2px) hue-rotate(150deg) saturate(2.4); }
.css .band.t2 { backdrop-filter: blur(.6px) sepia(.7) hue-rotate(160deg) saturate(2.6) brightness(1.1); -webkit-backdrop-filter: blur(.6px) sepia(.7) hue-rotate(160deg) saturate(2.6) brightness(1.1); }
.css .blk { backdrop-filter: blur(3px) hue-rotate(80deg) saturate(3); -webkit-backdrop-filter: blur(3px) hue-rotate(80deg) saturate(3); }
.css .track { backdrop-filter: blur(.8px) brightness(1.2) contrast(1.15) saturate(1.4); -webkit-backdrop-filter: blur(.8px) brightness(1.2) contrast(1.15) saturate(1.4); }
.css .track > div { display: none; }
`;

let running: Promise<void> | null = null;
let runs = 0;

interface Scene {
  end(): void;
}

/** Resolves once no possession is running (or waiting for its tab to be shown). */
export function possessionDone(): Promise<void> {
  return running ?? Promise.resolve();
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

export function possess(message: string, durationMs: number): Promise<void> {
  // One at a time, claimed before waiting, so two arriving while hidden cannot both play.
  if (running) return Promise.resolve();
  const run = (async () => {
    try {
      if (!(await whenVisible(600))) return;
      const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 1100;
      let scene: Scene | null = null;
      try {
        // The same message plays the same way on a tab; a repeat varies.
        const seed = hash(message) + 0x9e3779b9 * runs++;
        scene = matchMedia('(prefers-reduced-motion: reduce)').matches ? calm(message, duration, seed) : glitch(message, duration, seed);
      } catch (err) {
        console.warn('[haunted-tabs] possession', err);
      }
      await new Promise((r) => setTimeout(r, duration));
      scene?.end();
    } finally {
      running = null;
    }
  })();
  running = run;
  return run;
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

function mountHost(css: string): { host: HTMLElement; wrap: HTMLDivElement; root: ShadowRoot } {
  const host = document.createElement('div');
  host.setAttribute(OUR_ATTR, 'glitch');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = css;
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  root.append(style, wrap);
  return { host, wrap, root };
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

/** A letter (grapheme) of a Latin-like word, or a whole word of a script that must stay joined. */
interface Unit {
  el: HTMLSpanElement;
  /** Reveal order, 0..1. */
  at: number;
  out: number;
  whole: boolean;
  shown: boolean;
  corrupt: string;
  shadow: string;
  transform: string;
}

function graphemes(word: string): string[] {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (!Segmenter) return Array.from(word);
  return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(word), (s) => s.segment);
}

/**
 * The message as words. Latin-like words are split into graphemes that can
 * jitter and corrupt; words in joining or reordering scripts stay whole and are
 * revealed as a unit. Words wrap at spaces, and a word too long for the screen
 * wraps inside itself, so nothing ever runs off the edge.
 */
function buildMessage(parent: HTMLElement, text: string, rand: () => number): { msg: HTMLDivElement; units: Unit[]; words: HTMLElement[] } {
  const stage = div('stage', parent);
  const msg = div('msg', stage);
  msg.dir = 'auto';
  const words = text.trim().split(/\s+/).filter(Boolean);
  const shaped = SHAPED.test(text);
  const pieces = words.map((w) => (shaped ? [w] : graphemes(w)));
  const count = pieces.reduce((n, p) => n + p.length, 0);
  const units: Unit[] = [];
  const wordEls: HTMLElement[] = [];
  let i = 0;
  pieces.forEach((parts, wi) => {
    if (wi > 0) msg.appendChild(document.createTextNode(' '));
    const w = document.createElement('span');
    w.className = shaped ? 'wd h' : 'w';
    if (shaped) w.textContent = parts[0];
    for (const part of shaped ? [] : parts) {
      const g = document.createElement('span');
      g.className = 'g h';
      g.textContent = part;
      w.appendChild(g);
    }
    const els = shaped ? [w] : (Array.from(w.children) as HTMLSpanElement[]);
    for (const el of els) {
      units.push({ el, at: count > 1 ? i / (count - 1) : 0, out: rand(), whole: shaped, shown: false, corrupt: '', shadow: '', transform: '' });
      i++;
    }
    msg.appendChild(w);
    wordEls.push(w);
  });
  return { msg, units, words: wordEls };
}

/**
 * The largest size, found against the real layout, at which no word has to
 * break inside itself and the block stays a comfortable height. Short lines are
 * kept on one line where they can be.
 */
function fitMessage(msg: HTMLDivElement, words: HTMLElement[], length: number): void {
  const vw = innerWidth;
  const vh = innerHeight;
  const narrow = vw < 640;
  const maxH = vh * (narrow ? 0.5 : 0.4);
  const avail = Math.min(vw * 0.88, 1180);
  const perLine = Math.min(length, narrow ? 9 : 16);
  const fits = (size: number) => {
    msg.style.fontSize = `${size.toFixed(1)}px`;
    if (msg.offsetHeight > maxH) return false;
    return words.every((w) => w.getClientRects().length <= 1 && w.offsetHeight < size * 1.7);
  };
  let lo = 16;
  let hi = Math.max(lo, Math.min(116, vh * 0.15, avail / (Math.max(1, perLine) * 0.95)));
  if (fits(hi)) return;
  for (let n = 0; n < 8; n++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  fits(lo);
}

/** The face goes above the words, centred near the top third, chin clear of the text. */
function placeGhost(wrap: HTMLElement, rand: () => number, textTop: number): HTMLDivElement {
  const ghost = div('ghost', wrap);
  const vh = innerHeight;
  const top = vh * 0.04;
  const room = (textTop - vh * 0.02 - top) / APPARITION_CHIN;
  let h = Math.min(vh * 0.56, innerWidth * 0.8);
  if (room > vh * 0.22) h = Math.min(h, room);
  ghost.style.width = `${Math.round(h * 0.75)}px`;
  ghost.style.height = `${Math.round(h)}px`;
  ghost.style.top = `${Math.round(Math.max(top, Math.min(vh * 0.3 - h * 0.42, textTop - vh * 0.02 - h * APPARITION_CHIN)))}px`;
  ghost.appendChild(drawApparition(rand));
  return ghost;
}

/**
 * Can backdrop-filter take an SVG filter here? Only Chromium renders it; others
 * accept the syntax and draw nothing. userAgentData is Chromium-only but needs a
 * secure context, so plain http pages are recognised by the UA token instead,
 * and Gecko pretending to be Chrome is caught by its own CSS.
 */
function svgBackdrops(): boolean {
  const chromium = 'userAgentData' in navigator || /\bChrom(e|ium)\/\d/.test(navigator.userAgent);
  const gecko = CSS.supports('-moz-appearance', 'none');
  return chromium && !gecko && CSS.supports('backdrop-filter', 'url(#a)');
}

/** A damped spring: things with weight overshoot and settle. */
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

type Tier = 'full' | 'lite' | 'css';

function glitch(message: string, duration: number, seed: number): Scene {
  const { host, wrap, root } = mountHost(BASE_CSS + GLITCH_CSS);
  let scene: Scene | null = null;
  try {
    scene = buildGlitch(host, wrap, root, message, duration, seed);
    return scene;
  } finally {
    // Whatever failed while setting up, nothing of it stays in the page.
    if (!scene) host.remove();
  }
}

function buildGlitch(host: HTMLElement, wrap: HTMLDivElement, root: ShadowRoot, message: string, duration: number, seed: number): Scene {
  const rand = seeded(seed);
  const pick = <T>(list: ArrayLike<T>): T => list[Math.floor(rand() * list.length)];
  const vw = innerWidth;
  const vh = innerHeight;
  const scale = Math.min(1.5, Math.max(0.6, vw / 1280));
  // Physics and glyph ticks run in real time up to 1.8 s; longer runs are slow motion.
  const nominal = Math.min(1.8, Math.max(1.1, duration / 1000));
  const ticks = Math.round(33 * nominal);
  let tier: Tier = svgBackdrops() ? 'full' : 'css';
  const svg = tier === 'full';
  if (!svg) wrap.classList.add('css');
  const filters: SVGElement[] = [];

  // Bottom to top. The page is split and darkened first; the face and the words
  // sit above that, under the slices, blocks and tracking that can tear them.
  const split = svg ? splitFilter('pg') : null;
  const splitEl = split ? div('fill', wrap) : null;
  if (split && splitEl) {
    filters.push(split.filter);
    splitEl.style.backdropFilter = 'url(#pg)';
  }
  const dim = div('fill dim tint', wrap);
  if (svg) dim.style.display = 'none';
  const { msg, units, words } = buildMessage(wrap, message, rand);
  document.documentElement.appendChild(host);
  fitMessage(msg, words, units.length);
  const box = msg.getBoundingClientRect();
  const pad = Math.max(12, vh * 0.03);
  const text = { top: box.top - pad, bottom: box.bottom + pad, left: box.left - pad, right: box.right + pad };
  const ghost = placeGhost(wrap, rand, box.top);
  wrap.insertBefore(ghost, msg.parentElement);
  // The eyes: kept clear while the face is up, so it is seen before it is torn.
  const gTop = ghost.offsetTop;
  const gH = ghost.offsetHeight;
  const eyes = { top: gTop + gH * 0.28, bottom: gTop + gH * 0.52 };

  const bands = Array.from({ length: BANDS }, (_, i) => {
    const el = div(`band t${i % 3}`, wrap);
    const h = Math.round(vh * (0.02 + rand() * rand() * 0.11));
    el.style.height = `${h}px`;
    const f = svg ? splitFilter(`b${i}`) : null;
    if (f) {
      filters.push(f.filter);
      el.style.backdropFilter = `url(#b${i})`;
    }
    const cssWidth = `${Math.round(40 + rand() * 50)}%`;
    if (!svg) el.style.width = cssWidth;
    return { el, h, y: 0, baseX: Math.round(rand() * vw * 0.55), cssWidth, f, spring: new Spring(8 + rand() * 3, 0.26), shown: false };
  });
  const blocks = Array.from({ length: BLOCKS }, (_, i) => {
    const el = div('blk', wrap);
    const f = svg ? moshFilter(`m${i}`, pick([6, 8, 8, 10])) : null;
    if (f) {
      filters.push(f.filter);
      el.style.backdropFilter = `url(#m${i})`;
    }
    return { el, f };
  });
  const track = div('track', wrap);
  if (svg) {
    // Rows of the page sheared by different amounts, the way a bad tracking band does.
    let left = 1;
    for (let i = 0; i < TRACK_SLICES; i++) {
      const el = div('', track);
      const part = i === TRACK_SLICES - 1 ? left : left * (0.2 + rand() * 0.4);
      left -= part;
      el.style.height = `${(part * 100).toFixed(2)}%`;
      filters.push(shearFilter(`t${i}`, (rand() - 0.35) * 46 * scale));
      el.style.backdropFilter = `url(#t${i})`;
    }
  }
  track.appendChild(drawSnow(rand));
  const shock = div('fill shock', wrap);
  if (svg) shock.style.display = 'none';
  const flash = div('fill flash', wrap);
  // The screen itself: scanlines and a dark vignette over everything, edges first.
  const screen = div('fill vignette scan', wrap);
  const grain = drawGrain(vw, vh, rand);
  grain.className = 'grain';
  wrap.appendChild(grain);
  const holder = filters.length ? svgEl('svg', { width: 0, height: 0, 'aria-hidden': 'true', style: 'position:absolute' }, filters) : null;
  if (holder) root.appendChild(holder);

  const written = new Map<Element, string>();
  const setAttrs = (el: Element | null | undefined, attrs: Record<string, string>) => {
    if (!el) return;
    const key = Object.values(attrs).join('|');
    if (written.get(el) === key) return;
    written.set(el, key);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  };
  const setOffset = (el: Element | null | undefined, dx: number, dy = 0) => setAttrs(el, { dx: dx.toFixed(1), dy: dy.toFixed(1) });

  const opts: KeyframeAnimationOptions = { duration, fill: 'both' };
  const visibleDuring = (spans: [number, number][]): Keyframe[] => {
    const list: Key[] = [[0, { visibility: 'hidden' }, CUT]];
    for (const [a, b] of spans) list.push([a, { visibility: 'visible' }, CUT], [b, { visibility: 'hidden' }, CUT]);
    list.push([1, { visibility: 'hidden' }]);
    return keys(list);
  };
  const anims: Animation[] = [
    dim.animate(keys(DIM_KEYS), opts),
    screen.animate(keys([[0, { opacity: 0 }, EASE_OUT], [0.1, { opacity: 1 }], [RELEASE, { opacity: 1 }, EASE_IN_OUT], [0.95, { opacity: 0 }], [1, { opacity: 0 }]]), opts),
    // The one bright frame: a short photographic negative as it takes hold.
    flash.animate(visibleDuring([[0.035, 0.085]]), opts),
    shock.animate(visibleDuring(SHOCKS.map((s): [number, number] => [s, s + 0.025])), opts),
    track.animate(
      keys([
        [0, { transform: 'translateY(-30vh)' }],
        [0.02, { transform: 'translateY(-18vh)' }, 'cubic-bezier(.45,.05,.55,.95)'],
        [0.34, { transform: 'translateY(112vh)' }],
        [1, { transform: 'translateY(112vh)' }],
      ]),
      opts,
    ),
    // A face in the negative, for one frame; later it surfaces once, drifts closer, and sinks back.
    ghost.animate(
      keys([
        [0, { opacity: 0, transform: 'translateX(-50%) scale(.95)' }, CUT],
        [0.035, { opacity: 0.55, transform: 'translateX(-50%) scale(1.04)' }, CUT],
        [0.085, { opacity: 0, transform: 'translateX(-50%) scale(.95)' }],
        [0.29, { opacity: 0, transform: 'translateX(-50%) scale(.95)' }, EASE_OUT],
        [0.33, { opacity: 0.45, transform: 'translateX(-50%) scale(.965)' }, CUT],
        [0.345, { opacity: 0.32, transform: 'translateX(-49.4%) scale(.97)' }, CUT],
        [0.36, { opacity: 0.6, transform: 'translateX(-50%) scale(.975)' }],
        [0.46, { opacity: 0.5, transform: 'translateX(-50%) translateY(-.5%) scale(1.01)' }, EASE_IN],
        [0.58, { opacity: 0, transform: 'translateX(-50%) translateY(-1%) scale(1.03)' }],
        [1, { opacity: 0, transform: 'translateX(-50%) translateY(-1%) scale(1.03)' }],
      ]),
      opts,
    ),
    // The words' dark pool fades in with the dark; at the end, signal lost: they collapse into a line.
    msg.animate(
      keys([
        [0, { transform: 'none', opacity: 0 }, EASE_OUT],
        [0.07, { transform: 'none', opacity: 1 }],
        [0.81, { transform: 'none', opacity: 1 }, 'cubic-bezier(.55,0,.85,.35)'],
        [0.87, { transform: 'scale(1.35, .012)', opacity: 1 }, CUT],
        [GONE, { transform: 'scale(1.35, .012)', opacity: 0 }],
        [1, { transform: 'scale(1.35, .012)', opacity: 0 }],
      ]),
      opts,
    ),
  ];
  // Film grain, jittered about 24 times a second. Its average brightness never changes.
  const grainKeys: Key[] = [];
  const grainSteps = Math.round(24 * nominal);
  for (let i = 0; i <= grainSteps; i++) {
    const t = i / grainSteps;
    const op = 0.55 * smooth(0.02, 0.1, t) * (1 - smooth(0.84, 0.96, t));
    grainKeys.push([t, { opacity: op, transform: `translate(${((rand() - 0.5) * 4).toFixed(2)}%, ${((rand() - 0.5) * 4).toFixed(2)}%)` }, CUT]);
  }
  anims.push(grain.animate(keys(grainKeys), opts));

  // --- Where slices and blocks may go. While the words hold, they stay clear of them.
  let faceUp = false;
  const clear = (y: number, h: number, zone: { top: number; bottom: number }) => y + h < zone.top || y > zone.bottom;
  const rowsFree = (y: number, h: number) => clear(y, h, text) && (!faceUp || clear(y, h, eyes));
  const boxFree = (x: number, y: number, w: number, h: number) => rowsFree(y, h) || x + w < text.left || x > text.right;
  const placeBand = (band: (typeof bands)[number], avoid: boolean) => {
    let y = 0;
    for (let n = 0; n < 12; n++) {
      // Bands gather around the middle of the screen, where the eye is.
      const centre = vh * (0.5 + (rand() - 0.5) * (rand() < 0.6 ? 0.55 : 1.1));
      y = Math.round(Math.min(vh - band.h, Math.max(0, centre - band.h / 2)));
      if (!avoid || rowsFree(y, band.h)) break;
      y = Math.min(vh - band.h, text.bottom + rand() * Math.max(0, vh - text.bottom - band.h));
    }
    band.y = Math.round(y);
  };
  const tearThrough = (band: (typeof bands)[number]) => {
    band.y = Math.round((box.top + box.bottom) / 2 - band.h / 2 + (rand() - 0.5) * box.height * 0.4);
  };
  bands.forEach((b) => placeBand(b, false));
  const thinnest = bands.reduce((a, b) => (b.h < a.h ? b : a));
  thinnest.h = Math.min(thinnest.h, Math.round(vh * 0.022));
  thinnest.el.style.height = `${thinnest.h}px`;

  // --- Quality: judged on a rolling median after a short warm-up, so it can still drop later.
  const gaps: number[] = [];
  let lastNow = 0;
  let frames = 0;
  const goLite = () => {
    tier = 'lite';
    wrap.classList.add('css');
    if (splitEl) splitEl.style.display = 'none';
    dim.style.display = '';
    shock.style.display = '';
    for (const b of bands) {
      b.el.style.backdropFilter = '';
      b.el.style.width = b.cssWidth;
    }
    for (const b of blocks) b.el.style.backdropFilter = '';
    holder?.remove();
  };
  const judge = (now: number) => {
    frames++;
    if (lastNow && frames > 2) gaps.push(now - lastNow);
    lastNow = now;
    if (gaps.length > 6) gaps.shift();
    const n = gaps.length;
    if (n < 2) return;
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[n >> 1];
    if ((n >= 3 && median > SLOW_FRAME_MS) || sorted[0] > SLOW_FRAME_MS * 3) goLite();
  };

  // --- Per frame: filter offsets, springs, blocks and glyphs.
  const gx = new Spring(7, 0.4);
  const gy = new Spring(7, 0.4);
  let lastU = 0;
  let hitIndex = 0;
  let lastHit = -1;
  let tick = -1;
  let moshTick = -1;
  let raf = 0;
  const clock = anims[0];

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    if (tier === 'full') judge(now);
    const u = clamp01(Number(clock.currentTime ?? 0) / duration);
    const dt = Math.max(0, (u - lastU) * nominal);
    const tau = u * nominal;
    const crossed = (at: number) => lastU < at && u >= at;
    const holding = u >= HOLD_START && u < HOLD_END;
    faceUp = u >= 0.3 && u < 0.5;
    if (crossed(HOLD_START) || crossed(0.3)) for (const b of bands) if (!rowsFree(b.y, b.h)) placeBand(b, true);
    lastU = u;
    const env = smooth(0, 0.05, u) * (1 - smooth(0.78, 0.92, u));
    const still = u >= SETTLED;

    // Hits: the page is struck, slices are thrown and swing back with weight.
    let tore = false;
    while (hitIndex < HITS.length && u >= HITS[hitIndex]) {
      const at = HITS[hitIndex];
      lastHit = at;
      const strength = hitIndex === 0 ? 1.3 : 0.6 + rand() * 0.5;
      const inHold = at >= HOLD_START && at < HOLD_END;
      for (const band of bands) {
        const thrown = rand() < (hitIndex === 0 ? 0.85 : 0.5);
        band.spring.target = thrown ? (rand() < 0.5 ? -1 : 1) * vw * 0.05 * strength * (0.35 + rand() * 0.65) : 0;
        if (rand() < 0.5 || (inHold && !rowsFree(band.y, band.h))) placeBand(band, inHold);
      }
      if (at === TEAR_HIT) {
        // The one tear allowed through the words: a thin slice, thrown once.
        tearThrough(thinnest);
        thinnest.spring.target = (rand() < 0.5 ? -1 : 1) * vw * 0.03;
        tore = true;
      }
      gx.v += (rand() - 0.5) * 360 * scale * strength;
      hitIndex++;
    }
    const slam = u >= 0.02 && u < 0.09;
    gx.target = slam ? 12 * scale : 0;
    gy.target = slam ? -16 * scale : 0;
    if (u >= RELEASE) for (const band of bands) band.spring.target = 0;
    if (holding && u > TEAR_HIT + 0.04 && !rowsFree(thinnest.y, thinnest.h)) {
      thinnest.spring.target = 0;
      if (Math.abs(thinnest.spring.x) < 0.5) placeBand(thinnest, true);
    }
    if (crossed(0.84)) gx.v += 240 * scale;
    const settling = u > 0.94;
    gx.damping = gy.damping = settling ? 1.2 : 0.4;
    gx.step(dt);
    gy.step(dt);

    // The whole page: displaced, darkened, red pulled off cyan.
    if (split && tier === 'full') {
      const sinceHit = lastHit < 0 ? 9 : tau - lastHit * nominal;
      const kick = 11 * Math.exp(-sinceHit / 0.05);
      const s = still ? 0 : env * (3.5 + 2 * Math.sin(tau * 19) + 1.2 * Math.sin(tau * 41 + 1) + kick) * scale;
      const sy = s * 0.2 * Math.sin(tau * 13);
      const x = still ? 0 : gx.x;
      const y = still ? 0 : gy.x;
      setOffset(split.r, x - s, y + sy);
      setOffset(split.c, x + s, y - sy);
      const d = Math.round(darkness(u) * 200) / 200;
      setAttrs(split.mr, { values: channelMatrix('r', d) });
      setAttrs(split.mc, { values: channelMatrix('gb', d) });
    }

    for (const band of bands) {
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
      if (!visible) continue;
      if (tier === 'full' && band.f) {
        setOffset(band.f.r, x - fringe);
        setOffset(band.f.c, x + fringe);
        band.el.style.transform = `translateY(${band.y}px)`;
      } else {
        band.el.style.transform = `translate(${(band.baseX + x * 3).toFixed(1)}px, ${band.y}px)`;
      }
    }

    // Datamosh bursts: blocks of the page crushed and dragged, held a few frames each.
    const burst = MOSH_BURSTS.find(([a, b]) => u >= a && u < b);
    const mt = burst ? Math.floor(u / 0.035) : -1;
    if (mt !== moshTick) {
      moshTick = mt;
      for (const { el, f } of blocks) {
        if (!burst || still || rand() < 0.3) {
          el.style.visibility = 'hidden';
          continue;
        }
        // Snapped to a 16 px grid, like the macroblocks of real video.
        const q = (n: number) => Math.max(16, Math.round(n / 16) * 16);
        const w = q(vw * (0.04 + rand() * rand() * 0.22));
        const h = q(vh * (0.02 + rand() * rand() * 0.1));
        let x = 0;
        let y = 0;
        for (let n = 0; n < 8; n++) {
          x = q(rand() * (vw - w));
          y = q(vh * (0.15 + rand() * 0.7) - h / 2);
          if (!holding || boxFree(x, y, w, h)) break;
        }
        if (holding && !boxFree(x, y, w, h)) {
          el.style.visibility = 'hidden';
          continue;
        }
        // Three blocks tall, showing only the middle one, so it can be filled
        // with page from above or below it: a misplaced macroblock.
        el.style.width = `${w}px`;
        el.style.height = `${h * 3}px`;
        el.style.clipPath = `inset(${h}px 0)`;
        el.style.transform = `translate(${x}px, ${y - h}px)`;
        el.style.visibility = 'visible';
        if (f && tier === 'full') setOffset(f.o, Math.round((rand() - 0.5) * w * 0.4), (rand() < 0.5 ? -1 : 1) * Math.round(h * (0.5 + rand() * 0.5)));
      }
    }

    // Glyphs: they type themselves in through noise, hold, and corrupt as it lets go.
    const t = Math.floor(u * ticks);
    if (t !== tick || tore) {
      tick = t;
      const twitch = tore ? new Set([pick(units), pick(units)]) : null;
      for (const unit of units) updateUnit(unit, u, !!twitch?.has(unit), rand, pick);
    }
  };
  raf = requestAnimationFrame(frame);

  return {
    end() {
      cancelAnimationFrame(raf);
      anims.forEach((a) => a.cancel());
      host.remove();
    },
  };
}

function updateUnit(g: Unit, u: number, twitch: boolean, rand: () => number, pick: (s: string) => string): void {
  const at = REVEAL_START + g.at * REVEAL_SPREAD;
  const outAt = HOLD_END + g.out * 0.03;
  let shown = true;
  let corrupt = '';
  let jx = 0;
  let jy = 0;
  let chroma = 0;
  if (u < at || u >= GONE) {
    shown = false;
  } else if (u < at + CORRUPT_FOR) {
    // Arriving: noise first, then a near-miss letter, then the real one.
    corrupt = u < at + CORRUPT_FOR * 0.55 ? pick(NOISE_GLYPHS) : pick(NEAR_GLYPHS);
    jx = (rand() - 0.5) * 10;
    jy = (rand() - 0.5) * 5;
    chroma = 4;
  } else if (u >= outAt) {
    if (rand() < 0.5) corrupt = pick(rand() < 0.6 ? NOISE_GLYPHS : NEAR_GLYPHS);
    jx = (rand() - 0.5) * 8;
    chroma = 3;
  } else if (twitch) {
    jx = (rand() - 0.5) * 12;
    chroma = 4;
  } else if (u < HOLD_START) {
    // Still settling in: a faint tremor.
    jx = (rand() - 0.5) * 1.4;
    jy = (rand() - 0.5) * 1;
  }
  if (g.whole) {
    // Joined scripts: revealed and shaken as a word, never broken into noise.
    corrupt = '';
    jx = jy = 0;
  }
  if (shown !== g.shown) {
    g.el.classList.toggle('h', !shown);
    g.shown = shown;
  }
  if (!shown) return;
  if (corrupt !== g.corrupt) {
    if (corrupt) g.el.setAttribute('data-c', corrupt);
    else g.el.removeAttribute('data-c');
    g.corrupt = corrupt;
  }
  const transform = jx || jy ? `translate(${jx.toFixed(1)}px, ${jy.toFixed(1)}px)` : '';
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
  try {
    const dim = div('fill dim tint', wrap);
    const vignette = div('fill vignette', wrap);
    const { msg, units, words } = buildMessage(wrap, message, rand);
    for (const g of units) g.el.classList.remove('h');
    document.documentElement.appendChild(host);
    fitMessage(msg, words, units.length);
    const ghost = placeGhost(wrap, rand, msg.getBoundingClientRect().top);
    wrap.insertBefore(ghost, msg.parentElement);

    const opts: KeyframeAnimationOptions = { duration, fill: 'both' };
    const fade = (peak: number, from: number, to: number) =>
      keys([[0, { opacity: 0 }], [from, { opacity: 0 }, EASE_IN_OUT], [from + 0.28, { opacity: peak }], [to - 0.26, { opacity: peak }, EASE_IN_OUT], [to, { opacity: 0 }], [1, { opacity: 0 }]]);
    const anims = [
      dim.animate(fade(1, 0, 1), opts),
      vignette.animate(fade(1, 0, 1), opts),
      ghost.animate(fade(0.16, 0.08, 0.92), opts),
      msg.animate(fade(1, 0.06, 0.94), opts),
    ];
    return {
      end() {
        anims.forEach((a) => a.cancel());
        host.remove();
      },
    };
  } catch (err) {
    host.remove();
    throw err;
  }
}
