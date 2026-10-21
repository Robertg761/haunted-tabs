import { loadGraves, onGravesChanged, saveGraves } from '../shared/storage';
import type { Grave } from '../shared/types';
import { ext } from '../shared/ext';
import { Particles } from './particles';
import { nearRidgeY, startScene } from './scene';
import { buildBlankStone, buildGrave, drawStone, traitsFor, type Traits } from './stone';
import { svgNode } from './svg';

const gravesEl = document.getElementById('graves')!;
const searchInput = document.getElementById('search') as HTMLInputElement;
const resurrectAll = document.getElementById('resurrect-all') as HTMLButtonElement;
const resurrectAllLabel = resurrectAll.querySelector('.label')!;
const summary = document.getElementById('summary')!;
const status = document.getElementById('status')!;
const emptyEl = document.getElementById('empty')!;
const noMatchEl = document.getElementById('no-match')!;
const counts = {
  all: document.getElementById('count-all')!,
  haunting: document.getElementById('count-haunting')!,
  you: document.getElementById('count-you')!,
};

const motion = matchMedia('(prefers-reduced-motion: reduce)');
const reduced = (): boolean => motion.matches;
const narrow = matchMedia('(max-width: 640px)');
/** Above this many graves the yard switches to smaller stones. */
const COMPACT_OVER = 12;

const particles = new Particles(document.querySelector<HTMLCanvasElement>('canvas.spirits')!, () => !reduced());
startScene(reduced);
setGrainTextures();

interface GraveNode {
  el: HTMLElement;
  grave: Grave;
  traits: Traits;
  /** When a resurrection was asked for, and how long its wave waits (ms). */
  summonedAt?: number;
  wave?: number;
  /** Cancels a running "filtered out" transition. */
  leaving?: Animation;
}

let graves: Grave[] = [];
let loaded = false;
let firstRender = true;
let departing = 0;
let lastQuery = '';
/** When focus was last moved by the page itself (not the user), to ignore a key still held down. */
let focusMovedAt = 0;
let ascended: string[] = [];
let announceTimer = 0;
const nodes = new Map<string, GraveNode>();
const traitsOf = new WeakMap<Element, Traits>();
const removals: HTMLElement[] = [];
const pending = new Set<string>();

const sizes = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const grave = (entry.target as HTMLElement).closest<HTMLElement>('.grave');
    const traits = grave && traitsOf.get(grave);
    if (grave && traits) drawStone(grave, traits);
  }
});

function visible(): Grave[] {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return graves;
  return graves.filter((g) => g.title.toLowerCase().includes(q) || g.url.toLowerCase().includes(q));
}

// ---------------------------------------------------------------- rendering

function createNode(g: Grave, delay: number): GraveNode {
  const traits = traitsFor(g);
  const el = buildGrave(g, traits);
  const node: GraveNode = { el, grave: g, traits };
  traitsOf.set(el, traits);
  sizes.observe(el.querySelector('.carving')!);
  // Graves rise from the ground (or, with reduced motion, simply fade in).
  el.classList.add('rising');
  el.style.setProperty('--delay', `${delay}ms`);
  const carving = el.querySelector('.carving')!;
  const risen = (): void => el.classList.remove('rising');
  carving.addEventListener('animationend', (e) => e.target === carving && risen());
  setTimeout(risen, delay + 3000);
  setTimeout(() => {
    const m = el.querySelector('.mound')?.getBoundingClientRect();
    if (m?.width) particles.dust(m.left + m.width / 2, m.top + 10, m.width * 0.45, 14, 0.6);
  }, delay + 120);
  return node;
}

/** Positions of every stone on show, for animating layout changes (FLIP). */
function snapshot(): Map<HTMLElement, DOMRect> {
  const rects = new Map<HTMLElement, DOMRect>();
  for (const child of gravesEl.children as HTMLCollectionOf<HTMLElement>) {
    if (child.hidden || child.classList.contains('leaving')) continue;
    rects.set(child, child.getBoundingClientRect());
  }
  return rects;
}

