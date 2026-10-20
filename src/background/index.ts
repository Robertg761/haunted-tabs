import {
  corruptTitle,
  hauntLevel,
  hauntedTitle,
  isHauntableUrl,
  poltergeistChance,
  poltergeistCooldownMs,
  poltergeistMessage,
  possessionMessage,
  spokenDuration,
  stageFor,
} from '../shared/haunt';
import { loadGraves, loadSettings, saveGraves, saveSettings } from '../shared/storage';
import {
  Stage,
  type EffectName,
  type Grave,
  type HauntLevel,
  type PageCommand,
  type PageEvent,
  type PopupRequest,
  type Settings,
  type Snapshot,
  type TabRecord,
  type TabView,
} from '../shared/types';
import { iconFor, isOurIcon } from './favicons';
import { ext } from '../shared/ext';

const TICK_ALARM = 'haunt-tick';
const SESSION_KEY = 'hauntState';
const ALL_URLS = { origins: ['<all_urls>'] };
const GLITCH_MS = 1100;

interface SessionState {
  records: Record<number, TabRecord>;
  activeByWindow: Record<number, number>;
  lastPoltergeist: number;
  /** Settings to apply when a pending permission prompt is accepted. */
  pendingPermission?: { settings: Partial<Settings>; at: number };
}

/**
 * Pages we have painted, by URL, kept in storage.local. Session storage and tab
 * ids do not survive a browser restart, but the browser may restore a tab still
 * showing our ghost title without loading it. This lets us recognise it.
 */
type PaintEntry = { real?: string; painted: string; icon?: string };
type PaintedMap = Record<string, PaintEntry[]>;
const PAINTED_KEY = 'painted';

let settings: Settings;
let state: SessionState = { records: {}, activeByWindow: {}, lastPoltergeist: 0 };
let painted: PaintedMap = {};
let paintedDirty = false;
let loaded: Promise<void> | undefined;

function load(): Promise<void> {
  loaded ??= (async () => {
    settings = await loadSettings();
    const got = await ext.storage.session.get(SESSION_KEY);
    if (got[SESSION_KEY]) state = got[SESSION_KEY] as SessionState;
    const stored = ((await ext.storage.local.get(PAINTED_KEY))[PAINTED_KEY] ?? {}) as Record<string, unknown>;
    painted = Object.fromEntries(Object.entries(stored).filter(([, v]) => Array.isArray(v))) as PaintedMap;
  })();
  return loaded;
}

async function persist(): Promise<void> {
  await ext.storage.session.set({ [SESSION_KEY]: state });
  if (paintedDirty) {
    paintedDirty = false;
    await ext.storage.local.set({ [PAINTED_KEY]: painted });
  }
}

/**
 * Rebuild the painted-pages record from the tab records. Duplicate tabs on one
 * URL each keep their own entry. Only call this once every open tab has a record
 * (tick, exorcise), or tabs not yet seen since a restart would be forgotten.
 */
function syncPainted(): void {
  const next: PaintedMap = {};
  for (const rec of Object.values(state.records)) {
    if (rec.applied === Stage.Alive || !rec.url || !rec.appliedTitle) continue;
    (next[rec.url] ??= []).push({ real: rec.realTitle, painted: rec.appliedTitle, icon: rec.realFavIconUrl });
  }
  if (JSON.stringify(next) === JSON.stringify(painted)) return;
  painted = next;
  paintedDirty = true;
}

// Every event handler runs through this queue, so the service worker never
// interleaves two read-modify-write cycles on the tab records.
let queue: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    await load();
    return fn();
  });
  queue = run.catch((err) => console.warn('[haunted-tabs]', err));
  return run;
}

function recordFor(tab: chrome.tabs.Tab, now: number): TabRecord {
  const id = tab.id!;
  let rec = state.records[id];
  if (!rec) {
    rec = {
      lastSeen: tab.active ? now : Math.min(now, tab.lastAccessed ?? now),
      applied: Stage.Alive,
      seed: Math.floor(Math.random() * 2 ** 31),
    };
    const known = tab.url ? painted[tab.url]?.find((e) => e.painted === tab.title) : undefined;
    if (known) {
      // Restored after a restart (or unloaded) and still wearing our paint.
      rec.applied = Stage.Withering;
      rec.appliedTitle = known.painted;
      rec.realTitle = known.real;
      rec.realFavIconUrl = known.icon;
    }
    state.records[id] = rec;
  }
  if (tab.url && tab.url !== 'about:blank') rec.url = tab.url;
  if (rec.applied === Stage.Alive) {
    rec.realTitle = tab.title;
    if (!isOurIcon(tab.favIconUrl)) rec.realFavIconUrl = tab.favIconUrl;
  }
  return rec;
}

