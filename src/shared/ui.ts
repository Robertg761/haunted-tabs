import { Stage } from './types';

export const STAGE_EMOJI: Record<Stage, string> = {
  [Stage.Alive]: '',
  [Stage.Withering]: '🥀',
  [Stage.Ghost]: '👻',
  [Stage.Dead]: '💀',
  [Stage.Entombed]: '⚰️',
};

/** Favicon from the browser's local cache, so extension pages never hit the network. */
export function faviconUrl(pageUrl: string): string {
  return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=32`);
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

export async function openGraveyard(): Promise<void> {
  const url = chrome.runtime.getURL('graveyard/index.html');
  const [existing] = await chrome.tabs.query({ url });
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}