function glide(first: Map<HTMLElement, DOMRect>, appeared: HTMLElement[] = []): void {
  if (reduced()) {
    for (const el of appeared) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' });
    return;
  }
  for (const [el, before] of first) {
    if (!el.isConnected || el.hidden || el.classList.contains('leaving')) continue;
    const after = el.getBoundingClientRect();
    const dx = before.left - after.left;
    const dy = before.top - after.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.getAnimations().forEach((a) => a.id === 'glide' && a.cancel());
    const a = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
      duration: 520,
      easing: 'cubic-bezier(.22,.8,.24,1)',
    });
    a.id = 'glide';
  }
  appeared.forEach((el, i) =>
    el.animate(
      [
        { opacity: 0, transform: 'translateY(18px)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 420, delay: 120 + i * 40, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'backwards' },
    ),
  );
}

/** Take a stone out of the layout and let it fade away where it stood (search filtering). */
function filterOut(node: GraveNode, rect: DOMRect | undefined): void {
  const { el } = node;
  if (el.hidden || el.classList.contains('leaving')) return;
  if (reduced() || !rect) {
    el.hidden = true;
    return;
  }
  const host = gravesEl.getBoundingClientRect();
  el.classList.add('leaving');
  Object.assign(el.style, {
    left: `${rect.left - host.left}px`,
    top: `${rect.top - host.top}px`,
    width: `${rect.width}px`,
  });
  node.leaving = el.animate(
    [
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: 'translateY(16px) scale(.97)' },
    ],
    { duration: 280, easing: 'ease-in', fill: 'forwards' },
  );
  node.leaving.onfinish = () => {
    node.leaving?.cancel();
    node.leaving = undefined;
    resetLeaving(el);
    el.hidden = true;
  };
}

function resetLeaving(el: HTMLElement): void {
  el.classList.remove('leaving');
  el.style.left = el.style.top = el.style.width = '';
}

function render(): void {
  gravesEl.classList.toggle('compact', graves.length > COMPACT_OVER || narrow.matches);
  const shown = visible();
  const shownIds = new Set(shown.map((g) => g.id));
  const live = new Set(graves.map((g) => g.id));
  const first = snapshot();

  for (const [id, node] of nodes) {
    if (!live.has(id)) {
      nodes.delete(id);
      depart(node);
    }
  }

  const appeared: HTMLElement[] = [];
  let anchor: Element | null = null;
  let fresh = 0;
  for (const g of graves) {
    let node = nodes.get(g.id);
    if (!node) {
      const delay = firstRender ? Math.min(fresh * 110, 1400) : fresh * 90;
      fresh++;
      node = createNode(g, delay);
      nodes.set(g.id, node);
    }
    // Keep storage order, stepping around stones that are on their way out.
    let ref: Element | null = anchor ? anchor.nextElementSibling : gravesEl.firstElementChild;
    while (ref && ref !== node.el && ref.classList.contains('departing')) {
      anchor = ref;
      ref = ref.nextElementSibling;
    }
    if (ref !== node.el) gravesEl.insertBefore(node.el, ref);
    anchor = node.el;

    if (shownIds.has(g.id)) {
      if (node.leaving) {
        node.leaving.cancel();
        node.leaving = undefined;
        resetLeaving(node.el);
      } else if (node.el.hidden) {
        node.el.hidden = false;
        appeared.push(node.el);
      }
    } else {
      filterOut(node, first.get(node.el));
    }
  }

  if (!firstRender) glide(first, appeared);
  else requestAnimationFrame(() => requestAnimationFrame(anchorYard));
  firstRender = false;
  updateHeader(shown);
}

/**
 * Stand the first row of graves on the near ridge, in front of the fence, rather than
 * floating above it on tall windows. Only ever adds space, and only on load and resize.
 */
function anchorYard(): void {
  const wrap = gravesEl.parentElement!;
  const firstStone = gravesEl.querySelector<HTMLElement>('.grave:not([hidden])');
  if (!firstStone || !nearRidgeY()) return;
  const current = parseFloat(wrap.style.getPropertyValue('--anchor')) || 0;
  const ground = firstStone.getBoundingClientRect().bottom + scrollY - 40;
  const next = Math.max(0, Math.min(220, current + nearRidgeY() + 12 - ground));
  if (Math.abs(next - current) > 2) wrap.style.setProperty('--anchor', `${Math.round(next)}px`);
}
let anchorTimer = 0;
addEventListener('resize', () => {
  clearTimeout(anchorTimer);
  anchorTimer = window.setTimeout(anchorYard, 300);
});
narrow.addEventListener('change', render);