/** Tabs the haunting must never touch, whatever their age. */
function isProtected(tab: chrome.tabs.Tab): boolean {
  return !!tab.pinned || !!tab.audible || !isHauntableUrl(tab.url);
}

function stageOf(tab: chrome.tabs.Tab, rec: TabRecord, now: number): Stage {
  if (tab.active || isProtected(tab)) return Stage.Alive;
  return stageFor(now - rec.lastSeen, settings.thresholdMinutes);
}

async function hasHostAccess(): Promise<boolean> {
  return ext.permissions.contains(ALL_URLS);
}

/** Talk to our content script in a tab, injecting it first if asked to. */
const SEND_TIMEOUT_MS = 3000;
const TIMED_OUT = new Error('timed out');

/** A browser can freeze a background tab; never let one stall the whole queue. */
function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => (timer = setTimeout(() => reject(TIMED_OUT), SEND_TIMEOUT_MS))),
  ]).finally(() => clearTimeout(timer));
}

/** Talk to our content script in a tab, injecting it first if asked to. */
async function send<T>(tabId: number, cmd: PageCommand, inject: boolean): Promise<T | undefined> {
  try {
    return (await withTimeout(ext.tabs.sendMessage(tabId, cmd))) as T;
  } catch (err) {
    // A frozen page would hang an injection too, so only inject when nobody answered.
    if (!inject || err === TIMED_OUT) return undefined;
  }
  try {
    await withTimeout(ext.scripting.executeScript({ target: { tabId }, files: ['content.js'] }));
    return (await withTimeout(ext.tabs.sendMessage(tabId, cmd))) as T;
  } catch {
    // Restricted page, discarded tab, or no host permission: leave it alone.
    return undefined;
  }
}

/**
 * Ask a page to drop our paint (`restore`) and/or its cobwebs (`sweep`).
 * 'frozen' means the page exists but could not answer yet, so the caller must
 * try again later. A page with nobody listening has nothing of ours to clean.
 */
async function tryClean(tabId: number, what: { restore?: boolean; sweep?: boolean }): Promise<'done' | 'frozen'> {
  const cmds: PageCommand[] = [];
  if (what.restore) cmds.push({ type: 'haunt:restore' });
  if (what.sweep) cmds.push({ type: 'haunt:sweep' });
  for (const cmd of cmds) {
    try {
      await withTimeout(ext.tabs.sendMessage(tabId, cmd));
    } catch (err) {
      return err === TIMED_OUT ? 'frozen' : 'done';
    }
  }
  return 'done';
}

/** Unloaded or frozen tabs keep their last face; there is no page to repaint. */
function isAsleep(tab: chrome.tabs.Tab): boolean {
  return !!tab.discarded || !!(tab as chrome.tabs.Tab & { frozen?: boolean }).frozen;
}

/** Give a tab its real face back, and with `sweep` take its cobwebs too. */
async function restoreTab(tabId: number, rec: TabRecord | undefined, sweep = false): Promise<void> {
  const result = await tryClean(tabId, { restore: true, sweep });
  if (!rec) return;
  if (result === 'frozen') {
    rec.needsExorcise = true; // still wearing our paint; tick retries
    return;
  }
  rec.applied = Stage.Alive;
  rec.appliedTitle = undefined;
  rec.needsExorcise = false;
  if (sweep) rec.cobwebsArmed = false;
}

