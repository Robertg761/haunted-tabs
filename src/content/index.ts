// Runs inside a real page, injected on demand by the background worker.
// It only paints over the tab: it swaps the title and favicon, and can play a
// short glitch overlay. Every change is undone by `restore()`.
import type { PageCommand, PageEvent } from '../shared/types';
import { ext } from '../shared/ext';
import { Cobwebs } from './cobwebs';

declare global {
  interface Window {
    __hauntedTabs?: boolean;
  }
}

interface StashedIcon {
  el: Element;
  parent: Node;
  next: Node | null;
}

const OUR_ATTR = 'data-haunted-tabs';

let haunted = false;
let realTitle = '';
let ghostTitle = '';
let ourIcon: HTMLLinkElement | null = null;
let stashed: StashedIcon[] = [];
let observer: MutationObserver | null = null;
let titleEl: HTMLTitleElement | null = null;
let flickerTimer: number | undefined;
let lastReportedTitle = '';
let dirtyByInput = false;
let cobwebs: Cobwebs | null = null;

function isIconLink(node: Node): node is HTMLLinkElement {
  return (
    node instanceof HTMLLinkElement &&
    !node.hasAttribute(OUR_ATTR) &&
    /(^|\s)icon(\s|$)/i.test(node.rel)
  );
}

function stashIcon(el: Element): void {
  if (!el.parentNode) return;
  stashed.push({ el, parent: el.parentNode, next: el.nextSibling });
  el.remove();
}

function setTitle(text: string): void {
  if (document.title !== text) document.title = text;
}

function reportRealTitle(title: string): void {
  if (title === lastReportedTitle) return;
  lastReportedTitle = title;
  const event: PageEvent = { type: 'haunt:realTitle', title };
  ext.runtime.sendMessage(event).catch(() => {});
}

/** Keep the haunting in place when the page itself rewrites its title or favicon. */
function watchHead(): void {
  if (!observer) {
    observer = new MutationObserver((records) => {
      if (!haunted) return;
      for (const r of records) {
        for (const node of Array.from(r.addedNodes)) {
          if (isIconLink(node)) stashIcon(node);
        }
      }
      if (ourIcon && !ourIcon.isConnected) (document.head ?? document.documentElement).appendChild(ourIcon);
      watchTitleElement();
      const current = document.title;
      if (flickerTimer === undefined && current !== ghostTitle) {
        realTitle = current;
        reportRealTitle(current);
        setTitle(ghostTitle);
      }
    });
    observer.observe(document.head ?? document.documentElement, { childList: true, subtree: true, characterData: true });
  }
  watchTitleElement();
}

/** The <title> is not always inside <head>, so watch the element itself too. */
function watchTitleElement(): void {
  const el = document.querySelector('title');
  if (!observer || !el || el === titleEl) return;
  titleEl = el;
  observer.observe(el, { childList: true, subtree: true, characterData: true });
}

function apply(title: string, icon: string): void {
  if (!haunted) {
    haunted = true;
    realTitle = document.title;
    lastReportedTitle = realTitle;
    document.querySelectorAll('link[rel]').forEach((el) => {
      if (isIconLink(el)) stashIcon(el);
    });
  }
  ghostTitle = title;
  setTitle(title);
  // A fresh element each time: Chrome reliably picks up a newly inserted icon link.
  const link = document.createElement('link');
  link.rel = 'icon';
  link.href = icon;
  link.setAttribute(OUR_ATTR, '');
  ourIcon?.remove();
  ourIcon = link;
  (document.head ?? document.documentElement).appendChild(link);
  watchHead();
}

function restore(): void {
  if (!haunted) return;
  haunted = false;
  stopFlicker();
  observer?.disconnect();
  observer = null;
  titleEl = null;
  ourIcon?.remove();
  ourIcon = null;
  for (const { el, parent, next } of stashed) {
    if (parent.isConnected) parent.insertBefore(el, next && next.parentNode === parent ? next : null);
    else (document.head ?? document.documentElement).appendChild(el);
  }
  document.querySelectorAll(`link[${OUR_ATTR}="restored"]`).forEach((el) => el.remove());
  if (stashed.length === 0) {
    // The page relied on the default /favicon.ico. Point back at it so the
    // browser drops our ghost instead of keeping the last icon it saw.
    const fallback = document.createElement('link');
    fallback.rel = 'icon';
    fallback.href = new URL('/favicon.ico', location.href).href;
    fallback.setAttribute(OUR_ATTR, 'restored');
    (document.head ?? document.documentElement).appendChild(fallback);
  }
  stashed = [];
  setTitle(realTitle);
}

function stopFlicker(): void {
  if (flickerTimer !== undefined) {
    clearInterval(flickerTimer);
    flickerTimer = undefined;
  }
}

