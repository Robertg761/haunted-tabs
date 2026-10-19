import { DEFAULT_SETTINGS, type Grave, type Settings } from './types';
import { ext } from './ext';

const SETTINGS_KEY = 'settings';
const GRAVEYARD_KEY = 'graveyard';

export async function loadSettings(): Promise<Settings> {
  const got = await ext.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] as Partial<Settings> | undefined) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await ext.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function loadGraves(): Promise<Grave[]> {
  const got = await ext.storage.local.get(GRAVEYARD_KEY);
  return (got[GRAVEYARD_KEY] as Grave[] | undefined) ?? [];
}

export async function saveGraves(graves: Grave[]): Promise<void> {
  await ext.storage.local.set({ [GRAVEYARD_KEY]: graves });
}

export function onGravesChanged(cb: (graves: Grave[]) => void): void {
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[GRAVEYARD_KEY]) cb((changes[GRAVEYARD_KEY].newValue as Grave[] | undefined) ?? []);
  });
}