/** Paint a tab to match its stage of decay. */
async function paint(tab: chrome.tabs.Tab, rec: TabRecord, stage: Stage, now: number): Promise<void> {
  if (stage === Stage.Alive) {
    if (rec.applied !== Stage.Alive) await restoreTab(tab.id!, rec);
    return;
  }
  if (isAsleep(tab)) return;
  const title = paintedTitle(tab, rec, stage, now);
  if (stage === rec.applied && title === rec.appliedTitle) return;
  const icon = await iconFor(stage, tab.url ?? '', rec.realFavIconUrl);
  const res = await send<{ ok: boolean; realTitle?: string }>(tab.id!, { type: 'haunt:apply', title, icon }, true);
  if (!res?.ok) return;
  rec.applied = stage;
  rec.appliedTitle = title;
  if (res.realTitle !== undefined) rec.realTitle = res.realTitle;
}

function paintedTitle(tab: chrome.tabs.Tab, rec: TabRecord, stage: Stage, now: number): string {
  return hauntedTitle({
    stage,
    realTitle: rec.realTitle ?? tab.title ?? '',
    url: tab.url ?? '',
    idleMs: now - rec.lastSeen,
    thresholdMinutes: settings.thresholdMinutes,
    seed: rec.seed,
  });
}

/** Only touch a tab we could look inside and that has no unsaved input. */
async function isSafeToClose(tab: chrome.tabs.Tab, rec: TabRecord): Promise<boolean> {
  if (tab.pinned || tab.audible) return false;
  if (tab.discarded) return !!rec.safeDiscarded;
  const res = await send<{ ok: boolean; dirty: boolean }>(tab.id!, { type: 'haunt:dirty' }, true);
  return res?.ok === true && res.dirty === false;
}

let graveQueue: Promise<unknown> = Promise.resolve();
function addGrave(grave: Grave): Promise<void> {
  const run = graveQueue.then(async () => {
    const graves = await loadGraves();
    graves.unshift(grave);
    await saveGraves(graves);
  });
  graveQueue = run.catch(() => {});
  return run;
}

/** Close a tab, but only after it is safely recorded in the Graveyard. */
async function bury(tab: chrome.tabs.Tab, rec: TabRecord, cause: Grave['cause'], now: number): Promise<void> {
  const url = tab.url || tab.pendingUrl;
  if (!url) return;
  const title = (rec.applied === Stage.Alive ? tab.title : rec.realTitle) || url;
  if (rec.applied !== Stage.Alive && !tab.discarded) {
    // Chrome caches whatever favicon a page shows. Put the real one back first so
    // history, bookmarks, and the Graveyard remember the tab as it really was.
    await restoreTab(tab.id!, rec);
    await new Promise((r) => setTimeout(r, 400));
  }
  await addGrave({
    id: crypto.randomUUID(),
    url,
    title,
    favIconUrl: rec.realFavIconUrl,
    diedAt: now,
    idleMs: now - rec.lastSeen,
    cause,
  });
  await ext.tabs.remove(tab.id!);
  delete state.records[tab.id!];
}

async function discard(tab: chrome.tabs.Tab, rec: TabRecord): Promise<void> {
  let result: chrome.tabs.Tab | undefined;
  try {
    // Chrome resolves with the discarded tab; Firefox resolves with nothing.
    result = (await ext.tabs.discard(tab.id!)) ?? undefined;
  } catch {
    return;
  }
  rec.safeDiscarded = true;
  if (result?.id !== undefined && result.id !== tab.id) {
    state.records[result.id] = rec;
    delete state.records[tab.id!];
  }
}

const LEVEL_COLORS = ['#4b5563', '#6d28d9', '#7e22ce', '#b91c1c', '#7f1d1d'];

async function updateBadge(level: HauntLevel, ghosts: number): Promise<void> {
  const on = settings.enabled;
  await ext.action.setBadgeText({ text: on && ghosts > 0 ? String(ghosts) : '' });
  await ext.action.setBadgeBackgroundColor({ color: LEVEL_COLORS[level.index] });
  await ext.action.setTitle({ title: on ? `Haunted Tabs: ${level.name}` : 'Haunted Tabs (dormant)' });
}

