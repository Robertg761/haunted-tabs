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
const groupSelect = $<HTMLSelectElement>('group');
const thresholdSelect = $<HTMLSelectElement>('threshold');
const list = $<HTMLElement>('list');
const notice = $<HTMLElement>('notice');
const meter = $<HTMLElement>('meter');
const meterFill = $<HTMLElement>('meter-fill');
const content = $<HTMLElement>('content');
const sheet = $<HTMLElement>('settings');
const settingsToggle = $<HTMLButtonElement>('settings-toggle');
const pips = [...$('pips').children] as HTMLElement[];

const CHECKS = ['possession', 'poltergeist', 'cobwebs', 'dust', 'fog', 'eyes', 'drips', 'shadow', 'ghostCursor', 'whispers', 'autoDiscard', 'autoBury'] as const;

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const calm = () => reducedMotion.matches;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

let snap: Snapshot | undefined;
let lastSignature = '';
let statsSignature = '';
let timelineFor = NaN;
/** Settings waiting on a permission prompt; the 1 s refresh must not undo them. */
const pending = new Set<string>();

async function ask<T = Snapshot>(req: PopupRequest): Promise<T> {
  const res = await ext.runtime.sendMessage(req);
  if (res && typeof res === 'object' && 'error' in res) throw new Error(String(res.error));
  return res as T;
}

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

// ── Header, meter and settings ─────────────────────────────────────────────

function renderHeader(s: Snapshot): void {
  const on = s.settings.enabled;
  body.dataset.level = String(on ? s.level.index : 0);
  body.classList.toggle('dormant', !on);
  body.classList.toggle('no-polt', !s.settings.poltergeist);
  if (!pending.has('enabled')) enabledInput.checked = on;
  $('enabled-label').textContent = on ? 'Haunting' : 'Dormant';
  $('level-name').textContent = on ? s.level.name : 'Dormant';
  $('level-blurb').textContent = on ? s.level.blurb : 'The spirits sleep until you wake them.';
  const pct = on ? s.level.pct : 0;
  meterFill.style.setProperty('--pct', pct.toFixed(4));
  meter.setAttribute('aria-valuenow', String(Math.round(pct * 100)));
  meter.setAttribute('aria-valuetext', `${on ? s.level.name : 'Dormant'}, ${Math.round(pct * 100)}%`);
  pips.forEach((pip, i) => pip.classList.toggle('lit', on && i <= s.level.index));
  $('intro').hidden = on;

  const windows = new Set(s.tabs.map((t) => t.windowId)).size;
  $('summary').textContent = `${plural(s.tabs.length, 'tab')} in ${plural(windows, 'window')}`;

  const counts = [0, 0, 0, 0, 0];
  for (const t of s.tabs) counts[t.stage]++;
  const stats = JSON.stringify([on, counts]);
  if (stats !== statsSignature) {
    statsSignature = stats;
    const chips: Node[] = [];
    for (const stage of [Stage.Withering, Stage.Ghost, Stage.Dead, Stage.Entombed]) {
      if (!counts[stage]) continue;
      chips.push(el('span', { class: `stat s${stage}` }, icon(STAGE_ICON[stage]), el('b', { text: String(counts[stage]) }), ` ${STAGE_NAMES[stage]}`));
    }
    if (!chips.length) chips.push(el('span', { class: 'stat calm' }, icon('candle'), 'No tab has turned. Yet.'));
    $('stats').replaceChildren(...chips);
  }

  const graves = s.graveCount;
  $('grave-count').textContent = graves ? String(graves) : '';
  $('graveyard').setAttribute('aria-label', graves ? `Graveyard, ${plural(graves, 'buried tab')}` : 'Graveyard');
  $<HTMLButtonElement>('exorcise').disabled = !on;

  if (on && !s.hostPermission) {
    say('Haunting needs permission to repaint your tabs.', 'warn', { label: 'Grant access', run: grantAccess });
  } else if (noticeKey.includes('Grant access')) {
    say('');
  }

  const t = s.settings.thresholdMinutes;
  if (thresholdSelect.value !== String(t)) thresholdSelect.value = String(t);
  for (const key of CHECKS) {
    const input = $<HTMLInputElement>(key);
    if (!pending.has(key) && input.checked !== s.settings[key]) input.checked = s.settings[key];
  }
  if (t !== timelineFor) renderTimeline(t);
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
    for (const t of tabs) add(`site:${siteName(t.url)}`, () => ({ label: siteName(t.url), icon: { src: faviconUrl(t.url, t.favIconUrl) } }), t);
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
  return t.stage === Stage.Entombed ? 1 : stageProgress(t.idleMs, thresholdMinutes);
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
    el('span', { class: 'site', text: siteName(t.url) }),
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
    { class: 'open', type: 'button', title: `${t.title}\n${t.url}`, 'data-action': 'switch' },
    fav,
    el('span', { class: 'info' }, el('span', { class: 'title', text: t.title || siteName(t.url) }), meta),
    idle,
  );
  const discard =
    !t.active && !t.discarded && t.hauntable
      ? el('button', { class: 'act', type: 'button', title: 'Put to sleep (discard to free memory)', 'aria-label': 'Put to sleep', 'data-action': 'discard' }, icon('moon'))
      : null;
  const bury = el('button', { class: 'act bury', type: 'button', title: 'Close and bury in the Graveyard', 'aria-label': 'Bury', 'data-action': 'bury' }, icon('shovel'));
  const row = el(
    'div',
    { class: `tab stage-${stage}${t.active ? ' active' : ''}${t.hauntable ? '' : ' untouchable'}`, 'data-id': String(t.id) },
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
    'h2',
    { class: `group${g.tone !== undefined ? ` tone-${g.tone}` : ''}` },
    el('span', { class: 'group-icon' }, glyph),
    el('span', { class: 'group-label', text: g.label }),
    g.tag ? el('span', { class: 'group-tag', text: g.tag }) : null,
    el('span', { class: 'group-count', text: String(g.tabs.length), 'aria-label': plural(g.tabs.length, 'tab') }),
  );
}