function flicker(titles: string[], durationMs: number): void {
  if (!haunted || titles.length === 0) return;
  stopFlicker();
  let i = 0;
  const end = Date.now() + durationMs;
  flickerTimer = window.setInterval(() => {
    if (Date.now() >= end || !haunted) {
      stopFlicker();
      if (haunted) setTitle(ghostTitle);
      return;
    }
    // Every other frame snaps back to the ghost, so it reads as a flicker.
    setTitle(i % 2 ? ghostTitle : titles[(i >> 1) % titles.length]);
    i++;
  }, 260);
}

function hasUnsavedInput(): boolean {
  if (dirtyByInput) return true;
  const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    'input, textarea, select',
  );
  for (const f of Array.from(fields)) {
    if (f instanceof HTMLSelectElement) {
      if (Array.from(f.options).some((o) => o.selected !== o.defaultSelected)) return true;
    } else if (f instanceof HTMLInputElement && (f.type === 'checkbox' || f.type === 'radio')) {
      if (f.checked !== f.defaultChecked) return true;
    } else if (f instanceof HTMLInputElement && ['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(f.type)) {
      continue;
    } else if (f.value !== f.defaultValue) {
      return true;
    }
  }
  const active = document.activeElement as HTMLElement | null;
  return !!active && active.isContentEditable;
}

// ---------------------------------------------------------------------------
// Possession: a short glitch that takes over the real page for about a second.
// Kept photosensitive-safe: at most one bright flash, no strobing, and a calm
// fade instead when the user prefers reduced motion.

const GLITCH_CSS = `
:host { all: initial; }
.wrap { position: fixed; inset: 0; pointer-events: none; overflow: hidden; z-index: 2147483647; }
.tint { position: absolute; inset: 0; }
.scan { position: absolute; inset: 0; background: repeating-linear-gradient(0deg, rgba(0,0,0,.28) 0 1px, transparent 1px 3px); }
.vignette { position: absolute; inset: 0; background: radial-gradient(ellipse at center, transparent 35%, rgba(20,0,10,.85) 100%); }
.slice { position: absolute; left: -5%; width: 110%; backdrop-filter: hue-rotate(140deg) saturate(3) contrast(1.4); -webkit-backdrop-filter: hue-rotate(140deg) saturate(3) contrast(1.4); }
.msg { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(90vw, 900px); text-align: center;
  font: 700 clamp(28px, 6vw, 84px)/1.05 "Courier New", ui-monospace, monospace; letter-spacing: .08em; color: #f5f0ff;
  text-shadow: -3px 0 rgba(255,0,60,.9), 3px 0 rgba(0,255,230,.8), 0 0 24px rgba(160,0,40,.9); white-space: pre-wrap; overflow-wrap: anywhere; }
.ghost { position: absolute; left: 50%; top: calc(50% - clamp(60px, 11vw, 150px)); transform: translate(-50%, -50%); font-size: clamp(40px, 8vw, 110px); filter: drop-shadow(0 0 18px rgba(255,255,255,.6)); }
`;

let glitching = false;

