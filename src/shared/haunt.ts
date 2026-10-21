import { Stage, type HauntLevel } from './types';

const MINUTE = 60_000;

/** Stage n starts once a tab has been idle for STAGE_MULTIPLIERS[n] x threshold. */
export const STAGE_MULTIPLIERS = [0, 1, 2, 4, 8] as const;

export const STAGE_NAMES: Record<Stage, string> = {
  [Stage.Alive]: 'alive',
  [Stage.Withering]: 'withering',
  [Stage.Ghost]: 'ghost',
  [Stage.Dead]: 'dead',
  [Stage.Entombed]: 'entombed',
};

export function stageFor(idleMs: number, thresholdMinutes: number): Stage {
  const t = Math.max(thresholdMinutes, 0.1) * MINUTE;
  for (let s = Stage.Entombed; s > Stage.Alive; s--) {
    if (idleMs >= STAGE_MULTIPLIERS[s] * t) return s;
  }
  return Stage.Alive;
}

/** How far a tab is through its current stage, 0..1. */
export function stageProgress(idleMs: number, thresholdMinutes: number): number {
  const stage = stageFor(idleMs, thresholdMinutes);
  if (stage === Stage.Entombed) return 1;
  const t = Math.max(thresholdMinutes, 0.1) * MINUTE;
  const start = STAGE_MULTIPLIERS[stage] * t;
  const end = STAGE_MULTIPLIERS[stage + 1] * t;
  return Math.min(1, Math.max(0, (idleMs - start) / (end - start)));
}

/** A tick alarm running this late means the computer slept or the browser was closed. */
export const SLEEP_GAP_MS = 3 * MINUTE;

/**
 * How long the computer slept, judged by the periodic tick alarm. After a sleep
 * it fires once, late, still carrying the time it was due, and the browser has
 * already set its next run after the wake. Both times come from the browser's
 * own clock. Ordinary scheduling jitter counts as no sleep at all.
 */
export function sleptMs(dueAt: number, nextAt: number, periodMs: number): number {
  const late = nextAt - dueAt - periodMs;
  return late > SLEEP_GAP_MS ? late : 0;
}

/**
 * Nobody could use the browser for `ms` from `from`: a tab last seen before then
 * ages that much less. `from` is the last heartbeat, so the browser may still have
 * been used for a few seconds after it; a tab seen in the gap counts as seen when
 * the browser came back.
 */
export function skipDowntime(lastSeen: number, from: number, ms: number, now: number): number {
  if (lastSeen < from) return Math.min(lastSeen + ms, now);
  if (lastSeen < from + ms) return Math.min(from + ms, now);
  return lastSeen;
}

// Mozilla sites Firefox never lets extensions script.
const FIREFOX_RESTRICTED = new Set([
  'accounts-static.cdn.mozilla.net',
  'accounts.firefox.com',
  'addons.cdn.mozilla.net',
  'addons.mozilla.org',
  'api.accounts.firefox.com',
  'content.cdn.mozilla.net',
  'discovery.addons.mozilla.org',
  'install.mozilla.org',
  'oauth.accounts.firefox.com',
  'profile.accounts.firefox.com',
  'support.mozilla.org',
  'sync.services.mozilla.com',
]);

/** Pages an extension may not script, or that we refuse to haunt. */
export function isHauntableUrl(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:') return false;
  const host = parsed.hostname;
  if (host === 'chromewebstore.google.com' || FIREFOX_RESTRICTED.has(host)) return false;
  if (host === 'chrome.google.com' && parsed.pathname.startsWith('/webstore')) return false;
  return true;
}

