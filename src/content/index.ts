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

/** What a running copy of this script leaves on the window, so a second injection can find it. */
interface Instance {
  /** False once the extension that injected this copy was reloaded or updated. */
  alive(): boolean;
}

declare global {
  interface Window {
    __hauntedTabs?: Instance | boolean;
  }
}

interface StashedIcon {
  el: Element;
  parent: Node;
  next: Node | null;
}

const OUR_ATTR = 'data-haunted-tabs';
/** Fired by a fresh copy as it starts, so a copy orphaned by an extension reload lets go first. */
const TAKEOVER = 'haunted-tabs:takeover';

let haunted = false;
let realTitle = '';
let ghostTitle = '';
let ghostIcon = '';
let ourIcon: HTMLLinkElement | null = null;
/** The icon a page's favicon script set on our link, put back with the rest on restore. */
let adopted: HTMLLinkElement | null = null;
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

/** document.title strips and collapses whitespace, so compare titles the way it reads them. */
const squash = (t: string): string => t.replace(/[\t\n\f\r ]+/g, ' ').trim();
const sameTitle = (a: string, b: string): boolean => a === b || squash(a) === squash(b);

function setTitle(text: string): void {
  if (!sameTitle(document.title, text)) document.title = text;
}

/** An orphaned copy (the extension was reloaded or updated) can no longer be told to restore. */
function alive(): boolean {
  try {
    return !!ext.runtime?.id;
  } catch {
    return false;
  }
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
      if (!alive()) return retire();
      for (const r of records) {
        for (const node of Array.from(r.addedNodes)) {
          if (isIconLink(node)) stashIcon(node);
        }
      }
      if (ourIcon && !ourIcon.isConnected) (document.head ?? document.documentElement).appendChild(ourIcon);
      if (ourIcon && (ourIcon.getAttribute('href') !== ghostIcon || ourIcon.rel !== 'icon')) adoptIcon(ourIcon);
      watchTitleElement();
      const current = document.title;
      if (flickerTimer === undefined && !sameTitle(current, ghostTitle)) {
        realTitle = current;
        reportRealTitle(current);
        setTitle(ghostTitle);
      }
    });
    observer.observe(document.head ?? document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['href', 'rel'],
    });
  }
  watchTitleElement();
}

/**
 * A favicon script (unread badges and the like) found our link, the only icon
 * left, and pointed it at its own icon. Keep what it wanted for the restore, and
 * the ghost for now.
 */
function adoptIcon(link: HTMLLinkElement): void {
  const wanted = link.cloneNode() as HTMLLinkElement;
  wanted.removeAttribute(OUR_ATTR);
  stashed = stashed.filter((s) => s.el !== adopted);
  adopted = wanted;
  stashed.push({ el: wanted, parent: link.parentNode ?? document.head ?? document.documentElement, next: null });
  link.rel = 'icon';
  link.setAttribute('href', ghostIcon);
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
    // The /favicon.ico pointer a previous restore left would compete with the ghost.
    document.querySelectorAll(`link[${OUR_ATTR}="restored"]`).forEach((el) => el.remove());
  }
  ghostTitle = title;
  ghostIcon = icon;
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
  adopted = null;
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
    if (!alive()) return retire();
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

/** Field types that hold nothing a person typed or chose. */
const NOT_INPUT = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file']);

/**
 * Is there anything a person typed or chose that would be lost? Looks in the
 * document, open shadow roots and same-origin frames (where rich editors live),
 * and counts a focused editor as in use.
 */
function hasUnsavedInput(): boolean {
  return dirtyByInput || hasEdits(document, 0) || editingNow();
}

function hasEdits(root: Document | ShadowRoot, depth: number): boolean {
  for (const f of Array.from(root.querySelectorAll('input, textarea, select'))) {
    if (changed(f)) return true;
  }
  if (depth >= 4) return false;
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const inner = el.shadowRoot ?? frameDocument(el);
    if (inner && hasEdits(inner, depth + 1)) return true;
  }
  return false;
}