async function tick(): Promise<void> {
  const now = Date.now();
  const tabs = await ext.tabs.query({});
  const alive = new Set(tabs.map((t) => t.id));
  for (const id of Object.keys(state.records)) if (!alive.has(Number(id))) delete state.records[Number(id)];

  const stages = new Map<number, Stage>();
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const rec = recordFor(tab, now);
    if (tab.active) rec.lastSeen = now;
    stages.set(tab.id, stageOf(tab, rec, now));
  }

  if (settings.enabled) {
    const windowSizes = new Map<number, number>();
    for (const t of tabs) windowSizes.set(t.windowId, (windowSizes.get(t.windowId) ?? 0) + 1);

    await Promise.all(
      tabs.map(async (tab) => {
        const rec = state.records[tab.id!];
        const stage = stages.get(tab.id!);
        if (!rec || stage === undefined) return;
        await paint(tab, rec, stage, now);
        if (tab.active && settings.cobwebs && !rec.cobwebsArmed && !isProtected(tab) && !isAsleep(tab) && tab.status === 'complete') {
          // Even the tab you are on gathers webs if you stop touching it.
          const res = await send<{ ok: boolean }>(tab.id!, { type: 'haunt:cobwebs', webs: 0, growAfterMs: growAfterMs() }, true);
          if (res?.ok) rec.cobwebsArmed = true;
        }
        if (tab.active || stage < Stage.Ghost) return;
        if (settings.autoBury && stage === Stage.Entombed && (windowSizes.get(tab.windowId) ?? 0) > 1) {
          if (await isSafeToClose(tab, rec)) {
            windowSizes.set(tab.windowId, windowSizes.get(tab.windowId)! - 1);
            await bury(tab, rec, 'haunting', now);
            stages.delete(tab.id!);
            return;
          }
        }
        if (settings.autoDiscard && !tab.discarded && rec.applied >= Stage.Ghost && (await isSafeToClose(tab, rec))) {
          await discard(tab, rec);
        }
      }),
    );
  }

  if (!settings.enabled) {
    // Exorcised tabs that were frozen at the time: keep asking until they answer.
    await Promise.all(
      tabs.map(async (tab) => {
        const rec = state.records[tab.id!];
        if (!rec?.needsExorcise || isAsleep(tab)) return;
        if ((await tryClean(tab.id!, { restore: true, sweep: true })) === 'frozen') return;
        rec.applied = Stage.Alive;
        rec.appliedTitle = undefined;
        rec.cobwebsArmed = false;
        rec.needsExorcise = false;
      }),
    );
    await ensureAlarm();
  }
  syncPainted();

  const level = hauntLevel([...stages.values()]);
  const ghosts = [...stages.values()].filter((s) => s >= Stage.Ghost).length;
  await persist();
  await updateBadge(level, ghosts);
  if (settings.enabled) await maybePoltergeist(tabs, stages, level, now);
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/** Rare, harmless scares. Rate limited, and stronger as the haunt level rises. */
async function maybePoltergeist(tabs: chrome.tabs.Tab[], stages: Map<number, Stage>, level: HauntLevel, now: number): Promise<void> {
  if (!settings.poltergeist && !settings.whispers) return;
  if (now - state.lastPoltergeist < poltergeistCooldownMs(settings.thresholdMinutes)) return;
  if (Math.random() > poltergeistChance(level.index)) return;

  const restless = tabs.filter((t) => (stages.get(t.id!) ?? 0) >= Stage.Ghost && state.records[t.id!]?.applied >= Stage.Ghost);
  if (restless.length === 0) return;
  const victim = pick(restless);
  const rec = state.records[victim.id!];
  const realTitle = rec.realTitle || victim.title || 'a forgotten tab';

  const events: (() => Promise<boolean>)[] = [];
  if (settings.poltergeist && !victim.discarded) {
    events.push(async () => {
      const titles = ['👁 👁', corruptTitle(realTitle, 1, Math.floor(Math.random() * 1e9)), '…help…'];
      const res = await send<{ ok: boolean }>(victim.id!, { type: 'haunt:flicker', titles, durationMs: 2600 }, false);
      return !!res?.ok;
    });
  }
  if (settings.poltergeist && settings.possession && (stages.get(victim.id!) ?? 0) >= Stage.Dead) {
    events.push(async () => {
      const [active] = await ext.tabs.query({ active: true, lastFocusedWindow: true });
      if (!active?.id || isProtected(active)) return false;
      const message = poltergeistMessage(realTitle, rec.seed + now);
      const res = await send<{ ok: boolean }>(active.id, { type: 'haunt:glitch', message, thenRestore: false, durationMs: GLITCH_MS }, true);
      return !!res?.ok;
    });
  }
  if (settings.poltergeist && (stages.get(victim.id!) ?? 0) >= Stage.Dead) {
    // The dead reach into the tab you are on: a passing shadow, or a second cursor.
    for (const name of POLTERGEIST_EFFECTS) {
      if (!settings[name]) continue;
      events.push(async () => {
        const [active] = await ext.tabs.query({ active: true, lastFocusedWindow: true });
        if (!active?.id || isProtected(active) || isAsleep(active)) return false;
        const cmd: PageCommand = { type: 'haunt:effects', effects: [name], stage: Stage.Dead, idleMs: now - rec.lastSeen, seed: rec.seed };
        const res = await send<{ ok: boolean }>(active.id, cmd, true);
        return !!res?.ok;
      });
    }
  }
  if (settings.whispers && (await ext.permissions.contains({ permissions: ['notifications'] }))) {
    events.push(async () => {
      await ext.notifications.create(`whisper:${victim.id}:${now}`, {
        type: 'basic',
        iconUrl: ext.runtime.getURL('icons/icon128.png'),
        title: '👻 A whisper from your tabs',
        message: `“${realTitle.slice(0, 60)}” has been alone for ${spokenDuration(now - rec.lastSeen)}. It misses you.`,
      });
      return true;
    });
  }
  if (events.length === 0) return;
  if (await pick(events)()) state.lastPoltergeist = now;
  await persist();
}

