// Runs inside a real page, injected on demand by the background worker.
// It only paints over the tab: it swaps the title and favicon, and can play a
// short glitch overlay. Every change is undone by `restore()`.
import type { EffectName, PageCommand, PageEvent } from '../shared/types';
import { ext } from '../shared/ext';
import { Cobwebs } from './cobwebs';
import { EFFECTS } from './effects';
import { possess, possessionDone } from './effects/possession';
import type { Effect } from './effects/types';
import { prefersReducedMotion } from './effects/overlay';

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
const running = new Map<EffectName, Effect>();
/** Effects fading out after a stop. Restarting one revives it instead of duplicating it. */
const fading = new Map<EffectName, Effect>();
/** Counts stops and sweeps, so a start still waiting on a possession can tell it was cancelled meanwhile. */
let epoch = 0;
let sweptAt = 0;
const stoppedAt = new Map<EffectName, number>();

function startEffects(names: EffectName[], stage: number, idleMs: number, seed: number): void {
  const reduced = prefersReducedMotion();
  for (const name of names) {
    // Coming back during a fade-out revives the same effect where it is, rather
    // than starting a second copy from nothing. Each effect's start() cancels its fade.
    const reviving = fading.get(name);
    fading.delete(name);
    if (reviving?.active && !running.has(name)) running.set(name, reviving);
    else reviving?.destroy();
    let effect = running.get(name);
    if (!effect || !effect.active) {
      effect = EFFECTS[name]();
      running.set(name, effect);
    }
    try {
      effect.start({ stage, idleMs, seed, reduced });
    } catch (err) {
      // One broken effect must never take the page or the other effects down.
      console.warn('[haunted-tabs]', name, err);
      effect.destroy();
      running.delete(name);
    }
  }
}

function stopEffects(names: Iterable<EffectName>): void {
  for (const name of [...names]) {
    const effect = running.get(name);
    running.delete(name);
    if (!effect) continue;
    fading.get(name)?.destroy();
    fading.set(name, effect);
    effect.stop();
  }
}

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
        possess(msg.message, msg.durationMs).then(() => {
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
      case 'haunt:cobwebs': {
        // Webs settle in once a possession has let go of the screen, unless a sweep came first.
        const asked = epoch;
        cobwebs ??= new Cobwebs();
        const web = cobwebs;
        void possessionDone().then(() => {
          if (sweptAt > asked || cobwebs !== web) return;
          web.add(msg.webs);
          if (msg.growAfterMs > 0) web.arm(msg.growAfterMs);
        });
        sendResponse({ ok: true });
        return;
      }
      case 'haunt:effects': {
        const asked = epoch;
        void possessionDone().then(() => {
          if (sweptAt > asked) return;
          startEffects(
            msg.effects.filter((name) => (stoppedAt.get(name) ?? 0) <= asked),
            msg.stage,
            msg.idleMs,
            msg.seed,
          );
        });
        sendResponse({ ok: true });
        return;
      }
      case 'haunt:stopEffects':
        epoch++;
        for (const name of msg.effects) stoppedAt.set(name, epoch);
        stopEffects(msg.effects);
        sendResponse({ ok: true });
        return;
      case 'haunt:sweep':
        sweptAt = ++epoch;
        cobwebs?.sweep();
        stopEffects(running.keys());
        sendResponse({ ok: true });
        return;
    }
  });
}