function updateHeader(shown: Grave[]): void {
  const n = graves.length;
  const q = searchInput.value.trim();
  counts.all.textContent = String(n);
  counts.haunting.textContent = String(graves.filter((g) => g.cause === 'haunting').length);
  counts.you.textContent = String(graves.filter((g) => g.cause !== 'haunting').length);
  summary.textContent = !n
    ? 'Every tab the haunting takes will lie here. Nothing is ever lost.'
    : q
      ? `${shown.length} of ${n} grave${n === 1 ? '' : 's'} answer to “${q}”.`
      : n === 1
        ? '1 forgotten tab rests here. Resurrect it to open it again.'
        : `${n} forgotten tabs rest here. Resurrect any of them to open it again.`;
  if (shown.length === 0 && document.activeElement === resurrectAll) {
    // Disabling the focused button would drop focus on the floor; hand it to the search instead.
    focusMovedAt = performance.now();
    searchInput.focus({ preventScroll: true });
  }
  resurrectAll.disabled = shown.length === 0;
  resurrectAllLabel.textContent = shown.length && shown.length !== n ? `Resurrect ${shown.length}` : 'Resurrect all';
  if (q !== lastQuery) {
    lastQuery = q;
    status.textContent = q ? `${shown.length} grave${shown.length === 1 ? '' : 's'} found` : `Showing all ${n} graves`;
  }
  updateEmpty(shown.length);
}

function updateEmpty(shownCount = visible().length): void {
  const quiet = loaded && graves.length === 0 && departing === 0 && removals.length === 0;
  if (quiet && emptyEl.hidden) {
    showEmptyScene();
  } else if (!quiet) emptyEl.hidden = true;
  noMatchEl.hidden = !(loaded && graves.length > 0 && shownCount === 0);
}

function showEmptyScene(): void {
  const plot = emptyEl.querySelector<HTMLElement>('.empty-plot')!;
  if (!plot.firstChild) {
    const blank = buildBlankStone();
    traitsOf.set(blank, { seed: 7, shape: 'round', material: 'granite', tilt: -1.6, sink: 4, width: 1, age: 0.7, candleLeft: false });
    plot.replaceChildren(blank, svgNode(SHOVEL));
    sizes.observe(blank.querySelector('.carving')!);
  }
  emptyEl.hidden = false;
}

const SHOVEL =
  '<svg class="shovel" viewBox="0 0 60 150" aria-hidden="true"><path d="M27 4h6v6h6v8H21v-8h6z" fill="none" stroke="#1a1512" stroke-width="3.5" stroke-linejoin="round"/>' +
  '<rect x="27.5" y="17" width="5" height="78" rx="2" fill="#2a2018"/><path d="M30 92c-11 0-15 6-15 16 0 14 6 26 15 34 9-8 15-20 15-34 0-10-4-16-15-16z" fill="#3a3f47"/>' +
  '<path d="M30 96c-8 1-11 5-11 12" fill="none" stroke="#8a919c" stroke-opacity=".5" stroke-width="1.5" stroke-linecap="round"/></svg>';

// ---------------------------------------------------------------- leaving the yard

function depart(node: GraveNode): void {
  const { el } = node;
  pending.delete(node.grave.id);
  const hadFocus = el.contains(document.activeElement);
  el.classList.remove('stone');
  el.classList.add('departing');
  el.inert = true;
  sizes.unobserve(el.querySelector('.carving')!);
  if (hadFocus) moveFocusFrom(el);
  if (el.hidden || el.classList.contains('leaving')) {
    el.remove();
    return;
  }
  const fate = el.dataset.fate === 'resurrect' ? 'ascend' : el.dataset.fate === 'rest' ? 'sink' : 'fade';
  if (fate === 'ascend') announceRisen(node.grave.title);
  if (fate === 'sink') status.textContent = `${node.grave.title} was laid to rest.`;
  departing++;
  const wait = fate === 'ascend' && node.summonedAt !== undefined ? Math.max(0, node.summonedAt + (node.wave ?? 0) + 520 - performance.now()) : 0;
  const duration = reduced() ? 650 : fate === 'ascend' ? 1500 : fate === 'sink' ? 1700 : 800;
  setTimeout(() => {
    el.classList.add(fate);
    if (!reduced()) effects(el, fate);
    // Leave once the stone's own animation has played out (or soon after, if it never reports back).
    let gone = false;
    const leave = (): void => {
      if (gone) return;
      gone = true;
      departing--;
      removals.push(el);
      if (departing === 0) flushRemovals();
    };
    const carving = el.querySelector('.carving')!;
    carving.addEventListener('animationend', (e) => e.target === carving && leave());
    setTimeout(leave, duration + 1200);
  }, wait);
}