const WEBS_BY_STAGE: Record<Stage, number> = {
  [Stage.Alive]: 0,
  [Stage.Withering]: 2,
  [Stage.Ghost]: 3,
  [Stage.Dead]: 5,
  [Stage.Entombed]: 7,
};
/** Page effects that greet you on return, and the stage each one starts at. */
const STAGE_EFFECTS: [EffectName, Stage][] = [
  ['dust', Stage.Withering],
  ['fog', Stage.Ghost],
  ['eyes', Stage.Dead],
  ['drips', Stage.Entombed],
];
/** Effects only a poltergeist plays, on the tab you are using. */
const POLTERGEIST_EFFECTS: EffectName[] = ['shadow', 'ghostCursor'];
const ALL_EFFECTS: EffectName[] = [...STAGE_EFFECTS.map(([name]) => name), ...POLTERGEIST_EFFECTS];

/** How long a return visit waits for a reloading tab before it is dropped. */
const RETURN_TTL = 2 * 60_000;

/** The user looked at a tab: it comes back to life, possibly not quietly. */
async function wake(tabId: number, windowId: number): Promise<void> {
  const now = Date.now();
  const previous = state.activeByWindow[windowId];
  if (previous !== undefined && state.records[previous]) state.records[previous].lastSeen = now;
  state.activeByWindow[windowId] = tabId;

  const rec = state.records[tabId];
  if (rec) {
    const idle = now - rec.lastSeen;
    rec.lastSeen = now;
    rec.safeDiscarded = false;
    const tab = await ext.tabs.get(tabId).catch(() => undefined);
    // A waking tab can briefly report about:blank (Firefox); judge it by where it really is.
    const known = tab && tab.url === 'about:blank' && rec.url ? { ...tab, url: rec.url } : tab;
    const stage =
      known && settings.enabled && !isProtected(known) ? Math.max(rec.applied, stageFor(idle, settings.thresholdMinutes)) : Stage.Alive;
    // A frozen tab is still tried: switching to it thaws it.
    const ready = !!tab && tab.status === 'complete' && !tab.discarded;
    if (!ready || !(await returnVisit(tab, rec, stage, idle))) {
      // The browser unloaded this tab to save memory and is reloading it, or the
      // page has not thawed yet. Replay the visit once a page answers (onUpdated);
      // until then anything still painted stays marked for cleanup.
      if (!tab || tab.discarded || tab.status !== 'complete') {
        rec.applied = Stage.Alive; // the old page and our paint are going away
        rec.appliedTitle = undefined;
      } else if (rec.applied !== Stage.Alive || rec.cobwebsArmed) {
        rec.needsExorcise = !settings.enabled || rec.needsExorcise;
        if (rec.needsExorcise) await ensureAlarm();
      }
      if (stage !== Stage.Alive) rec.pendingReturn = { stage, idle, at: now, url: known?.url };
    }
  }
  await persist();
}

