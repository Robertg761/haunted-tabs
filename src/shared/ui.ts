import { Stage } from './types';
import { ext, hasFaviconCache } from './ext';

export const STAGE_EMOJI: Record<Stage, string> = {
  [Stage.Alive]: '',
  [Stage.Withering]: '🥀',
  [Stage.Ghost]: '👻',
  [Stage.Dead]: '💀',
  [Stage.Entombed]: '⚰️',
};

const GENERIC_ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="#9a90b3" stroke-width="1.3"/><path d="M1.5 8h13M8 1.5c-3 3.5-3 9.5 0 13M8 1.5c3 3.5 3 9.5 0 13" fill="none" stroke="#9a90b3" stroke-width="1"/></svg>',
  );

/**
 * A favicon that never touches the network. Chrome serves it from its local
 * cache; elsewhere only icons already held as data: URLs are shown, and other
 * pages get a plain globe.
 */
export function faviconUrl(pageUrl: string, iconUrl?: string): string {
  if (hasFaviconCache()) return ext.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=32`);
  return iconUrl?.startsWith('data:image/') ? iconUrl : GENERIC_ICON;
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
  const url = ext.runtime.getURL('graveyard/index.html');
  // Filtered by hand: Firefox does not accept moz-extension:// URLs as query patterns.
  const existing = (await ext.tabs.query({})).find((t) => t.url === url);
  if (existing?.id !== undefined) {
    await ext.tabs.update(existing.id, { active: true });
    await ext.windows.update(existing.windowId, { focused: true });
  } else {
    await ext.tabs.create({ url });
  }
}