/** Hard cuts between keyframes. Easing in the options would apply to the whole run. */
function stepped(frames: Keyframe[]): Keyframe[] {
  return frames.map((f) => ({ ...f, easing: 'steps(1, end)' }));
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

async function glitch(message: string, durationMs: number): Promise<void> {
  if (glitching || !(await whenVisible(600))) return;
  glitching = true;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const host = document.createElement('div');
  host.setAttribute(OUR_ATTR, 'glitch');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = GLITCH_CSS;
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  const vignette = document.createElement('div');
  vignette.className = 'vignette';
  const ghost = document.createElement('div');
  ghost.className = 'ghost';
  ghost.textContent = '👻';
  const msg = document.createElement('div');
  msg.className = 'msg';
  msg.textContent = message;
  wrap.append(vignette);
  root.append(style, wrap);

  const anims: Animation[] = [];
  const cleanups: (() => void)[] = [];
  const opts = (extra: KeyframeAnimationOptions = {}): KeyframeAnimationOptions => ({ duration: durationMs, easing: 'linear', fill: 'forwards', ...extra });

  if (reduced) {
    wrap.append(ghost, msg);
    anims.push(wrap.animate([{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }], opts({ easing: 'ease-in-out' })));
  } else {
    // The real page underneath rots: colours shift and it flashes inverted once.
    const tint = document.createElement('div');
    tint.className = 'tint';
    const scan = document.createElement('div');
    scan.className = 'scan';
    wrap.prepend(tint);
    wrap.append(scan);
    anims.push(
      tint.animate(
        stepped([
          { backdropFilter: 'none' },
          { backdropFilter: 'hue-rotate(90deg) saturate(2.5) contrast(1.3)', offset: 0.1 },
          { backdropFilter: 'invert(1) hue-rotate(180deg)', offset: 0.3 },
          { backdropFilter: 'grayscale(1) contrast(1.6) brightness(0.7)', offset: 0.38 },
          { backdropFilter: 'sepia(1) hue-rotate(-50deg) saturate(3)', offset: 0.65 },
          { backdropFilter: 'none' },
        ]),
        opts(),
      ),
    );
    for (let i = 0; i < 6; i++) {
      const slice = document.createElement('div');
      slice.className = 'slice';
      slice.style.top = `${Math.random() * 92}%`;
      slice.style.height = `${2 + Math.random() * 9}%`;
      wrap.append(slice);
      const dx = (Math.random() < 0.5 ? -1 : 1) * (10 + Math.random() * 50);
      // Each slice jumps a few times, never faster than ~3 changes a second.
      anims.push(
        slice.animate(
          stepped([
            { transform: 'translateX(0)', opacity: 0 },
            { transform: `translateX(${dx}px)`, opacity: 1, offset: 0.05 + i * 0.04 },
            { transform: `translateX(${-dx * 0.6}px)`, opacity: 1, offset: 0.4 + i * 0.03 },
            { transform: `translateX(${dx * 0.3}px)`, opacity: 0.8, offset: 0.75 },
            { transform: 'translateX(0)', opacity: 0 },
          ]),
          opts(),
        ),
      );
    }
    wrap.append(ghost, msg);
    anims.push(
      msg.animate(
        stepped([
          { opacity: 0, transform: 'translate(-50%, -50%) skewX(0deg)' },
          { opacity: 1, transform: 'translate(-52%, -50%) skewX(-12deg)', offset: 0.12 },
          { opacity: 1, transform: 'translate(-48%, -51%) skewX(8deg)', offset: 0.45 },
          { opacity: 1, transform: 'translate(-50%, -50%) skewX(0deg)', offset: 0.8 },
          { opacity: 0, transform: 'translate(-50%, -50%) skewX(0deg)' },
        ]),
        opts(),
      ),
      ghost.animate([{ opacity: 0 }, { opacity: 0.95, offset: 0.2 }, { opacity: 0.95, offset: 0.7 }, { opacity: 0 }], opts()),
      // Fade the layers one by one: animating the wrapper's opacity would make it a
      // backdrop root and stop the backdrop filters from seeing the page.
      ...[vignette, scan].map((layer) => layer.animate([{ opacity: 1 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], opts())),
    );
    // And it shudders. Only the body moves, so our overlay stays put. Sideways
    // overflow is clipped for the moment so no scrollbar flashes up.
    if (document.body) {
      const html = document.documentElement;
      const overflowX = html.style.overflowX;
      html.style.overflowX = 'clip';
      cleanups.push(() => (html.style.overflowX = overflowX));
      anims.push(
        document.body.animate(
          stepped([
            { transform: 'none' },
            { transform: 'translateX(-8px) skewX(2deg)', offset: 0.1 },
            { transform: 'translateX(6px)', offset: 0.3 },
            { transform: 'translateX(-3px) skewX(-1deg)', offset: 0.38 },
            { transform: 'translateY(2px)', offset: 0.65 },
            { transform: 'none' },
          ]),
          opts({ fill: 'none' }),
        ),
      );
    }
  }

  document.documentElement.appendChild(host);
  return new Promise((resolve) => {
    setTimeout(() => {
      anims.forEach((a) => a.cancel());
      cleanups.forEach((fn) => fn());
      host.remove();
      glitching = false;
      resolve();
    }, durationMs);
  });
}

function trackInput(): void {
  document.addEventListener(
    'input',
    (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement)) {
        dirtyByInput = true;
      }
    },
    true,
  );
  document.addEventListener('submit', () => (dirtyByInput = false), true);
}

// Guard against double injection: the background re-injects whenever it is unsure.
if (!window.__hauntedTabs) {
  window.__hauntedTabs = true;
  trackInput();
  ext.runtime.onMessage.addListener((msg: PageCommand, _sender, sendResponse) => {
    switch (msg.type) {
      case 'haunt:ping':
        sendResponse({ ok: true, haunted });
        return;
      case 'haunt:apply':
        apply(msg.title, msg.icon);
        sendResponse({ ok: true, realTitle });
        return;
      case 'haunt:restore':
        restore();
        sendResponse({ ok: true });
        return;
      case 'haunt:glitch':
        sendResponse({ ok: true });
        glitch(msg.message, msg.durationMs).then(() => {
          if (msg.thenRestore) restore();
        });
        return;
      case 'haunt:flicker':
        flicker(msg.titles, msg.durationMs);
        sendResponse({ ok: true });
        return;
      case 'haunt:dirty':
        sendResponse({ ok: true, dirty: hasUnsavedInput() });
        return;
      case 'haunt:cobwebs':
        cobwebs ??= new Cobwebs();
        cobwebs.add(msg.webs);
        if (msg.growAfterMs > 0) cobwebs.arm(msg.growAfterMs);
        sendResponse({ ok: true, webs: cobwebs.count });
        return;
      case 'haunt:sweep':
        cobwebs?.sweep();
        sendResponse({ ok: true });
        return;
    }
  });
}