/**
 * What greets you on a neglected tab: a possession for the dead, cobwebs for
 * anything stale. Resolves false if the page never answered, so it can be retried.
 */
async function returnVisit(tab: chrome.tabs.Tab, rec: TabRecord, stage: Stage, idle: number): Promise<boolean> {
  const tabId = tab.id!;
  let delivered = true;
  if (stage >= Stage.Dead && settings.possession) {
    if (rec.applied < Stage.Dead) {
      // A reloaded page lost its skull. Put it back for the moment of possession.
      const title = paintedTitle(tab, rec, stage, Date.now());
      await send(tabId, { type: 'haunt:apply', title, icon: await iconFor(stage as Exclude<Stage, Stage.Alive>, tab.url ?? '', rec.realFavIconUrl) }, true);
    }
    const res = await send<{ ok: boolean }>(
      tabId,
      { type: 'haunt:glitch', message: possessionMessage(idle, rec.seed), thenRestore: true, durationMs: GLITCH_MS },
      false,
    );
    delivered = !!res?.ok;
  } else {
    // Always ask: cheap when there is nothing to restore, and it catches paint
    // the records lost track of. Webs go too if they are no longer wanted.
    const webs = settings.enabled && settings.cobwebs;
    delivered = (await tryClean(tabId, { restore: true, sweep: !webs && !!rec.cobwebsArmed })) === 'done';
    if (delivered && !webs) rec.cobwebsArmed = false;
  }
  if (!delivered) return false;
  rec.applied = Stage.Alive;
  rec.appliedTitle = undefined;
  rec.needsExorcise = false;
  if (settings.enabled && settings.cobwebs && stage >= Stage.Withering) {
    const res = await send<{ ok: boolean }>(tabId, { type: 'haunt:cobwebs', webs: WEBS_BY_STAGE[stage], growAfterMs: growAfterMs() }, true);
    if (res?.ok) rec.cobwebsArmed = true;
    delivered = !!res?.ok;
  }
  const effects = settings.enabled ? STAGE_EFFECTS.filter(([name, from]) => settings[name] && stage >= from).map(([name]) => name) : [];
  if (effects.length) {
    const res = await send<{ ok: boolean }>(tabId, { type: 'haunt:effects', effects, stage, idleMs: idle, seed: rec.seed }, true);
    delivered &&= !!res?.ok;
  }
  if (delivered) {
    rec.pendingReturn = undefined;
    if (stage !== Stage.Alive) rec.lastReturn = { stage, idle, at: Date.now() };
  }
  return delivered;
}

/** The page you are on gathers a new web after sitting untouched this long. */
function growAfterMs(): number {
  return settings.thresholdMinutes * 60_000;
}

async function ensureAlarm(): Promise<void> {
  const cleanupsLeft = Object.values(state.records).some((r) => r.needsExorcise);
  if (settings.enabled || cleanupsLeft) {
    if (!(await ext.alarms.get(TICK_ALARM))) await ext.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
  } else {
    await ext.alarms.clear(TICK_ALARM);
  }
}

/** Turn every haunting off at once and give every tab back its real face. */
async function exorcise(): Promise<void> {
  settings = { ...settings, enabled: false };
  await saveSettings(settings);
  const tabs = await ext.tabs.query({});
  const now = Date.now();
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      // recordFor also recognises tabs restored after a restart still wearing paint.
      const rec = recordFor(tab, now);
      rec.pendingReturn = undefined;
      rec.safeDiscarded = false;
      if (tab.discarded) {
        // A sleeping tab still shows its ghostly title; waking it loads the real page.
        if (rec.applied !== Stage.Alive) await ext.tabs.reload(tab.id).catch(() => {});
      } else if ((await tryClean(tab.id, { restore: true, sweep: true })) === 'frozen') {
        // Frozen pages cannot answer yet. Keep them marked; tick keeps asking.
        if (rec.applied !== Stage.Alive || rec.cobwebsArmed) rec.needsExorcise = true;
        return;
      }
      rec.applied = Stage.Alive;
      rec.appliedTitle = undefined;
      rec.cobwebsArmed = false;
      rec.needsExorcise = false;
    }),
  );
  syncPainted();
  await ensureAlarm();
  await persist();
  await updateBadge(hauntLevel([]), 0);
}

