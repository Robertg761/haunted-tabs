import { STAGE_MULTIPLIERS, STAGE_NAMES, formatIdle, siteName, stageProgress } from '../shared/haunt';
import { Stage, type PopupRequest, type Settings, type Snapshot, type TabView } from '../shared/types';
import { el, faviconUrl, openGraveyard } from '../shared/ui';
import { ext } from '../shared/ext';
import { STAGE_ICON, hydrateIcons, icon, type IconName } from './icons';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

hydrateIcons();

const body = document.body;
const enabledInput = $<HTMLInputElement>('enabled');
const searchInput = $<HTMLInputElement>('search');
const searchClear = $<HTMLButtonElement>('search-clear');
const groupSelect = $<HTMLSelectElement>('group');
const thresholdSelect = $<HTMLSelectElement>('threshold');
const list = $<HTMLElement>('list');
const notice = $<HTMLElement>('notice');
const meter = $<HTMLElement>('meter');
const content = $<HTMLElement>('content');
const header = document.querySelector<HTMLElement>('.top')!;
const sheet = $<HTMLElement>('settings');
const scrim = $<HTMLElement>('scrim');
const settingsToggle = $<HTMLButtonElement>('settings-toggle');
const exorciseButton = $<HTMLButtonElement>('exorcise');

const CHECKS = ['possession', 'poltergeist', 'cobwebs', 'dust', 'fog', 'eyes', 'drips', 'shadow', 'ghostCursor', 'whispers', 'autoDiscard', 'autoBury'] as const;

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const calm = () => reducedMotion.matches;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Not remembered this time; harmless.
    }
  },
};

let snap: Snapshot | undefined;
let lastSignature = '';
let statsSignature = '';
let timelineFor = NaN;
let shownLevel = -1;
/** Settings waiting on a permission prompt or a save; the 1 s refresh must not undo them. */
const pending = new Set<string>();