function emptyState(q: string): HTMLElement {
  return el(
    'div',
    { class: 'empty' },
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

const EASE = 'cubic-bezier(.2,.8,.2,1)';

/** Keep the idle clocks and decay rings moving without touching the layout. */
function tick(s: Snapshot, visible: TabView[]): void {
  const on = s.settings.enabled;
  for (const t of visible) {
    const row = rows.get(t.id)?.node;
    if (!row) continue;
    const idle = row.querySelector('[data-idle]');
    const text = idleText(t);
    if (idle && idle.textContent !== text) idle.textContent = text;
    row.style.setProperty('--p', decayProgress(t, on, s.settings.thresholdMinutes).toFixed(3));
  }
}

function renderList(s: Snapshot): void {
  const q = searchInput.value.trim().toLowerCase();
  const on = s.settings.enabled;
  const visible = s.tabs.filter((t) => matches(t, q));
  const signature = JSON.stringify([
    groupSelect.value,
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

  // First: where everything is now, and what had focus.
  const motion = painted && !calm();
  const before = new Map<Element, DOMRect>();
  for (const child of list.children) if (!child.classList.contains('leaving')) before.set(child, child.getBoundingClientRect());
  const focusedEl = document.activeElement as HTMLElement | null;
  const focusedRow = list.contains(focusedEl) ? focusedEl?.closest<HTMLElement>('[data-id]') : null;
  const focusedId = focusedRow?.dataset.id;
  const focusedAction = focusedEl?.dataset.action ?? 'switch';
  const focusedIndex = focusedRow ? [...list.querySelectorAll('.tab:not(.leaving)')].indexOf(focusedRow) : -1;
  const scrollTop = list.scrollTop;

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
  const leaving = [...before.keys()].filter((n) => !kept.has(n) && !replaced.has(n) && list.contains(n)) as HTMLElement[];
  const leavingRects = new Map(leaving.map((n) => [n, before.get(n)!]));
  rows = nextRows;
  heads = nextHeads;
  tick(s, visible);

  // Place: move only what has to move, leaving departing rows to fade out.
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
  if (focusedRow && !list.contains(document.activeElement)) {
    const target =
      list.querySelector<HTMLElement>(`[data-id="${focusedId}"] [data-action="${focusedAction}"]`) ??
      list.querySelectorAll<HTMLElement>('.tab:not(.leaving) [data-action="switch"]')[Math.max(0, focusedIndex)] ??
      list.querySelector<HTMLElement>('.tab:not(.leaving):last-of-type [data-action="switch"]');
    target?.focus({ preventScroll: true });
  }

  // Last, invert, play.
  const listRect = list.getBoundingClientRect();
  for (const node of leaving) {
    if (leavingRects.size > 24) break;
    const rect = leavingRects.get(node)!;
    node.classList.add('leaving');
    node.removeAttribute('data-id');
    node.inert = true;
    node.setAttribute('aria-hidden', 'true');
    node.style.top = `${rect.top - listRect.top - list.clientTop + list.scrollTop}px`;
    node.style.left = `${rect.left - listRect.left - list.clientLeft}px`;
    node.style.width = `${rect.width}px`;
    list.append(node);
    const sinking = node.classList.contains('sinking');
    const frames = calm()
      ? [{ opacity: 1 }, { opacity: 0 }]
      : sinking
        ? [{ opacity: 1, transform: 'none', filter: 'none' }, { opacity: 0, transform: 'translateY(14px) scale(.96)', filter: 'blur(2px)' }]
        : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-12px)' }];
    const anim = node.animate(frames, { duration: sinking ? 420 : 220, easing: 'ease-in', fill: 'forwards' });
    anim.onfinish = () => node.remove();
  }

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
        node.animate(calm() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE });
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
    node.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 360, easing: EASE });
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
    show(await ask({ type: 'snapshot' }));
  } catch (err) {
    say(`The spirits are unreachable: ${(err as Error).message}`, 'warn');
  }
}