/** One message for a whole wave of resurrections, not one per stone. */
function announceRisen(title: string): void {
  ascended.push(title);
  clearTimeout(announceTimer);
  announceTimer = window.setTimeout(() => {
    status.textContent = ascended.length === 1 ? `${ascended[0]} has risen and is open again.` : `${ascended.length} graves have risen and their tabs are open again.`;
    ascended = [];
  }, 400);
}

function effects(el: HTMLElement, fate: 'ascend' | 'sink' | 'fade'): void {
  const carving = el.querySelector('.carving')!;
  const mound = el.querySelector('.mound')!;
  if (fate === 'ascend') {
    // Share a fixed budget of motes across however many stones are rising together.
    const share = 1 / Math.max(1, Math.sqrt(gravesEl.querySelectorAll('.ascend').length));
    [0, 180, 420, 700, 950].forEach((t, i) =>
      setTimeout(() => {
        const r = carving.getBoundingClientRect();
        particles.motes(new DOMRect(r.left, r.top + r.height * (0.15 * i), r.width, r.height * 0.7), Math.round((i === 0 ? 30 : 16) * share));
      }, t),
    );
  } else if (fate === 'sink') {
    for (let t = 0; t < 1300; t += 160) {
      setTimeout(() => {
        const m = mound.getBoundingClientRect();
        particles.dust(m.left + m.width / 2, m.top + 9, m.width * 0.55, 10, 0.9);
      }, t);
    }
  }
}

function flushRemovals(): void {
  if (!removals.length) return;
  const first = snapshot();
  for (const el of removals.splice(0)) el.remove();
  glide(first);
  updateEmpty();
}

/**
 * Focus moves to the neighbouring stone itself (never one of its buttons, so a key still held
 * down cannot act on it), skipping stones hidden by the search or on their way out.
 */
function moveFocusFrom(el: HTMLElement): void {
  const usable = (n: Element | null): n is HTMLElement =>
    !!n && n.classList.contains('stone') && !(n as HTMLElement).hidden && !n.classList.contains('leaving');
  let next: Element | null = el.nextElementSibling;
  while (next && !usable(next)) next = next.nextElementSibling;
  if (!next) {
    next = el.previousElementSibling;
    while (next && !usable(next)) next = next.previousElementSibling;
  }
  focusMovedAt = performance.now();
  ((next as HTMLElement | null) ?? searchInput).focus({ preventScroll: true });
}

// ---------------------------------------------------------------- resurrection

function summon(node: GraveNode, wave = 0): void {
  const { el } = node;
  node.summonedAt = performance.now();
  node.wave = wave;
  el.dataset.fate = 'resurrect';
  el.style.setProperty('--wave', `${wave}ms`);
  if (!el.querySelector('.beam')) {
    const beam = document.createElement('div');
    beam.className = 'beam';
    beam.setAttribute('aria-hidden', 'true');
    el.prepend(beam);
  }
  el.classList.add('summoning');
  el.querySelectorAll('[data-action]').forEach((b) => b.setAttribute('aria-disabled', 'true'));
  setTimeout(() => {
    if (el.isConnected) particles.motes(el.querySelector('.carving')!.getBoundingClientRect(), 10);
  }, wave + 150);
}

function unsummon(node: GraveNode): void {
  const { el } = node;
  delete el.dataset.fate;
  el.classList.remove('summoning');
  el.querySelector('.beam')?.remove();
  el.querySelectorAll('[data-action]').forEach((b) => b.removeAttribute('aria-disabled'));
}

/** Reopen tabs first, and only then remove their graves, so a failure loses nothing. */
async function resurrect(ids: string[]): Promise<Set<string>> {
  const raised = new Set<string>();
  for (const id of ids) {
    const g = graves.find((x) => x.id === id);
    if (!g) continue;
    try {
      await ext.tabs.create({ url: g.url, active: false });
      raised.add(id);
    } catch (err) {
      console.warn('[haunted-tabs] could not resurrect', g.url, err);
    }
  }
  if (raised.size === 0) return raised;
  const current = await loadGraves();
  await saveGraves(current.filter((g) => !raised.has(g.id)));
  return raised;
}

async function raise(targets: { node: GraveNode; wave: number }[]): Promise<void> {
  const fresh = targets.filter(({ node }) => !pending.has(node.grave.id));
  if (!fresh.length) return;
  for (const { node, wave } of fresh) {
    pending.add(node.grave.id);
    summon(node, wave);
  }
  let raised = new Set<string>();
  try {
    raised = await resurrect(fresh.map(({ node }) => node.grave.id));
  } finally {
    for (const { node } of fresh) {
      if (!raised.has(node.grave.id) && nodes.get(node.grave.id) === node) {
        pending.delete(node.grave.id);
        unsummon(node);
      }
    }
  }
}