/** Only touch the DOM when a value really changes, so assistive tech is not told every second. */
function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}
function setAttr(node: Element, name: string, value: string): void {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

async function ask<T = Snapshot>(req: PopupRequest): Promise<T> {
  const res = await ext.runtime.sendMessage(req);
  if (res && typeof res === 'object' && 'error' in res) throw new Error(String(res.error));
  return res as T;
}

// Responses can overtake each other (the 1 s refresh against a settings change),
// so each one is numbered and anything older than what is on screen is dropped.
let issued = 0;
let applied = 0;
async function load(req: PopupRequest): Promise<void> {
  const n = ++issued;
  const s = await ask(req);
  if (n < applied) return;
  applied = n;
  show(s);
}

// ── Fit ────────────────────────────────────────────────────────────────────

/**
 * The popup is 600px tall, but the browser caps it at 600 device pixels, which
 * is fewer CSS pixels when the page is zoomed. Shrink to the real viewport then,
 * so the list gives way instead of the footer falling off the bottom. Measured
 * after the popup settles; viewport units are unreliable while it auto-sizes.
 */
let fitTimer = 0;
function fit(): void {
  clearTimeout(fitTimer);
  fitTimer = window.setTimeout(() => {
    const h = window.innerHeight;
    const target = h >= 600 || h < 240 ? '' : `${h}px`;
    if (document.documentElement.style.getPropertyValue('--app-h') !== target) {
      if (target) document.documentElement.style.setProperty('--app-h', target);
      else document.documentElement.style.removeProperty('--app-h');
    }
  }, 200);
}
addEventListener('resize', fit);
fit();

// ── Notices ────────────────────────────────────────────────────────────────

let noticeKey = '';

interface NoticeAction {
  label: string;
  run: () => void;
}

function say(text: string, tone: 'info' | 'warn' = 'info', action?: NoticeAction): void {
  const key = text && `${tone}|${text}|${action?.label ?? ''}`;
  if (key === noticeKey) return;
  noticeKey = key;
  notice.hidden = !text;
  if (!text) {
    notice.replaceChildren();
    return;
  }
  notice.dataset.tone = tone;
  notice.replaceChildren(el('span', { class: 'notice-icon' }, icon(tone === 'warn' ? 'lantern' : 'sparkle')), el('span', { class: 'notice-text', text }));
  if (action) {
    const button = el('button', { class: 'notice-action', type: 'button', text: action.label });
    button.addEventListener('click', action.run);
    notice.append(button);
  }
}

function announce(text: string): void {
  const live = $('sr-live');
  live.textContent = '';
  setTimeout(() => (live.textContent = text), 50);
}

// ── Header, level and settings ─────────────────────────────────────────────

function renderHeader(s: Snapshot): void {
  const on = s.settings.enabled;
  const blocked = on && !s.hostPermission;
  setAttr(body, 'data-level', String(on && !blocked ? s.level.index : 0));
  body.classList.toggle('dormant', !on);
  body.classList.toggle('no-access', blocked);
  body.classList.toggle('no-polt', !s.settings.poltergeist);
  if (!pending.has('enabled')) enabledInput.checked = on;
  setText($('enabled-label'), blocked ? 'Needs access' : on ? 'Haunting' : 'Dormant');
  setAttr($('switch'), 'title', on ? 'Put the spirits back to sleep (exorcises every tab)' : 'Wake the spirits');

  const counts = [0, 0, 0, 0, 0];
  for (const t of s.tabs) counts[t.stage]++;
  const turned = counts[1] + counts[2] + counts[3] + counts[4];
  const windows = new Set(s.tabs.map((t) => t.windowId)).size;
  const tally = `${plural(s.tabs.length, 'tab')} in ${plural(windows, 'window')}`;
  // The level counts crowding too, so it can rise before any tab has turned.
  const mood = !on
    ? tally
    : blocked
      ? 'Waiting for permission to haunt.'
      : turned === 0 && s.level.index > 0
        ? `${plural(s.tabs.length, 'tab')} crowd the strip.`
        : s.level.blurb;
  const blurb = $('level-blurb');
  setText(blurb, mood);
  setAttr(blurb, 'title', on ? `${mood} ${tally}.` : tally);
  setAttr(searchInput, 'placeholder', `Search ${plural(s.tabs.length, 'tab')}`);

  setText($('level-name'), on ? s.level.name : 'Dormant');
  const pct = on && !blocked ? s.level.pct : 0;
  const pctText = pct.toFixed(3);
  if (meter.style.getPropertyValue('--pct') !== pctText) meter.style.setProperty('--pct', pctText);
  setAttr(meter, 'aria-valuenow', String(Math.round(pct * 100)));
  setAttr(meter, 'aria-valuetext', `${on ? s.level.name : 'Dormant'}, ${Math.round(pct * 100)}%`);
  if (on && !blocked && s.level.index !== shownLevel) {
    if (shownLevel >= 0) announce(`Haunt level ${s.level.name}. ${s.level.blurb}`);
    shownLevel = s.level.index;
    shine();
  }
  if (!on) shownLevel = -1;

  const introDismissed = store.get('introDismissed') === '1';
  $('intro').hidden = on || introDismissed;
  $('sleep').hidden = on || !introDismissed;

  const stats = JSON.stringify([on, counts]);
  if (stats !== statsSignature) {
    statsSignature = stats;
    const chips: Node[] = [];
    for (const stage of [Stage.Withering, Stage.Ghost, Stage.Dead, Stage.Entombed]) {
      if (!counts[stage]) continue;
      chips.push(
        el(
          'span',
          { class: `stat s${stage}`, title: `${counts[stage]} ${STAGE_NAMES[stage]}` },
          icon(STAGE_ICON[stage]),
          el('b', { text: String(counts[stage]) }),
          el('span', { class: 'visually-hidden', text: ` ${STAGE_NAMES[stage]}` }),
        ),
      );
    }
    $('stats').replaceChildren(...chips);
  }

  const graves = s.graveCount;
  setText($('grave-count'), graves ? String(graves) : '');
  setAttr($('graveyard'), 'aria-label', graves ? `Graveyard, ${plural(graves, 'buried tab')}` : 'Graveyard');
  exorciseButton.disabled = !on;

  if (blocked) {
    say('Haunting needs permission to repaint your tabs.', 'warn', { label: 'Grant access', run: grantAccess });
  } else if (noticeKey.includes('Grant access')) {
    say('');
  }

  const t = s.settings.thresholdMinutes;
  if (!pending.has('thresholdMinutes') && thresholdSelect.value !== String(t)) thresholdSelect.value = String(t);
  for (const key of CHECKS) {
    const input = $<HTMLInputElement>(key);
    if (!pending.has(key) && input.checked !== s.settings[key]) input.checked = s.settings[key];
  }
  if (t !== timelineFor) renderTimeline(t);
}

/** Run the light across the meter a couple of times; it rests afterwards. */
function shine(): void {
  meter.classList.remove('shine');
  void meter.offsetWidth;
  meter.classList.add('shine');
}

function renderTimeline(t: number): void {
  timelineFor = t;
  const at = (m: number) => (m === 0 ? 'now' : formatIdle(m * t * 60_000).replace(/ 0m$/, ''));
  const stages = [Stage.Alive, Stage.Withering, Stage.Ghost, Stage.Dead, Stage.Entombed];
  $('timeline').replaceChildren(
    ...stages.map((stage) =>
      el(
        'li',
        { class: `tl s${stage}` },
        el('span', { class: 'tl-dot' }, icon(STAGE_ICON[stage])),
        el('span', { class: 'tl-name', text: stage === Stage.Alive ? 'fresh' : STAGE_NAMES[stage] }),
        el('span', { class: 'tl-time', text: at(STAGE_MULTIPLIERS[stage]) }),
      ),
    ),
  );
}

// ── Tab list ───────────────────────────────────────────────────────────────

/** A readable place name; the shared siteName turns about:blank into "about://". */
function siteLabel(url: string): string {
  if (/^about:/.test(url)) return url.split(/[?#]/)[0];
  if (/^chrome:\/\/newtab/.test(url)) return 'new tab page';
  return siteName(url);
}

interface Group {
  key: string;
  label: string;
  tag?: string;
  icon: IconName | { src: string };
  tone?: Stage;
  tabs: TabView[];
}

function groupTabs(s: Snapshot, tabs: TabView[]): Group[] {
  const mode = groupSelect.value;
  const on = s.settings.enabled;
  const groups = new Map<string, Group>();
  const add = (key: string, make: () => Omit<Group, 'tabs' | 'key'>, tab: TabView) => {
    if (!groups.has(key)) groups.set(key, { key, ...make(), tabs: [] });
    groups.get(key)!.tabs.push(tab);
  };
  if (mode === 'domain') {
    for (const t of tabs) add(`site:${siteLabel(t.url)}`, () => ({ label: siteLabel(t.url), icon: { src: faviconUrl(t.url, t.favIconUrl) } }), t);
    const out = [...groups.values()].sort((a, b) => b.tabs.length - a.tabs.length || a.label.localeCompare(b.label));
    out.forEach((g) => g.tabs.sort((a, b) => b.idleMs - a.idleMs));
    return out;
  }
  if (mode === 'idle') {
    const sorted = [...tabs].sort((a, b) => b.idleMs - a.idleMs);
    if (!on) return [{ key: 'idle:all', label: 'Longest forgotten first', icon: 'hourglass', tabs: sorted }];
    for (const t of sorted) {
      add(`idle:${t.stage}`, () => ({ label: cap(STAGE_NAMES[t.stage]), icon: STAGE_ICON[t.stage], tone: t.stage }), t);
    }
    return [...groups.values()].sort((a, b) => Number(b.key.slice(5)) - Number(a.key.slice(5)));
  }
  const windowIds = [...new Set(s.tabs.map((t) => t.windowId))];
  for (const t of [...tabs].sort((a, b) => a.windowId - b.windowId || a.index - b.index)) {
    const n = windowIds.indexOf(t.windowId) + 1;
    add(`win:${t.windowId}`, () => ({ label: `Window ${n}`, tag: t.windowId === s.focusedWindowId ? 'this window' : undefined, icon: 'window' }), t);
  }
  const focused = `win:${s.focusedWindowId}`;
  return [...groups.values()].sort((a, b) => (a.key === focused ? -1 : b.key === focused ? 1 : 0));
}

function matches(t: TabView, q: string): boolean {
  if (!q) return true;
  return t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q);
}

function idleText(t: TabView): string {
  return t.active ? 'now' : formatIdle(t.idleMs);
}

function decayProgress(t: TabView, on: boolean, thresholdMinutes: number): number {
  if (!on || t.active) return 0;
  const p = t.stage === Stage.Entombed ? 1 : stageProgress(t.idleMs, thresholdMinutes);
  // A sliver of arc reads as a glitch, so the ring waits until there is something to show.
  return p < 0.05 ? 0 : p;
}

function flag(name: IconName, label: string): HTMLElement {
  return el('span', { class: `flag flag-${name}`, title: label }, icon(name, label));
}

function tabRow(t: TabView, on: boolean, thresholdMinutes: number): HTMLElement {
  const stage = on ? t.stage : Stage.Alive;
  const img = el('img', { src: faviconUrl(t.url, t.favIconUrl), alt: '', width: '16', height: '16', decoding: 'async' });
  const fav = el(
    'span',
    { class: 'fav' },
    el('span', { class: 'ring' }),
    img,
    stage ? el('span', { class: 'badge', title: cap(STAGE_NAMES[stage]) }, icon(STAGE_ICON[stage])) : null,
  );
  const meta = el(
    'span',
    { class: 'meta' },
    el('span', { class: 'site', text: siteLabel(t.url) }),
    stage ? el('span', { class: 'chip', text: STAGE_NAMES[stage] }) : null,
    t.pinned ? flag('pin', 'Pinned, never haunted') : null,
    t.audible ? flag('sound', 'Playing sound, never haunted') : null,
    t.discarded ? flag('moon', 'Asleep to save memory') : null,
    !t.hauntable ? flag('shield', 'Untouchable: the browser does not let anything haunt this page') : null,
  );
  const idle = el(
    'span',
    { class: `idle${t.active ? ' now' : ''}` },
    el('span', { class: 'visually-hidden', text: t.active ? 'open ' : 'idle ' }),
    el('span', { 'data-idle': '', text: idleText(t) }),
  );
  const open = el(
    'button',
    {
      class: 'open',
      type: 'button',
      tabindex: '-1',
      title: `${t.title}\n${t.url}\n\nEnter switches · → actions · Delete buries`,
      'aria-keyshortcuts': 'Delete',
      'data-action': 'switch',
    },
    fav,
    el('span', { class: 'info' }, el('span', { class: 'title', text: t.title || siteLabel(t.url) }), meta),
    idle,
  );
  const discard =
    !t.active && !t.discarded && t.hauntable
      ? el(
          'button',
          { class: 'act', type: 'button', tabindex: '-1', title: 'Put to sleep (discard to free memory)', 'aria-label': 'Put to sleep', 'data-action': 'discard' },
          icon('moon'),
        )
      : null;
  const bury = el(
    'button',
    { class: 'act bury', type: 'button', tabindex: '-1', title: 'Close and bury in the Graveyard (Delete)', 'aria-label': 'Bury', 'data-action': 'bury' },
    icon('shovel'),
  );
  const row = el(
    'div',
    {
      class: `tab stage-${stage}${t.active ? ' active' : ''}${t.hauntable ? '' : ' untouchable'}${discard ? ' two-acts' : ''}`,
      role: 'listitem',
      'data-id': String(t.id),
    },
    open,
    el('span', { class: 'acts' }, discard, bury),
  );
  row.style.setProperty('--p', decayProgress(t, on, thresholdMinutes).toFixed(3));
  return row;
}

function groupHead(g: Group): HTMLElement {
  const glyph =
    typeof g.icon === 'string' ? icon(g.icon) : el('img', { src: g.icon.src, alt: '', width: '12', height: '12', class: 'group-fav' });
  return el(
    'div',
    { class: `group${g.tone !== undefined ? ` tone-${g.tone}` : ''}`, role: 'listitem' },
    el(
      'h2',
      { class: 'group-h' },
      el('span', { class: 'group-icon' }, glyph),
      el('span', { class: 'group-label', text: g.label }),
      g.tag ? el('span', { class: 'group-tag', text: g.tag }) : null,
      el('span', { class: 'group-count' }, String(g.tabs.length), el('span', { class: 'visually-hidden', text: g.tabs.length === 1 ? ' tab' : ' tabs' })),
    ),
  );
}

function emptyState(q: string): HTMLElement {
  return el(
    'div',
    { class: 'empty', role: 'listitem' },
    el('span', { class: 'empty-art' }, icon(q ? 'search' : 'ghost')),
    el('p', { class: 'empty-title', text: q ? 'No tabs answer' : 'Eerily quiet' }),
    el('p', { class: 'empty-line', text: q ? `Nothing here goes by “${q}”. Perhaps it was never here.` : 'No tabs at all. Not even a ghost.' }),
  );
}

interface Cached {
  sig: string;
  stage: Stage;
  node: HTMLElement;
}

let rows = new Map<number, Cached>();
let heads = new Map<string, Cached>();
let painted = false;
let lastMode = '';
let lastQuery = '';
/** The row that holds the list's single Tab stop. */
let rovingId: string | undefined;

const EASE = 'cubic-bezier(.2,.8,.2,1)';
const liveRows = () => [...list.querySelectorAll<HTMLElement>('.tab:not(.leaving)')];

/** Keep the idle clocks and decay rings moving without touching the layout. */
function tick(s: Snapshot, visible: TabView[]): void {
  const on = s.settings.enabled;
  for (const t of visible) {
    const row = rows.get(t.id)?.node;
    if (!row) continue;
    const idle = row.querySelector('[data-idle]');
    if (idle) setText(idle, idleText(t));
    const p = decayProgress(t, on, s.settings.thresholdMinutes).toFixed(3);
    if (row.style.getPropertyValue('--p') !== p) row.style.setProperty('--p', p);
  }
}

/** The list is one Tab stop: only the current row's main button is tabbable. */
function applyRoving(): void {
  const all = liveRows();
  const current = all.find((r) => r.dataset.id === rovingId) ?? all[0];
  rovingId = current?.dataset.id;
  for (const r of all) {
    const open = r.querySelector<HTMLElement>('.open')!;
    const want = r === current ? 0 : -1;
    if (open.tabIndex !== want) open.tabIndex = want;
  }
}

function renderList(s: Snapshot): void {
  const q = searchInput.value.trim().toLowerCase();
  const on = s.settings.enabled;
  const visible = s.tabs.filter((t) => matches(t, q));
  const mode = groupSelect.value;
  const signature = JSON.stringify([
    mode,
    q,
    on,
    s.focusedWindowId,
    visible.map((t) => [t.id, t.title, t.url, t.favIconUrl, on ? t.stage : 0, t.active, t.pinned, t.audible, t.discarded, t.hauntable, t.windowId, t.index]),
  ]);
  if (signature === lastSignature) {
    // Same tabs, same order: only the idle clocks moved.
    tick(s, visible);
    return;
  }
  lastSignature = signature;
  const regrouped = painted && mode !== lastMode;
  const refiltered = painted && q !== lastQuery;
  lastMode = mode;
  lastQuery = q;

  const scrollTop = regrouped || refiltered ? 0 : list.scrollTop;
  // First: where everything is now, and what had focus. A jump in scroll position
  // would make every row appear to fly, so that case just swaps.
  const motion = painted && !calm() && !regrouped && scrollTop === list.scrollTop;
  const before = new Map<Element, DOMRect>();
  for (const child of list.children) if (!child.classList.contains('leaving')) before.set(child, child.getBoundingClientRect());
  const focusedEl = document.activeElement as HTMLElement | null;
  const focusedRow = list.contains(focusedEl) ? focusedEl?.closest<HTMLElement>('[data-id]') : null;
  const focusedAction = focusedEl?.dataset.action ?? 'switch';
  const focusedIndex = focusedRow ? liveRows().indexOf(focusedRow) : -1;

  // Build the new order, reusing rows that have not changed.
  const nodes: HTMLElement[] = [];
  const nextRows = new Map<number, Cached>();
  const nextHeads = new Map<string, Cached>();
  const fresh = new Set<HTMLElement>();
  const escalated = new Set<HTMLElement>();
  const replaced = new Set<Element>();
  // A rebuilt node takes over its predecessor's place, so it glides like the original.
  const succeed = (old: Cached, node: HTMLElement) => {
    replaced.add(old.node);
    const rect = before.get(old.node);
    if (rect) before.set(node, rect);
  };
  if (visible.length === 0) {
    const empty = emptyState(q);
    nodes.push(empty);
    fresh.add(empty);
  } else {
    for (const g of groupTabs(s, visible)) {
      const headSig = JSON.stringify([g.label, g.tag, g.tabs.length, g.tone]);
      let head = heads.get(g.key);
      if (!head || head.sig !== headSig) {
        const node = groupHead(g);
        if (head) succeed(head, node);
        else fresh.add(node);
        head = { sig: headSig, stage: Stage.Alive, node };
      }
      nextHeads.set(g.key, head);
      nodes.push(head.node);
      for (const t of g.tabs) {
        const stage = on ? t.stage : Stage.Alive;
        const sig = JSON.stringify([t.title, t.url, t.favIconUrl, stage, t.active, t.pinned, t.audible, t.discarded, t.hauntable]);
        let row = rows.get(t.id);
        if (!row || row.sig !== sig) {
          const node = tabRow(t, on, s.settings.thresholdMinutes);
          if (!row) fresh.add(node);
          else {
            succeed(row, node);
            if (stage > row.stage) escalated.add(node);
          }
          row = { sig, stage, node };
        }
        nextRows.set(t.id, row);
        nodes.push(row.node);
      }
    }
  }
  const kept = new Set<Element>(nodes);
  const leaving = regrouped ? [] : ([...before.keys()].filter((n) => !kept.has(n) && !replaced.has(n) && list.contains(n)) as HTMLElement[]);
  const leavingRects = new Map(leaving.map((n) => [n, before.get(n)!]));
  rows = nextRows;
  heads = nextHeads;
  tick(s, visible);

  // Place: move only what has to move, leaving departing rows to fade out.
  if (regrouped) for (const old of list.querySelectorAll('.leaving')) old.remove();
  let cursor: ChildNode | null = list.firstChild;
  const skip = () => {
    while (cursor && (cursor as Element).classList?.contains('leaving')) cursor = cursor.nextSibling;
  };
  for (const node of nodes) {
    skip();
    if (cursor === node) {
      cursor = cursor.nextSibling;
      continue;
    }
    list.insertBefore(node, cursor);
  }
  while (cursor) {
    const next: ChildNode | null = cursor.nextSibling;
    if (!(cursor as Element).classList?.contains('leaving')) cursor.remove();
    cursor = next;
  }
  list.scrollTop = scrollTop;

  // Keyboard focus survives the reorder; if its row is gone, land on its neighbour.
  if (focusedRow) {
    const back =
      list.querySelector<HTMLElement>(`[data-id="${focusedRow.dataset.id}"]`) ??
      liveRows()[Math.min(Math.max(0, focusedIndex), liveRows().length - 1)];
    rovingId = back?.dataset.id;
  }
  applyRoving();
  if (focusedRow && !list.contains(document.activeElement)) {
    const row = list.querySelector<HTMLElement>(`[data-id="${rovingId}"]`);
    (row?.querySelector<HTMLElement>(`[data-action="${focusedAction}"]`) ?? row?.querySelector<HTMLElement>('.open'))?.focus({ preventScroll: true });
  }

  if (regrouped) {
    // A new arrangement: crossfade the whole list rather than sending rows across each other.
    list.animate(calm() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], {
      duration: 240,
      easing: EASE,
    });
    painted = true;
    return;
  }

  // Last, invert, play. Departing rows fade in place first; neighbours close the gap after.
  const listRect = list.getBoundingClientRect();
  const exits = leaving.length > 0 && leaving.length <= 24 && painted;
  for (const node of leaving) {
    if (!exits) break;
    const rect = leavingRects.get(node)!;
    node.classList.add('leaving');
    node.removeAttribute('data-id');
    node.removeAttribute('role');
    node.inert = true;
    node.setAttribute('aria-hidden', 'true');
    node.style.top = `${rect.top - listRect.top - list.clientTop + list.scrollTop}px`;
    node.style.left = `${rect.left - listRect.left - list.clientLeft}px`;
    node.style.width = `${rect.width}px`;
    list.append(node);
    const sinking = node.classList.contains('sinking');
    const frames = calm()
      ? [{ opacity: sinking ? 0.45 : 1 }, { opacity: 0 }]
      : sinking
        ? [
            { opacity: 0.45, transform: 'translateY(3px) scale(.99)' },
            { opacity: 0, transform: 'translateY(14px) scale(.96)' },
          ]
        : [{ opacity: 1 }, { opacity: 0 }];
    const anim = node.animate(frames, { duration: sinking ? 260 : 120, easing: 'ease-in', fill: 'forwards' });
    anim.onfinish = () => node.remove();
  }
  const settle = exits ? 100 : 0;

  let stagger = 0;
  for (const node of nodes) {
    if (fresh.has(node)) {
      if (!painted) {
        const delay = Math.min(stagger++ * 22, 260);
        node.animate(calm() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], {
          duration: 320,
          delay,
          easing: EASE,
          fill: 'backwards',
        });
      } else {
        node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: settle + 120, easing: EASE, fill: 'backwards' });
      }
      continue;
    }
    if (escalated.has(node)) {
      // Cleared once played: CSS animations restart whenever a node moves.
      node.classList.add('escalate');
      node.addEventListener('animationend', (e) => e.target === node && node.classList.remove('escalate'));
    }
    const old = before.get(node);
    if (!motion || !old) continue;
    const now = node.getBoundingClientRect();
    const dy = old.top - now.top;
    if (Math.abs(dy) < 0.5) continue;
    node.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 300, delay: settle, easing: EASE, fill: 'backwards' });
  }
  painted = true;
}