async function update(settings: Partial<Settings>): Promise<void> {
  lastSignature = '';
  show(await ask({ type: 'setSettings', settings }));
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
  if (granted) {
    say('');
    await update({ enabled: true });
  }
}

enabledInput.addEventListener('change', async () => {
  if (enabledInput.checked) {
    pending.add('enabled');
    let granted = false;
    try {
      // Requested from the click itself, so the browser shows its permission prompt.
      granted = await requestThen({ origins: ['<all_urls>'] }, { enabled: true });
    } finally {
      pending.delete('enabled');
    }
    if (!granted) {
      enabledInput.checked = false;
      say('Without permission to repaint tabs, the spirits cannot cross over. Haunting stays off.', 'warn');
      return;
    }
    say('');
    await update({ enabled: true });
    awaken();
  } else {
    await exorcise();
  }
});

async function exorcise(): Promise<void> {
  banishRitual();
  lastSignature = '';
  say('');
  show(await ask({ type: 'exorcise' }));
  announce('Every tab is restored and haunting is off.');
}

$('exorcise').addEventListener('click', exorcise);
$('graveyard').addEventListener('click', () => openGraveyard().then(() => window.close()));

// ── Settings sheet ─────────────────────────────────────────────────────────

let sheetTimer = 0;
function openSettings(): void {
  clearTimeout(sheetTimer);
  sheet.hidden = false;
  void sheet.offsetWidth;
  sheet.classList.add('is-open');
  content.inert = true;
  settingsToggle.setAttribute('aria-expanded', 'true');
  $('settings-close').focus({ preventScroll: true });
}

function closeSettings(): void {
  if (sheet.hidden) return;
  sheet.classList.remove('is-open');
  content.inert = false;
  settingsToggle.setAttribute('aria-expanded', 'false');
  settingsToggle.focus({ preventScroll: true });
  sheetTimer = window.setTimeout(() => (sheet.hidden = true), calm() ? 0 : 280);
}

settingsToggle.addEventListener('click', () => (sheet.hidden ? openSettings() : closeSettings()));
$('settings-close').addEventListener('click', closeSettings);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !sheet.hidden) {
    e.preventDefault();
    closeSettings();
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

thresholdSelect.addEventListener('change', () => update({ thresholdMinutes: Number(thresholdSelect.value) }));

for (const key of CHECKS) {
  const input = $<HTMLInputElement>(key);
  input.addEventListener('change', async () => {
    if (key === 'whispers' && input.checked) {
      pending.add(key);
      let granted = false;
      try {
        granted = await requestThen({ permissions: ['notifications'] }, { whispers: true });
      } finally {
        pending.delete(key);
      }
      if (!granted) {
        input.checked = false;
        return;
      }
    }
    await update({ [key]: input.checked });
  });
}

// ── Search, grouping and keyboard ──────────────────────────────────────────

const firstRow = () => list.querySelector<HTMLElement>('.tab:not(.leaving) [data-action="switch"]');

searchInput.addEventListener('input', () => snap && renderList(snap));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    firstRow()?.focus();
    return;
  }
  if (e.key !== 'Enter') return;
  const first = list.querySelector<HTMLElement>('[data-id]');
  if (first) ask({ type: 'switch', tabId: Number(first.dataset.id) }).then(() => window.close());
});
groupSelect.addEventListener('change', () => {
  try {
    localStorage.setItem('group', groupSelect.value);
  } catch {
    // Not remembered this time; harmless.
  }
  if (snap) renderList(snap);
});
try {
  groupSelect.value = localStorage.getItem('group') ?? 'window';
} catch {
  // Storage unavailable; keep the default grouping.
}

list.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const opens = [...list.querySelectorAll<HTMLElement>('.tab:not(.leaving) [data-action="switch"]')];
  const current = (e.target as HTMLElement).closest('.tab')?.querySelector<HTMLElement>('[data-action="switch"]');
  const i = current ? opens.indexOf(current) : -1;
  e.preventDefault();
  const next = i + (e.key === 'ArrowDown' ? 1 : -1);
  if (next < 0) searchInput.focus();
  else opens[Math.min(next, opens.length - 1)]?.focus();
});

list.addEventListener('click', async (e) => {
  const button = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
  const row = button?.closest<HTMLElement>('[data-id]');
  if (!button || !row) return;
  const tabId = Number(row.dataset.id);
  const action = button.dataset.action;
  if (action === 'switch') {
    await ask({ type: 'switch', tabId });
    window.close();
  } else if (action === 'bury') {
    row.classList.add('sinking');
    await ask({ type: 'bury', tabId });
    await refresh();
  } else if (action === 'discard') {
    const res = await ask<{ ok: boolean; reason?: string }>({ type: 'discard', tabId });
    if (!res.ok && res.reason) say(res.reason, 'warn');
    await refresh();
  }
});

refresh();
setInterval(refresh, 1000);
searchInput.focus();