async function setSettings(patch: Partial<Settings>): Promise<void> {
  state.pendingPermission = undefined;
  const wasEnabled = settings.enabled;
  if (patch.enabled === false && wasEnabled) {
    await exorcise();
    return;
  }
  settings = { ...settings, ...patch };
  await saveSettings(settings);
  const switchedOff = ALL_EFFECTS.filter((name) => patch[name] === false);
  if (switchedOff.length) {
    const tabs = await ext.tabs.query({});
    await Promise.all(tabs.map((t) => send(t.id!, { type: 'haunt:stopEffects', effects: switchedOff }, false)));
  }
  if (patch.cobwebs === false) {
    const tabs = await ext.tabs.query({});
    await Promise.all(
      tabs.map(async (t) => {
        const rec = state.records[t.id!];
        // A frozen page keeps its mark, so returning to it sweeps the webs then.
        if ((await tryClean(t.id!, { sweep: true })) === 'done' && rec) rec.cobwebsArmed = false;
      }),
    );
  }
  await ensureAlarm();
  await tick();
}

async function snapshot(): Promise<Snapshot> {
  const now = Date.now();
  const tabs = await ext.tabs.query({});
  const views: TabView[] = [];
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const rec = recordFor(tab, now);
    if (tab.active) rec.lastSeen = now;
    views.push({
      id: tab.id,
      windowId: tab.windowId,
      index: tab.index,
      title: (rec.applied === Stage.Alive ? tab.title : rec.realTitle) || tab.url || 'Untitled',
      url: tab.url ?? tab.pendingUrl ?? '',
      favIconUrl: rec.applied === Stage.Alive && !isOurIcon(tab.favIconUrl) ? tab.favIconUrl : rec.realFavIconUrl,
      idleMs: tab.active ? 0 : now - rec.lastSeen,
      stage: stageOf(tab, rec, now),
      active: !!tab.active,
      pinned: !!tab.pinned,
      audible: !!tab.audible,
      discarded: !!tab.discarded,
      hauntable: isHauntableUrl(tab.url),
    });
  }
  const focused = await ext.windows.getLastFocused().catch(() => undefined);
  return {
    settings,
    level: hauntLevel(views.map((v) => v.stage)),
    tabs: views,
    focusedWindowId: focused?.id,
    graveCount: (await loadGraves()).length,
    hostPermission: await hasHostAccess(),
  };
}

async function handle(req: PopupRequest): Promise<unknown> {
  switch (req.type) {
    case 'snapshot':
      return snapshot();
    case 'setSettings':
      await setSettings(req.settings);
      return snapshot();
    case 'exorcise':
      await exorcise();
      return snapshot();
    case 'armPermission':
      state.pendingPermission = { settings: req.settings, at: Date.now() };
      await persist();
      return { ok: true };
    case 'switch': {
      const tab = await ext.tabs.update(req.tabId, { active: true });
      if (tab?.windowId !== undefined) await ext.windows.update(tab.windowId, { focused: true });
      return { ok: true };
    }
    case 'bury': {
      const tab = await ext.tabs.get(req.tabId);
      await bury(tab, recordFor(tab, Date.now()), 'you', Date.now());
      await persist();
      return { ok: true };
    }
    case 'discard': {
      const tab = await ext.tabs.get(req.tabId);
      const rec = recordFor(tab, Date.now());
      if (tab.active) return { ok: false, reason: 'You are looking at that tab.' };
      if (!(await isSafeToClose(tab, rec))) return { ok: false, reason: 'That tab has unsaved input or cannot be checked, so it stays awake.' };
      await discard(tab, rec);
      await persist();
      return { ok: true };
    }
  }
}

// --- wiring -----------------------------------------------------------------