function show(s: Snapshot): void {
  snap = s;
  renderHeader(s);
  renderList(s);
  if (body.classList.contains('booting')) requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove('booting')));
}

async function refresh(): Promise<void> {
  try {
    await load({ type: 'snapshot' });
  } catch (err) {
    say(`The spirits are unreachable: ${(err as Error).message}`, 'warn');
  }
}

async function update(settings: Partial<Settings>): Promise<void> {
  lastSignature = '';
  await load({ type: 'setSettings', settings });
}

/** Save settings, holding the controls steady until the answer is on screen. */
async function change(settings: Partial<Settings>): Promise<boolean> {
  const keys = Object.keys(settings);
  keys.forEach((k) => pending.add(k));
  try {
    await update(settings);
    return true;
  } catch (err) {
    say(`That change did not take: ${(err as Error).message}`, 'warn');
    return false;
  } finally {
    keys.forEach((k) => pending.delete(k));
    if (snap) renderHeader(snap);
  }
}

/**
 * Ask for a permission, and have the background apply `settings` once it is
 * granted. Firefox closes the popup while its permission prompt is open, so the
 * popup may never see the answer; the background finishes the job instead.
 */
function requestThen(permissions: chrome.permissions.Permissions, settings: Partial<Settings>): Promise<boolean> {
  // The request must start synchronously inside the click, before any await.
  const granted = ext.permissions.request(permissions);
  ask({ type: 'armPermission', settings }).catch(() => {});
  return granted;
}

