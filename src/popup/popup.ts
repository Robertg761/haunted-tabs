import { STAGE_MULTIPLIERS, STAGE_NAMES, formatIdle, siteName } from '../shared/haunt';
import { Stage, type PopupRequest, type Settings, type Snapshot, type TabView } from '../shared/types';
import { STAGE_EMOJI, el, faviconUrl, openGraveyard } from '../shared/ui';
import { ext } from '../shared/ext';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const enabledInput = $<HTMLInputElement>('enabled');
const searchInput = $<HTMLInputElement>('search');
const groupSelect = $<HTMLSelectElement>('group');
const thresholdSelect = $<HTMLSelectElement>('threshold');
const list = $<HTMLElement>('list');
const notice = $<HTMLElement>('notice');

const CHECKS = ['possession', 'poltergeist', 'whispers', 'autoDiscard', 'autoBury'] as const;

let snap: Snapshot | undefined;
let lastSignature = '';

async function ask<T = Snapshot>(req: PopupRequest): Promise<T> {
  const res = await ext.runtime.sendMessage(req);
  if (res && typeof res === 'object' && 'error' in res) throw new Error(String(res.error));
  return res as T;
}

function say(text: string, tone: 'info' | 'warn' = 'info'): void {
  notice.textContent = text;
  notice.dataset.tone = tone;
  notice.hidden = !text;
}

function renderHeader(s: Snapshot): void {
  const on = s.settings.enabled;
  document.body.dataset.level = String(on ? s.level.index : 0);
  document.body.classList.toggle('dormant', !on);
  enabledInput.checked = on;
  $('enabled-label').textContent = on ? 'Haunting' : 'Dormant';
  $('level-name').textContent = on ? s.level.name : `${s.level.name} (dormant)`;
  $('level-blurb').textContent = on ? s.level.blurb : 'The spirits sleep until you wake them.';
  $('meter-fill').style.width = `${Math.round((on ? s.level.pct : 0) * 100)}%`;
  $('intro').hidden = on;

  const counts = [0, 0, 0, 0, 0];
  for (const t of s.tabs) counts[t.stage]++;
  const parts = [`${s.tabs.length} tab${s.tabs.length === 1 ? '' : 's'}`];
  for (const stage of [Stage.Withering, Stage.Ghost, Stage.Dead, Stage.Entombed]) {
    if (counts[stage]) parts.push(`${STAGE_EMOJI[stage]} ${counts[stage]} ${STAGE_NAMES[stage]}`);
  }
  $('stats').textContent = on ? parts.join(' · ') : parts[0];

  $('grave-count').textContent = s.graveCount ? String(s.graveCount) : '';
  $<HTMLButtonElement>('exorcise').disabled = !on;

  if (on && !s.hostPermission) say('Haunting needs permission to repaint your tabs. Toggle it off and on to grant it.', 'warn');

  thresholdSelect.value = String(s.settings.thresholdMinutes);
  for (const key of CHECKS) $<HTMLInputElement>(key).checked = s.settings[key];
  const t = s.settings.thresholdMinutes;
  const at = (m: number) => formatIdle(m * t * 60_000).replace(/ 0m$/, '');
  $('timeline').textContent =
    `🥀 withers at ${at(STAGE_MULTIPLIERS[1])} · 👻 ghost at ${at(STAGE_MULTIPLIERS[2])} · ` +
    `💀 dead at ${at(STAGE_MULTIPLIERS[3])} · ⚰️ entombed at ${at(STAGE_MULTIPLIERS[4])}`;
}

interface Group {
  key: string;
  label: string;
  tabs: TabView[];
}

function groupTabs(s: Snapshot, tabs: TabView[]): Group[] {
  const mode = groupSelect.value;
  const groups = new Map<string, Group>();
  const add = (key: string, label: string, tab: TabView) => {
    if (!groups.has(key)) groups.set(key, { key, label, tabs: [] });
    groups.get(key)!.tabs.push(tab);
  };
  if (mode === 'domain') {
    for (const t of tabs) add(siteName(t.url), siteName(t.url), t);
    const out = [...groups.values()].sort((a, b) => b.tabs.length - a.tabs.length || a.label.localeCompare(b.label));
    out.forEach((g) => g.tabs.sort((a, b) => b.idleMs - a.idleMs));
    return out;
  }
  if (mode === 'idle') {
    const sorted = [...tabs].sort((a, b) => b.idleMs - a.idleMs);
    for (const t of sorted) {
      add(String(t.stage), t.stage === Stage.Alive ? '🕯️ Alive' : `${STAGE_EMOJI[t.stage]} ${STAGE_NAMES[t.stage][0].toUpperCase()}${STAGE_NAMES[t.stage].slice(1)}`, t);
    }
    return [...groups.values()].sort((a, b) => Number(b.key) - Number(a.key));
  }
  const windowIds = [...new Set(s.tabs.map((t) => t.windowId))];
  for (const t of [...tabs].sort((a, b) => a.windowId - b.windowId || a.index - b.index)) {
    const n = windowIds.indexOf(t.windowId) + 1;
    add(String(t.windowId), `Window ${n}${t.windowId === s.focusedWindowId ? ' (this one)' : ''}`, t);
  }
  return [...groups.values()].sort((a, b) => (a.key === String(s.focusedWindowId) ? -1 : b.key === String(s.focusedWindowId) ? 1 : 0));
}