ext.runtime.onMessage.addListener((msg: PopupRequest | PageEvent, sender, sendResponse) => {
  if (sender.id !== ext.runtime.id) return;
  if (msg.type === 'haunt:realTitle') {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      locked(async () => {
        const rec = state.records[tabId];
        if (rec) rec.realTitle = msg.title;
        await persist();
      });
    }
    return;
  }
  // Popup requests are only accepted from the extension's own pages.
  if (!sender.url?.startsWith(ext.runtime.getURL(''))) return;
  locked(() => handle(msg)).then(sendResponse, (err) => sendResponse({ error: String(err) }));
  return true;
});

ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TICK_ALARM) return;
  locked(tick);
  // Alarms fire at most every 30s. Short demo thresholds get extra ticks while the worker is awake.
  if (settings?.thresholdMinutes <= 2) {
    setTimeout(() => locked(tick), 10_000);
    setTimeout(() => locked(tick), 20_000);
  }
});

ext.tabs.onActivated.addListener(({ tabId, windowId }) => {
  locked(() => wake(tabId, windowId));
});

ext.tabs.onRemoved.addListener((tabId) => {
  locked(async () => {
    delete state.records[tabId];
    await persist();
  });
});

ext.tabs.onReplaced.addListener((added, removed) => {
  locked(async () => {
    if (state.records[removed]) state.records[added] = state.records[removed];
    delete state.records[removed];
    await persist();
  });
});

ext.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!info.status && info.audible === undefined && info.pinned === undefined) return;
  locked(async () => {
    const rec = state.records[tabId];
    if (!rec) return;
    if (info.status === 'loading') {
      // The old page is being replaced, and our paint and webs go with it.
      rec.applied = Stage.Alive;
      rec.appliedTitle = undefined;
      rec.cobwebsArmed = false;
      rec.needsExorcise = false;
      // Firefox wakes an unloaded tab as a placeholder first and only then really
      // reloads it, wiping a visit that has only just played. Play it again.
      const last = rec.lastReturn;
      if (tab.active && last && !rec.pendingReturn && Date.now() - last.at < 5000) {
        rec.pendingReturn = { ...last, at: Date.now(), url: rec.url };
        rec.lastReturn = undefined;
      }
    }
    if (!settings.enabled) {
      await persist();
      return;
    }
    if (info.audible || info.pinned) {
      // Never haunt a tab that is playing sound or has been pinned: no paint, no webs.
      await restoreTab(tabId, rec, true);
    } else if (info.status === 'complete' && rec.pendingReturn && tab.active) {
      // A tab the browser had unloaded has finished reloading: now it can greet you.
      const { stage, idle, at, url } = rec.pendingReturn;
      // The visit belongs to the page it was queued for. Navigated elsewhere? Drop it.
      // Otherwise keep it queued if nobody answered; the next load gets another try.
      const stale = Date.now() - at > RETURN_TTL || (url !== undefined && tab.url !== url);
      if (stale || (await returnVisit(tab, rec, stage, idle))) rec.pendingReturn = undefined;
    } else if (info.status === 'complete' && !tab.active) {
      // A background page (re)loaded without our paint. Put back what it has earned.
      await paint(tab, rec, stageOf(tab, rec, Date.now()), Date.now());
    }
    await persist();
  });
});

// ext.notifications only exists once the optional permission is granted.
let whispersWired = false;
function wireWhispers(): void {
  if (whispersWired || !ext.notifications) return;
  whispersWired = true;
  ext.notifications.onClicked.addListener((id) => {
    const match = /^whisper:(\d+):/.exec(id);
    ext.notifications.clear(id);
    if (match) locked(() => handle({ type: 'switch', tabId: Number(match[1]) })).catch(() => {});
  });
}
wireWhispers();

const PERMISSION_PROMPT_TTL = 2 * 60_000;

ext.permissions.onAdded.addListener(() => {
  wireWhispers();
  locked(async () => {
    const pending = state.pendingPermission;
    if (!pending || Date.now() - pending.at > PERMISSION_PROMPT_TTL) return;
    const ready =
      (!pending.settings.enabled || (await hasHostAccess())) &&
      (!pending.settings.whispers || (await ext.permissions.contains({ permissions: ['notifications'] })));
    if (ready) await setSettings(pending.settings);
  });
});

ext.runtime.onInstalled.addListener(() => locked(ensureAlarm));
ext.runtime.onStartup.addListener(() => locked(ensureAlarm));