// ── Ceremonies ─────────────────────────────────────────────────────────────

let awakenTimer = 0;
function awaken(): void {
  // The light spills out of wherever the switch really is.
  const track = document.querySelector('.track')!.getBoundingClientRect();
  const glow = $('awaken');
  glow.style.setProperty('--ax', `${track.left + track.width / 2}px`);
  glow.style.setProperty('--ay', `${track.top + track.height / 2}px`);
  body.classList.remove('awakening');
  void body.offsetWidth;
  body.classList.add('awakening');
  clearTimeout(awakenTimer);
  awakenTimer = window.setTimeout(() => body.classList.remove('awakening'), 1800);
  announce('Haunting is on. Neglected tabs will begin to decay.');
}

let banishTimer = 0;
function banishRitual(): void {
  const banish = $('banish');
  banish.hidden = false;
  banish.classList.remove('play');
  void banish.offsetWidth;
  banish.classList.add('play');
  clearTimeout(banishTimer);
  banishTimer = window.setTimeout(() => {
    banish.hidden = true;
    banish.classList.remove('play');
  }, 2300);
}

async function grantAccess(): Promise<void> {
  const granted = await requestThen({ origins: ['<all_urls>'] }, { enabled: true });
  if (granted && (await change({ enabled: true }))) {
    say('');
    awaken();
  }
}

