import { DEFAULT_SETTINGS, type Grave, type Settings } from './types';

const SETTINGS_KEY = 'settings';
const GRAVEYARD_KEY = 'graveyard';

export async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] as Partial<Settings> | undefined) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function loadGraves(): Promise<Grave[]> {
  const got = await chrome.storage.local.get(GRAVEYARD_KEY);
  return (got[GRAVEYARD_KEY] as Grave[] | undefined) ?? [];
}

export async function saveGraves(graves: Grave[]): Promise<void> {
  await chrome.storage.local.set({ [GRAVEYARD_KEY]: graves });
}

export function onGravesChanged(cb: (graves: Grave[]) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[GRAVEYARD_KEY]) cb((changes[GRAVEYARD_KEY].newValue as Grave[] | undefined) ?? []);
  });
}