function matches(t: TabView, q: string): boolean {
  if (!q) return true;
  return t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q);
}

function metaText(t: TabView, on: boolean): string {
  const bits = [siteName(t.url)];
  bits.push(t.active ? 'open now' : `idle ${formatIdle(t.idleMs)}`);
  if (on && t.stage !== Stage.Alive) bits.push(STAGE_NAMES[t.stage]);
  if (!t.hauntable) bits.push('untouchable');
  return bits.join(' · ');
}

function tabRow(t: TabView, on: boolean): HTMLElement {
  const flags = [t.pinned && '📌', t.audible && '🔊', t.discarded && '💤'].filter(Boolean).join(' ');
  const img = el('img', { src: faviconUrl(t.url, t.favIconUrl), alt: '', width: '16', height: '16' });
  const open = el(
    'button',
    { class: 'open', title: `${t.title}\n${t.url}`, 'data-action': 'switch' },
    el('span', { class: 'fav' }, img, on && t.stage ? el('span', { class: 'badge', text: STAGE_EMOJI[t.stage] }) : null),
    el(
      'span',
      { class: 'info' },
      el('span', { class: 'title', text: t.title }),
      el('span', { class: 'meta', 'data-meta': '', text: metaText(t, on) }),
    ),
    flags ? el('span', { class: 'flags', text: flags }) : null,
  );
  const discard = !t.active && !t.discarded && t.hauntable
    ? el('button', { class: 'act', title: 'Put to sleep (discard to free memory)', 'aria-label': 'Put to sleep', 'data-action': 'discard', text: '💤' })
    : null;
  const bury = el('button', { class: 'act', title: 'Close and bury in the Graveyard', 'aria-label': 'Bury', 'data-action': 'bury', text: '⚰️' });
  return el('div', { class: `tab stage-${on ? t.stage : 0}${t.active ? ' active' : ''}`, 'data-id': String(t.id) }, open, discard, bury);
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
    visible.map((t) => [t.id, t.title, t.url, on ? t.stage : 0, t.active, t.pinned, t.audible, t.discarded, t.windowId, t.index]),
  ]);
  if (signature === lastSignature) {
    // Same tabs, same order: only the idle clocks moved.
    for (const t of visible) {
      const meta = list.querySelector(`[data-id="${t.id}"] [data-meta]`);
      if (meta) meta.textContent = metaText(t, on);
    }
    return;
  }
  lastSignature = signature;
  const focusedId = (document.activeElement?.closest('[data-id]') as HTMLElement | null)?.dataset.id;
  const focusedAction = (document.activeElement as HTMLElement | null)?.dataset.action;
  list.replaceChildren();
  if (visible.length === 0) {
    list.append(el('p', { class: 'empty', text: q ? 'No tabs match. Perhaps they were never here.' : 'No tabs. Eerily quiet.' }));
    return;
  }
  for (const g of groupTabs(s, visible)) {
    list.append(el('h2', { class: 'group', text: `${g.label} · ${g.tabs.length}` }));
    for (const t of g.tabs) list.append(tabRow(t, on));
  }
  if (focusedId) {
    list.querySelector<HTMLElement>(`[data-id="${focusedId}"] [data-action="${focusedAction ?? 'switch'}"]`)?.focus();
  }
}

function show(s: Snapshot): void {
  snap = s;
  renderHeader(s);
  renderList(s);
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

enabledInput.addEventListener('change', async () => {
  if (enabledInput.checked) {
    // Requested from the click itself, so the browser shows its permission prompt.
    const granted = await requestThen({ origins: ['<all_urls>'] }, { enabled: true });
    if (!granted) {
      enabledInput.checked = false;
      say('Without permission to repaint tabs, the spirits cannot cross over. Haunting stays off.', 'warn');
      return;
    }
    say('');
    await update({ enabled: true });
  } else {
    await exorcise();
  }
});

async function exorcise(): Promise<void> {
  const banish = $('banish');
  banish.hidden = false;
  banish.classList.remove('play');
  void banish.offsetWidth;
  banish.classList.add('play');
  setTimeout(() => (banish.hidden = true), 1600);
  lastSignature = '';
  say('');
  show(await ask({ type: 'exorcise' }));
}

$('exorcise').addEventListener('click', exorcise);
$('graveyard').addEventListener('click', () => openGraveyard().then(() => window.close()));

thresholdSelect.addEventListener('change', () => update({ thresholdMinutes: Number(thresholdSelect.value) }));

for (const key of CHECKS) {
  const input = $<HTMLInputElement>(key);
  input.addEventListener('change', async () => {
    if (key === 'whispers' && input.checked) {
      const granted = await requestThen({ permissions: ['notifications'] }, { whispers: true });
      if (!granted) {
        input.checked = false;
        return;
      }
    }
    await update({ [key]: input.checked });
  });
}

searchInput.addEventListener('input', () => snap && renderList(snap));
searchInput.addEventListener('keydown', (e) => {
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