enabledInput.addEventListener('change', async () => {
  if (!enabledInput.checked) {
    await exorcise();
    return;
  }
  pending.add('enabled');
  try {
    // Requested from the click itself, so the browser shows its permission prompt.
    const granted = await requestThen({ origins: ['<all_urls>'] }, { enabled: true });
    if (!granted) {
      enabledInput.checked = false;
      say('Without permission to repaint tabs, the spirits cannot cross over. Haunting stays off.', 'warn');
      return;
    }
    say('');
    if (await change({ enabled: true })) awaken();
  } catch (err) {
    enabledInput.checked = false;
    say(`The spirits did not stir: ${(err as Error).message}`, 'warn');
  } finally {
    pending.delete('enabled');
    if (snap) renderHeader(snap);
  }
});

async function exorcise(): Promise<void> {
  // The Exorcise button disables itself; keep keyboard focus somewhere useful.
  const fromButton = document.activeElement === exorciseButton;
  banishRitual();
  lastSignature = '';
  say('');
  try {
    await load({ type: 'exorcise' });
    announce('Every tab is restored and haunting is off.');
  } catch (err) {
    say(`The exorcism faltered: ${(err as Error).message}`, 'warn');
  }
  if (fromButton) enabledInput.focus();
}

exorciseButton.addEventListener('click', exorcise);
$('graveyard').addEventListener('click', () => openGraveyard().then(() => window.close()));