export function siteName(url: string | undefined): string {
  if (!url) return 'nowhere';
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return safeDecode(u.pathname.split('/').pop() ?? '') || 'a file';
    if (u.protocol === 'chrome-extension:' || u.protocol === 'moz-extension:') return 'extension page';
    // about:blank, data:, blob: have no host to name.
    if (!u.hostname) return u.protocol === 'about:' ? `about:${u.pathname}` : u.protocol.slice(0, -1);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${u.protocol}//${u.hostname}`;
    return u.hostname.replace(/^www\./, '') || u.protocol.replace(':', '');
  } catch {
    return 'nowhere';
  }
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function formatIdle(ms: number): string {
  // A clock set backwards can leave a tab "seen" in the future.
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Coarse, spoken-style duration for eerie messages: "3 hours", "a minute". */
export function spokenDuration(ms: number): string {
  const units: [number, string][] = [
    [24 * 60 * MINUTE, 'day'],
    [60 * MINUTE, 'hour'],
    [MINUTE, 'minute'],
  ];
  for (const [size, name] of units) {
    const n = Math.floor(ms / size);
    if (n >= 1) return n === 1 ? `a${name === 'hour' ? 'n' : ''} ${name}` : `${n} ${name}s`;
  }
  return 'moments';
}

/** Small deterministic PRNG so each tab keeps the same haunting between ticks. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOOKALIKES: Record<string, string> = {
  a: 'ɑ', c: 'ϲ', d: 'ԁ', e: 'ҽ', g: 'ɡ', h: 'һ', i: 'ı', j: 'ϳ', l: 'ӏ', n: 'ռ', o: 'ø', p: 'ρ', r: 'ɾ',
  s: 'ʂ', t: 'ŧ', u: 'υ', w: 'ω', y: 'ỿ', A: 'Λ', B: 'ß', E: 'Ξ', H: 'Ħ', I: 'ł', N: 'И', O: 'Ø', R: 'Я',
  S: 'Ƨ', T: 'Ŧ', U: 'Ʉ', W: 'Ш', Y: '¥',
};
const MARKS = ['̴', '̵', '̷', '̸', '̖', '̗', '̀', '́'];

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined;

/** Split text into what a reader sees as single characters: emoji, accents and Indic clusters stay whole. */
function graphemes(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
}

/**
 * Rot a title: swap letters for lookalikes and sprinkle combining marks.
 * The same seed rots the same letters first, so higher intensity only adds rot.
 * Marks go after whole characters, so emoji sequences and accented letters never split.
 */
export function corruptTitle(title: string, intensity: number, seed: number): string {
  const rand = rng(seed);
  const chars = graphemes(title);
  const rottable = (ch: string) => /\S/.test(ch) && !/\p{Extended_Pictographic}/u.test(ch);
  let spots = chars.flatMap((ch, i) => (rottable(ch) ? [i] : []));
  // A title of nothing but emoji still has to rot somehow.
  if (spots.length === 0) spots = chars.flatMap((ch, i) => (/\S/.test(ch) ? [i] : []));
  for (let i = spots.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [spots[i], spots[j]] = [spots[j], spots[i]];
  }
  const count = intensity <= 0 ? 0 : Math.max(1, Math.round(spots.length * Math.min(1, intensity) * 0.4));
  for (const i of spots.slice(0, count)) {
    const ch = chars[i];
    const mark = MARKS[Math.floor(rand() * MARKS.length)];
    chars[i] = LOOKALIKES[ch] ? LOOKALIKES[ch] + (rand() < 0.3 ? mark : '') : ch + mark;
  }
  return chars.join('');
}

/** Collapse whitespace and cut to `max` characters, never through the middle of one. */
export function shorten(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const chars = graphemes(clean);
  if (chars.length <= max) return clean;
  return chars.slice(0, max - 1).join('').trimEnd() + '…';
}

/**
 * Fill a line's {placeholders}. Replacer functions keep a "$&" or "$1" in a
 * title literal, and a title cut short does not end up with a double ellipsis.
 */
function fill(line: string, values: Record<string, string>): string {
  return line.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match).replace(/……/g, '…');
}

const GHOST_LINES = [
  '👻 {short}… is anyone there?',
  '👻 You forgot me on {site}',
  "👻 It's so cold in this tab",
  "👻 I'm still here. I'm always here.",
  '👻 Why did you leave {site}?',
  '👻 come back… come back…',
  '👻 {short} (abandoned)',
  '👻 I waited {idle} for you',
  '👻 I can hear you breathing',
  "👻 Don't close me. Please.",
];

const DEAD_LINES = [
  '💀 Here lies {short}',
  '💀 {site} has died',
  '💀 Dead for {idle}',
  "💀 Don't look behind you",
  '💀 I can see your other tabs',
  '💀 You let me rot',
  '💀 {short} is not breathing',
  '💀 It has been {idle}',
  '💀 Something is wearing {site}',
  '💀 Who closed my eyes?',
];

const TOMB_LINES = [
  '⚰️ {short} awaits burial',
  '⚰️ The grave for {site} is dug',
  '⚰️ R.I.P. {short}',
  '⚰️ Forgotten {idle} ago',
  '⚰️ Buried alive in {site}',
  '⚰️ Let me out',
];

export interface TitleInput {
  stage: Stage;
  realTitle: string;
  url: string;
  idleMs: number;
  thresholdMinutes: number;
  seed: number;
}