/** Elements of another frame belong to another realm, so they are told apart by name, not instanceof. */
function changed(f: Element): boolean {
  if (f.localName === 'select') return selectChanged(f as HTMLSelectElement);
  if (f.localName === 'textarea') {
    const t = f as HTMLTextAreaElement;
    return t.value !== t.defaultValue;
  }
  const i = f as HTMLInputElement;
  if (i.type === 'checkbox' || i.type === 'radio') return i.checked !== i.defaultChecked;
  if (NOT_INPUT.has(i.type)) return false;
  return i.value !== i.defaultValue && i.value !== cleanDefault(i);
}

/**
 * The value an untouched field shows: its value attribute as the browser cleans
 * it up. A colour picker or a slider without one still shows a value (#000000,
 * the midpoint), and that is not something the person chose.
 */
function cleanDefault(f: HTMLInputElement): string {
  const probe = document.createElement('input');
  for (const name of ['type', 'min', 'max', 'step', 'multiple', 'value']) {
    const v = f.getAttribute(name);
    if (v !== null) probe.setAttribute(name, v);
  }
  return probe.value;
}

/** A single select with no option marked selected shows its first usable one. */
function selectChanged(s: HTMLSelectElement): boolean {
  const options = Array.from(s.options);
  if (s.multiple || s.size > 1) return options.some((o) => o.selected !== o.defaultSelected);
  let initial = -1;
  options.forEach((o, i) => {
    if (o.defaultSelected) initial = i;
  });
  if (initial === -1) initial = options.findIndex((o) => !o.disabled);
  return s.selectedIndex !== initial;
}

function frameDocument(el: Element): Document | null {
  if (el.localName !== 'iframe' && el.localName !== 'frame') return null;
  try {
    return (el as HTMLIFrameElement).contentDocument;
  } catch {
    return null;
  }
}

/** Focus resting in an editor: a contenteditable, maybe inside a shadow root or a same-origin frame. */
function editingNow(): boolean {
  let el: Element | null = document.activeElement;
  for (let i = 0; el && i < 8; i++) {
    if ((el as HTMLElement).isContentEditable) return true;
    el = el.shadowRoot?.activeElement ?? frameDocument(el)?.activeElement ?? null;
  }
  return false;
}

function onInput(e: Event): void {
  // Typing inside a shadow root reaches the document retargeted to its host; the path still has the field.
  const t = e.composedPath()[0] ?? e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.isContentEditable || t.localName === 'input' || t.localName === 'textarea' || t.localName === 'select') dirtyByInput = true;
}

function onSubmit(): void {
  dirtyByInput = false;
}

function onTakeover(): void {
  if (!alive()) retire();
}

/**
 * Let go of the page: give back the real title and icon, remove every overlay
 * and stop listening. Done by a copy the extension can no longer reach, as soon
 * as a fresh copy arrives or the page stirs it, so two copies never fight over
 * the title.
 */
function retire(): void {
  restore();
  for (const effect of [...running.values(), ...fading.values()]) effect.destroy();
  running.clear();
  fading.clear();
  cobwebs?.destroy();
  cobwebs = null;
  document.removeEventListener('input', onInput, true);
  document.removeEventListener('submit', onSubmit, true);
  document.removeEventListener(TAKEOVER, onTakeover);
}

function onMessage(msg: PageCommand, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void): void {
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
}

// One live copy per page: the background re-injects whenever it is unsure, and
// a second copy must not double the listeners. A copy left behind by an
// extension reload or update is told to let go first. It may share this window
// (Chrome) or not (Firefox), so it hears that as a DOM event.
const previous = window.__hauntedTabs;
if (!previous || (typeof previous === 'object' && !previous.alive())) {
  document.dispatchEvent(new CustomEvent(TAKEOVER));
  window.__hauntedTabs = { alive };
  document.addEventListener('input', onInput, true);
  document.addEventListener('submit', onSubmit, true);
  document.addEventListener(TAKEOVER, onTakeover);
  ext.runtime.onMessage.addListener(onMessage);
}