$('intro-dismiss').addEventListener('click', () => {
  store.set('introDismissed', '1');
  if (snap) renderHeader(snap);
  $('intro-show').focus();
});
$('intro-show').addEventListener('click', () => {
  store.set('introDismissed', '0');
  if (snap) renderHeader(snap);
  $('intro-dismiss').focus();
});

// ── Settings sheet (modal) ─────────────────────────────────────────────────

let sheetTimer = 0;
function openSettings(): void {
  clearTimeout(sheetTimer);
  sheet.hidden = false;
  scrim.hidden = false;
  void sheet.offsetWidth;
  sheet.classList.add('is-open');
  scrim.classList.add('is-open');
  content.inert = true;
  header.inert = true;
  settingsToggle.setAttribute('aria-expanded', 'true');
  $('settings-close').focus({ preventScroll: true });
}

function closeSettings(): void {
  if (sheet.hidden || !sheet.classList.contains('is-open')) return;
  sheet.classList.remove('is-open');
  scrim.classList.remove('is-open');
  content.inert = false;
  header.inert = false;
  settingsToggle.setAttribute('aria-expanded', 'false');
  settingsToggle.focus({ preventScroll: true });
  sheetTimer = window.setTimeout(
    () => {
      sheet.hidden = true;
      scrim.hidden = true;
    },
    calm() ? 200 : 320,
  );
}