/** The title a tab shows at its current stage of decay. */
export function hauntedTitle({ stage, realTitle, url, idleMs, thresholdMinutes, seed }: TitleInput): string {
  const title = realTitle.trim() || siteName(url);
  if (stage === Stage.Alive) return realTitle;
  if (stage === Stage.Withering) {
    // Quantised so the title rots in a few visible steps instead of every tick.
    const steps = Math.max(1, Math.ceil(stageProgress(idleMs, thresholdMinutes) * 4));
    return corruptTitle(title, steps / 4, seed);
  }
  const lines = stage === Stage.Ghost ? GHOST_LINES : stage === Stage.Dead ? DEAD_LINES : TOMB_LINES;
  const line = lines[Math.floor(rng(seed + stage)() * lines.length)];
  return fill(line, { short: shorten(title, 28), site: siteName(url), idle: spokenDuration(idleMs) });
}

const POSSESSION_LINES = [
  'YOU CAME BACK',
  'I WAITED {idle}',
  'DID YOU MISS ME?',
  'TOO LATE',
  'IT IS COLD IN HERE',
  'WHERE WERE YOU?',
  "DON'T LEAVE ME AGAIN",
  'I SAW YOUR OTHER TABS',
];

/** The message flashed on screen when a dead tab possesses it. */
export function possessionMessage(idleMs: number, seed: number): string {
  const line = POSSESSION_LINES[Math.floor(rng(seed ^ 0x5eed)() * POSSESSION_LINES.length)];
  return fill(line, { idle: spokenDuration(idleMs).toUpperCase() });
}

const POLTERGEIST_LINES = [
  '{t} WANTS YOU BACK',
  '{t} IS STILL OPEN',
  'SOMETHING IN {t} MOVED',
  '{t} REMEMBERS YOU',
  '{t} IS WATCHING',
];

/** The message a dead tab glitches into the tab you are using. */
export function poltergeistMessage(deadTitle: string, seed: number): string {
  const line = POLTERGEIST_LINES[Math.floor(rng(seed ^ 0xb00)() * POLTERGEIST_LINES.length)];
  return fill(line, { t: `“${shorten(deadTitle, 32).toUpperCase()}”` });
}

const WHISPER_TITLES = ['👻 A whisper from your tabs', '👻 Did you hear that?', '👻 Something in your tabs is calling'];
const WHISPER_LINES = [
  '“{t}” has been alone for {idle}. It misses you.',
  '“{t}” has waited {idle} for you. It is still waiting.',
  'Something moved in “{t}”. You left it {idle} ago.',
  '“{t}” keeps saying your name.',
];

/** A whisper notification about a forgotten tab. */
export function whisperMessage(title: string, idleMs: number, seed: number): { title: string; message: string } {
  const rand = rng(seed ^ 0x3157);
  return {
    title: WHISPER_TITLES[Math.floor(rand() * WHISPER_TITLES.length)],
    message: fill(WHISPER_LINES[Math.floor(rand() * WHISPER_LINES.length)], { t: shorten(title, 60), idle: spokenDuration(idleMs) }),
  };
}

const STAGE_WEIGHT = [0, 1, 2.5, 4, 6];
const LEVELS: { name: string; blurb: string; min: number }[] = [
  { name: 'Peaceful', blurb: 'Your tabs rest easy.', min: 0 },
  { name: 'Uneasy', blurb: 'Something stirs in the tab strip.', min: 2 },
  { name: 'Haunted', blurb: 'Neglected tabs have started to turn.', min: 6 },
  { name: 'Possessed', blurb: 'The dead are restless. Expect visitors.', min: 14 },
  { name: 'Damned', blurb: 'Your browser belongs to them now.', min: 28 },
];
const LEVEL_MAX = 40;

/** Haunt level: more tabs and older tabs make the haunting stronger. */
export function hauntLevel(stages: Stage[]): HauntLevel {
  const decay = stages.reduce((sum, s) => sum + STAGE_WEIGHT[s], 0);
  const crowding = Math.max(0, stages.length - 8) * 0.5;
  const score = decay + crowding;
  let index = 0;
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (score >= LEVELS[i].min) {
      index = i;
      break;
    }
  }
  return { index, name: LEVELS[index].name, blurb: LEVELS[index].blurb, score, pct: Math.min(1, score / LEVEL_MAX) };
}

/** Minimum gap between poltergeist events, scaled down with short demo thresholds. */
export function poltergeistCooldownMs(thresholdMinutes: number): number {
  return Math.min(20, Math.max(1, thresholdMinutes / 2)) * MINUTE;
}

/** Chance per tick of a poltergeist event once the cooldown has passed. */
export function poltergeistChance(levelIndex: number): number {
  return Math.min(0.8, 0.15 + 0.15 * levelIndex);
}
