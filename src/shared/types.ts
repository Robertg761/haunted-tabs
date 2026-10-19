/** Decay stages. Each one starts at a multiple of the idle threshold. */
export enum Stage {
  Alive = 0,
  Withering = 1,
  Ghost = 2,
  Dead = 3,
  Entombed = 4,
}

export interface Settings {
  /** Master switch. Off until the user opts in from the popup. */
  enabled: boolean;
  /** Idle time before a tab starts to wither. Later stages are multiples of it. */
  thresholdMinutes: number;
  /** Play the glitch effect when you return to a dead tab. */
  possession: boolean;
  /** Small rate-limited scares: title flickers and dead tabs possessing the screen. */
  poltergeist: boolean;
  /** Notifications about forgotten tabs. Needs the optional notifications permission. */
  whispers: boolean;
  /** Neglected pages gather cobwebs that scrolling or sweeping the mouse tears away. */
  cobwebs: boolean;
  /** Discard ghost tabs to free memory. */
  autoDiscard: boolean;
  /** Close entombed tabs and move them to the Graveyard. */
  autoBury: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: false,
  thresholdMinutes: 30,
  possession: true,
  poltergeist: true,
  whispers: false,
  cobwebs: true,
  autoDiscard: false,
  autoBury: false,
};

/** What the background remembers about each open tab (kept in storage.session). */
export interface TabRecord {
  lastSeen: number;
  /** Last real URL seen, for moments when a waking tab reports about:blank. */
  url?: string;
  /** Stage currently painted onto the page. */
  applied: Stage;
  appliedTitle?: string;
  realTitle?: string;
  realFavIconUrl?: string;
  /** Set when we discarded the tab after checking it had no unsaved input. */
  safeDiscarded?: boolean;
  /** Still painted after an Exorcise because the page was frozen; retried until it answers. */
  needsExorcise?: boolean;
  /** Cobweb growth is running in the current page. */
  cobwebsArmed?: boolean;
  /** A return visit to replay once a tab the browser unloaded has reloaded. */
  pendingReturn?: { stage: Stage; idle: number; at: number };
  /** The visit that just played, in case the page reloads straight after. */
  lastReturn?: { stage: Stage; idle: number; at: number };
  seed: number;
}

export interface Grave {
  id: string;
  url: string;
  title: string;
  favIconUrl?: string;
  diedAt: number;
  idleMs: number;
  cause: 'haunting' | 'you';
}

export interface TabView {
  id: number;
  windowId: number;
  index: number;
  title: string;
  url: string;
  favIconUrl?: string;
  idleMs: number;
  stage: Stage;
  active: boolean;
  pinned: boolean;
  audible: boolean;
  discarded: boolean;
  /** False for pages the extension cannot touch (chrome://, the Web Store, ...). */
  hauntable: boolean;
}

export interface HauntLevel {
  index: number;
  name: string;
  blurb: string;
  score: number;
  /** 0..1, for the meter. */
  pct: number;
}

export interface Snapshot {
  settings: Settings;
  level: HauntLevel;
  tabs: TabView[];
  focusedWindowId?: number;
  graveCount: number;
  /** Whether the user granted access to repaint pages. */
  hostPermission: boolean;
}

export type PopupRequest =
  | { type: 'snapshot' }
  | { type: 'setSettings'; settings: Partial<Settings> }
  | { type: 'exorcise' }
  | { type: 'bury'; tabId: number }
  | { type: 'discard'; tabId: number }
  | { type: 'switch'; tabId: number }
  /** Sent while a permission prompt is open: apply these settings once it is granted. */
  | { type: 'armPermission'; settings: Partial<Settings> };

/** Messages the background sends to the content script inside a page. */
export type PageCommand =
  | { type: 'haunt:ping' }
  | { type: 'haunt:apply'; title: string; icon: string }
  | { type: 'haunt:restore' }
  | { type: 'haunt:glitch'; message: string; thenRestore: boolean; durationMs: number }
  | { type: 'haunt:flicker'; titles: string[]; durationMs: number }
  | { type: 'haunt:dirty' }
  /** Lay `webs` cobwebs now, and keep weaving more after `growAfterMs` without activity. */
  | { type: 'haunt:cobwebs'; webs: number; growAfterMs: number }
  | { type: 'haunt:sweep' };

export type PageEvent = { type: 'haunt:realTitle'; title: string };
