import { Stage } from '../shared/types';

/**
 * Hand-drawn line icons for the popup, on a 24px grid. They inherit the text
 * colour, so each stage can tint its own icon.
 */
const PATHS = {
  candle:
    '<path d="M12 3.2c1.7 1.9 2.2 3.2 2.2 4.2a2.2 2.2 0 0 1-4.4 0c0-1 .5-2.3 2.2-4.2z" fill="currentColor" stroke="none"/><rect x="9.5" y="11" width="5" height="9.5" rx="1.2"/><path d="M7 20.5h10"/>',
  wither:
    '<path d="M7.5 21c-.3-5.6 1-9.6 4.6-12 2.6-1.7 5.5-1 6.3 1.6"/><path d="M16 11.2c-.5 2.1.4 4.3 2.4 5 2-.7 2.9-2.9 2.4-5-1.1-.9-3.7-.9-4.8 0z" fill="currentColor" fill-opacity=".25"/><path d="M8.3 15.3c-2-.2-3.6-1.5-4.2-3.4 2.1 0 3.7 1.1 4.2 3.4z"/><path d="M14.2 19.4c.8-.5 1.9-.3 2.4.4-.8.5-1.9.3-2.4-.4z" fill="currentColor"/>',
  ghost:
    '<path d="M12 3a6.6 6.6 0 0 0-6.6 6.6v10.6l2.2-1.7 2.2 1.7 2.2-1.7 2.2 1.7 2.2-1.7 2.2 1.7V9.6A6.6 6.6 0 0 0 12 3z" fill="currentColor" fill-opacity=".14"/><circle cx="9.6" cy="10.2" r="1.25" fill="currentColor" stroke="none"/><circle cx="14.4" cy="10.2" r="1.25" fill="currentColor" stroke="none"/><path d="M10.8 14c.8.5 1.6.5 2.4 0"/>',
  skull:
    '<path d="M12 3a7.6 7.6 0 0 0-7.6 7.6c0 2.6 1.3 4.5 3.1 5.6V19a1.3 1.3 0 0 0 1.3 1.3h6.4a1.3 1.3 0 0 0 1.3-1.3v-2.8c1.8-1.1 3.1-3 3.1-5.6A7.6 7.6 0 0 0 12 3z" fill="currentColor" fill-opacity=".14"/><circle cx="9" cy="11" r="1.7" fill="currentColor" stroke="none"/><circle cx="15" cy="11" r="1.7" fill="currentColor" stroke="none"/><path d="M12 13.6l-.9 1.8h1.8z" fill="currentColor" stroke="none"/><path d="M10.5 17.6v2.6M13.5 17.6v2.6"/>',
  coffin:
    '<path d="M9 2.6h6l3.1 5.2-2.1 13.6H8L5.9 7.8z" fill="currentColor" fill-opacity=".14"/><path d="M12 7.4v7.4M9.5 9.9h5"/>',
  tomb:
    '<path d="M6 20.5V10a6 6 0 0 1 12 0v10.5" fill="currentColor" fill-opacity=".12"/><path d="M3.5 20.5h17M12 8.5v6M9.6 10.9h4.8"/>',
  shovel:
    '<g transform="rotate(40 12 12)"><path d="M9.6 2.6h4.8M12 2.6v9"/><path d="M8.4 11.6h7.2v4.6a3.6 3.6 0 0 1-7.2 0z" fill="currentColor" fill-opacity=".18"/></g>',
  moon:
    '<path d="M19.5 14.6A7.6 7.6 0 0 1 9.4 4.5a7.6 7.6 0 1 0 10.1 10.1z" fill="currentColor" fill-opacity=".14"/><path d="M15 3.5h3.2L15 6.7h3.2"/>',
  pin: '<path d="M9.2 3.5h5.6l-.9 5.6 3 3.1H7.1l3-3.1z" fill="currentColor" fill-opacity=".14"/><path d="M12 12.2v8.3"/>',
  sound:
    '<path d="M4 9.6h3.4L12 5.6v12.8l-4.6-4H4z" fill="currentColor" fill-opacity=".14"/><path d="M15.4 9.2a4 4 0 0 1 0 5.6M17.9 6.7a7.5 7.5 0 0 1 0 10.6"/>',
  shield:
    '<path d="M12 3.2l7 2.8v5.2c0 4.4-3 7.9-7 9.6-4-1.7-7-5.2-7-9.6V6z" fill="currentColor" fill-opacity=".12"/><path d="M9.3 12l1.9 1.9 3.6-3.8"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="M15.6 15.6l4.9 4.9"/>',
  sliders:
    '<path d="M4 7h8.5M17.5 7H20M4 17h2.5M11.5 17H20"/><circle cx="15" cy="7" r="2.5"/><circle cx="9" cy="17" r="2.5"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  cross:
    '<path d="M12 3.5v17M7.2 8.6h9.6"/><path d="M4.6 4.6l1.3 1.3M19.4 4.6l-1.3 1.3M3.6 12.6h1.6M18.8 12.6h1.6" stroke-opacity=".55"/>',
  lantern:
    '<path d="M9.5 4.5h5M12 2.8v1.7"/><path d="M8 7.3c0-1.5 1.3-2.8 2.8-2.8h2.4C14.7 4.5 16 5.8 16 7.3v9.6c0 1.5-1.3 2.8-2.8 2.8h-2.4c-1.5 0-2.8-1.3-2.8-2.8z" fill="currentColor" fill-opacity=".12"/><path d="M12 9.4c1.2 1.3 1.5 2.2 1.5 2.9a1.5 1.5 0 0 1-3 0c0-.7.3-1.6 1.5-2.9z" fill="currentColor" stroke="none"/><path d="M9.5 21.2h5"/>',
  window: '<rect x="3.5" y="5" width="17" height="14" rx="2.2"/><path d="M3.5 9h17"/><circle cx="6.4" cy="7" r=".6" fill="currentColor"/>',
  globe:
    '<circle cx="12" cy="12" r="8.2"/><path d="M3.8 12h16.4M12 3.8c-3 3.6-3 12.8 0 16.4M12 3.8c3 3.6 3 12.8 0 16.4"/>',
  hourglass:
    '<path d="M6.5 3.5h11M6.5 20.5h11"/><path d="M7.8 3.5c0 4.5 4.2 5.4 4.2 8.5s-4.2 4-4.2 8.5M16.2 3.5c0 4.5-4.2 5.4-4.2 8.5s4.2 4 4.2 8.5"/><path d="M9.6 18.6c.8-1.6 4-1.6 4.8 0z" fill="currentColor" stroke="none"/>',
  sparkle: '<path d="M12 3.5l1.6 5.4 5.4 1.6-5.4 1.6L12 17.5l-1.6-5.4L5 10.5l5.4-1.6z" fill="currentColor" fill-opacity=".2"/><path d="M18.5 16.5l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6z" fill="currentColor" stroke="none"/>',
} as const;

export type IconName = keyof typeof PATHS;

export const STAGE_ICON: Record<Stage, IconName> = {
  [Stage.Alive]: 'candle',
  [Stage.Withering]: 'wither',
  [Stage.Ghost]: 'ghost',
  [Stage.Dead]: 'skull',
  [Stage.Entombed]: 'coffin',
};

const cache = new Map<IconName, SVGSVGElement>();

/** A fresh copy of an icon, decorative unless a label is given. */
export function icon(name: IconName, label?: string): SVGSVGElement {
  let base = cache.get(name);
  if (!base) {
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${PATHS[name]}</svg>`,
      'image/svg+xml',
    );
    base = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
    base.classList.add('icon');
    cache.set(name, base);
  }
  const node = base.cloneNode(true) as SVGSVGElement;
  if (label) {
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', label);
  } else {
    node.setAttribute('aria-hidden', 'true');
  }
  return node;
}

/** Fill every `<i data-icon="name">` placeholder in static markup. */
export function hydrateIcons(root: ParentNode = document): void {
  for (const slot of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    if (slot.firstElementChild) continue;
    slot.append(icon(slot.dataset.icon as IconName));
  }
}