settingsToggle.addEventListener('click', () => (sheet.hidden ? openSettings() : closeSettings()));
$('settings-close').addEventListener('click', closeSettings);
scrim.addEventListener('click', closeSettings);
sheet.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSettings();
    return;
  }
  if (e.key !== 'Tab') return;
  // Keep Tab inside the sheet while it is open.
  const stops = [...sheet.querySelectorAll<HTMLElement>('button, select, input')].filter((n) => !n.closest('[hidden]'));
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

// Short accessible names for the toggles; the description is read after.
for (const opt of document.querySelectorAll<HTMLLabelElement>('.opt')) {
  const input = opt.querySelector('input')!;
  const title = opt.querySelector('.opt-title')!;
  const desc = opt.querySelector('.opt-desc')!;
  desc.id = `${input.id}-desc`;
  input.setAttribute('aria-label', (title.firstChild?.textContent ?? '').trim());
  input.setAttribute('aria-describedby', desc.id);
}

thresholdSelect.addEventListener('change', () => change({ thresholdMinutes: Number(thresholdSelect.value) }));

for (const key of CHECKS) {
  const input = $<HTMLInputElement>(key);
  input.addEventListener('change', async () => {
    if (key === 'whispers' && input.checked) {
      pending.add(key);
      let granted = false;
      try {
        granted = await requestThen({ permissions: ['notifications'] }, { whispers: true });
      } catch {
        granted = false;
      } finally {
        pending.delete(key);
      }
      if (!granted) {
        input.checked = false;
        return;
      }
    }
    await change({ [key]: input.checked });
  });
}