gravesEl.addEventListener('click', async (e) => {
  const button = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
  const stone = button?.closest<HTMLElement>('.stone[data-id]');
  if (!button || !stone) return;
  const id = stone.dataset.id!;
  const node = nodes.get(id);
  // Nothing more can be done to a grave already being raised.
  if (!node || pending.has(id)) return;
  // A keyboard "click" (detail 0) right after the page moved focus is a key still held down.
  if (e.detail === 0 && performance.now() - focusMovedAt < 500) return;
  if (button.dataset.action === 'resurrect') {
    await raise([{ node, wave: 0 }]);
  } else if (button.dataset.action === 'forget') {
    const g = graves.find((x) => x.id === id);
    if (!g || !confirm(`Lay "${g.title}" to rest? It will be removed from the Graveyard. The page itself stays in your browser history.`)) return;
    stone.dataset.fate = 'rest';
    try {
      const current = await loadGraves();
      await saveGraves(current.filter((x) => x.id !== id));
    } catch (err) {
      delete stone.dataset.fate;
      throw err;
    }
  }
});

resurrectAll.addEventListener('click', async () => {
  // A wave of light that sweeps across the yard, left to right, row by row.
  const targets = visible()
    .map((g) => nodes.get(g.id))
    .filter((n): n is GraveNode => !!n && !n.el.hidden)
    .map((node) => ({ node, rect: node.el.getBoundingClientRect() }));
  if (!targets.length) return;
  const keys = targets.map(({ rect }) => rect.left + rect.top * 0.6);
  const lo = Math.min(...keys);
  const span = Math.max(1, Math.max(...keys) - lo);
  const total = reduced() ? 0 : Math.min(1400, 160 * (targets.length - 1));
  await raise(targets.map(({ node }, i) => ({ node, wave: Math.round(((keys[i] - lo) / span) * total) })));
});

// ---------------------------------------------------------------- search and keys

// Auto-repeat from a held key never acts on the graves.
gravesEl.addEventListener('keydown', (e) => {
  if (e.repeat && (e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement).closest('[data-action]')) e.preventDefault();
});

let searchTimer = 0;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(render, 110);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && searchInput.value) {
    e.preventDefault();
    searchInput.value = '';
    render();
  }
});
document.getElementById('clear-search')!.addEventListener('click', () => {
  searchInput.value = '';
  render();
  searchInput.focus();
});
// After a while with no input the night holds still (see .still in the CSS); any input wakes it.
let stillTimer = 0;
const wake = (): void => {
  document.documentElement.classList.remove('still');
  clearTimeout(stillTimer);
  stillTimer = window.setTimeout(() => document.documentElement.classList.add('still'), 25_000);
};
for (const type of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'scroll', 'focusin', 'touchstart']) addEventListener(type, wake, { passive: true });
wake();

addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    searchInput.focus();
  }
});

// ---------------------------------------------------------------- stone textures

/**
 * Fine grain and broad mottling for the stones: SVG noise rendered once as images, where values
 * below the middle become dark specks and values above become light ones, both as plain alpha.
 * Stones then layer them with ordinary blending, which is cheap to draw and to animate over.
 */
function setGrainTextures(): void {
  const noise = (size: number, freq: number, octaves: number, strength: number): string =>
    'data:image/svg+xml,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><filter id="n" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
        `<feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="${octaves}" stitchTiles="stitch" seed="3"/>` +
        `<feColorMatrix values="1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  1 0 0 0 0"/>` +
        `<feComponentTransfer><feFuncR type="discrete" tableValues="0 1"/><feFuncG type="discrete" tableValues="0 1"/><feFuncB type="discrete" tableValues="0 1"/>` +
        `<feFuncA type="table" tableValues="${strength} 0 ${strength}"/></feComponentTransfer>` +
        `</filter><rect width="100%" height="100%" filter="url(#n)"/></svg>`,
    );
  document.querySelector('#grain image')?.setAttribute('href', noise(180, 0.8, 3, 0.5));
  document.querySelector('#mottle image')?.setAttribute('href', noise(420, 0.013, 4, 0.55));
}

// ---------------------------------------------------------------- go

onGravesChanged((next) => {
  graves = next;
  loaded = true;
  render();
});

loadGraves().then((g) => {
  graves = g;
  loaded = true;
  render();
});