// ── Search, grouping and keyboard ──────────────────────────────────────────

function syncSearch(): void {
  searchClear.hidden = !searchInput.value;
  if (snap) renderList(snap);
}

const focusRow = (row: HTMLElement | undefined) => row?.querySelector<HTMLElement>('.open')?.focus();

searchInput.addEventListener('input', syncSearch);
searchClear.addEventListener('click', () => {
  searchInput.value = '';
  syncSearch();
  searchInput.focus();
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    focusRow(liveRows()[0]);
    return;
  }
  if (e.key === 'Escape' && searchInput.value) {
    e.preventDefault();
    searchInput.value = '';
    syncSearch();
    return;
  }
  if (e.key !== 'Enter') return;
  const first = list.querySelector<HTMLElement>('[data-id]');
  if (first) ask({ type: 'switch', tabId: Number(first.dataset.id) }).then(() => window.close());
});
groupSelect.addEventListener('change', () => {
  store.set('group', groupSelect.value);
  if (snap) renderList(snap);
});
groupSelect.value = store.get('group') ?? 'window';
if (!groupSelect.value) groupSelect.value = 'window';

list.addEventListener('focusin', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.tab:not(.leaving)');
  if (row && row.dataset.id !== rovingId) {
    rovingId = row.dataset.id;
    applyRoving();
  }
});

list.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  const row = target.closest<HTMLElement>('.tab:not(.leaving)');
  if (!row) return;
  const all = liveRows();
  const i = all.indexOf(row);
  const controls = [row.querySelector<HTMLElement>('.open')!, ...row.querySelectorAll<HTMLElement>('.act')];
  const at = controls.indexOf(target);
  switch (e.key) {
    case 'ArrowDown':
      focusRow(all[Math.min(i + 1, all.length - 1)]);
      break;
    case 'ArrowUp':
      if (i === 0) searchInput.focus();
      else focusRow(all[i - 1]);
      break;
    case 'Home':
      focusRow(all[0]);
      break;
    case 'End':
      focusRow(all[all.length - 1]);
      break;
    case 'ArrowRight':
      controls[Math.min(at + 1, controls.length - 1)]?.focus();
      break;
    case 'ArrowLeft':
      controls[Math.max(at - 1, 0)]?.focus();
      break;
    case 'Delete':
    case 'Backspace':
      void act(row, 'bury');
      break;
    default:
      return;
  }
  e.preventDefault();
});

async function act(row: HTMLElement, action: string | undefined): Promise<void> {
  const tabId = Number(row.dataset.id);
  if (Number.isNaN(tabId)) return;
  try {
    if (action === 'switch') {
      await ask({ type: 'switch', tabId });
      window.close();
    } else if (action === 'bury') {
      // Feedback right away; the row sinks out once the tab is really closed.
      row.classList.add('sinking');
      await ask({ type: 'bury', tabId });
      await refresh();
    } else if (action === 'discard') {
      const res = await ask<{ ok: boolean; reason?: string }>({ type: 'discard', tabId });
      if (!res.ok && res.reason) say(res.reason, 'warn');
      await refresh();
    }
  } catch (err) {
    row.classList.remove('sinking');
    say(`The spirits refused: ${(err as Error).message}`, 'warn');
  }
}

list.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
  const row = button?.closest<HTMLElement>('[data-id]');
  if (button && row) void act(row, button.dataset.action);
});

refresh();
setInterval(refresh, 1000);
searchInput.focus();
