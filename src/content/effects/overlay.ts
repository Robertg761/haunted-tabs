// Shared helpers for page effects. An effect gets one host element on <html>
// with a closed shadow root, so page CSS cannot touch it and it cannot touch
// the page. Overlays never take pointer events: the page keeps working.

import type { EffectName } from '../../shared/types';

export const OUR_ATTR = 'data-haunted-tabs';

/**
 * Stacking order, bottom to top. The page sits below all of these.
 * Atmosphere first, creatures in the middle, takeovers on top.
 */
export const Z: Record<EffectName | 'cobwebs' | 'possession', number> = {
  dust: 2147483630,
  fog: 2147483632,
  shadow: 2147483634,
  drips: 2147483636,
  eyes: 2147483638,
  ghostCursor: 2147483640,
  cobwebs: 2147483646,
  possession: 2147483647,
};

export interface Overlay {
  host: HTMLElement;
  root: ShadowRoot;
  /** Full-viewport layer inside the shadow root to draw or place elements in. */
  layer: HTMLDivElement;
  remove(): void;
}

/**
 * Reset for a host element. Important rules inside the shadow root beat the page's,
 * so a page rule like `div { transform: ... }` cannot collapse an overlay.
 */
export const HOST_CSS = `
  :host { all: initial !important; zoom: var(--haunted-unzoom, 1) !important; }
  @media print { :host { display: none !important; } }
`;

/** An empty host element for one of our overlays, hidden from assistive tech and focus. */
export function createHost(tag: string): HTMLDivElement {
  const host = document.createElement('div');
  host.setAttribute(OUR_ATTR, tag);
  host.setAttribute('aria-hidden', 'true');
  host.inert = true;
  return host;
}

/** Whether the root's own styling would drag, clip, fade or recolour fixed layers inside it. */
function rootTrapsLayers(cs: CSSStyleDeclaration): boolean {
  return (
    cs.transform !== 'none' ||
    cs.filter !== 'none' ||
    cs.perspective !== 'none' ||
    cs.backdropFilter !== 'none' ||
    Number(cs.opacity) < 1 ||
    /paint|layout|strict|content/.test(cs.contain) ||
    /transform|filter|perspective|opacity/.test(cs.willChange)
  );
}

/**
 * Put one of our hosts into the page, as the last child of <html>, where its
 * fixed layers cover the viewport. A page that transforms or filters <html>
 * would pull them along with the document or invert them, so there the host is
 * lifted into the top layer, which ignores the root's transform and filter. A
 * zoomed <html> is undone, so our pixels stay the viewport's pixels.
 */
export function attachHost(host: HTMLElement, z: number): void {
  const root = document.documentElement;
  root.appendChild(host);
  for (const h of [...hosts.keys()]) if (!h.isConnected) hosts.delete(h);
  hosts.set(host, z);
  let cs: CSSStyleDeclaration;
  try {
    cs = getComputedStyle(root);
  } catch {
    return;
  }
  const zoom = parseFloat((cs as CSSStyleDeclaration & { zoom?: string }).zoom ?? '') || 1;
  if (Math.abs(zoom - 1) > 0.001) host.style.setProperty('--haunted-unzoom', String(1 / zoom));
  const lifted = [...hosts.keys()].some((h) => h !== host && isLifted(h));
  if ((lifted || rootTrapsLayers(cs)) && typeof host.showPopover === 'function') liftAll();
}

/** Our hosts on the page and their stacking order (Z), so lifted ones can be kept in that order. */
const hosts = new Map<HTMLElement, number>();

function isLifted(h: HTMLElement): boolean {
  try {
    return h.matches(':popover-open');
  } catch {
    return false;
  }
}

/**
 * The top layer stacks by the order things were shown, not by z-index, and one
 * lifted host would sit above every unlifted one. So when one host goes up they
 * all do, shown again bottom to top in Z order. It all happens in one task, so
 * nothing is painted in between.
 */
function liftAll(): void {
  const order = [...hosts.entries()].sort((a, b) => a[1] - b[1]).map(([h]) => h);
  for (const h of order) {
    try {
      if (isLifted(h)) h.hidePopover();
    } catch {
      // Not shown after all.
    }
  }
  for (const h of order) {
    try {
      h.popover = 'manual';
      h.showPopover();
    } catch {
      // Stays where it is: still there, just not lifted.
    }
  }
}

/** A click-through, full-viewport overlay for one effect. */
export function createOverlay(name: EffectName, css = ''): Overlay {
  const host = createHost(`effect-${name}`);
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    ${HOST_CSS}
    .layer { position: fixed; inset: 0; pointer-events: none; overflow: hidden; z-index: ${Z[name]}; contain: strict; }
    ${css}
  `;
  const layer = document.createElement('div');
  layer.className = 'layer';
  root.append(style, layer);
  attachHost(host, Z[name]);
  return { host, root, layer, remove: () => host.remove() };
}

/** A canvas sized to the viewport at device resolution (capped for performance). */
export function createCanvas(parent: HTMLElement, maxDpr = 2): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  resize(): void;
} {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
  parent.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;
  const resize = () => {
    const dpr = Math.min(maxDpr, devicePixelRatio || 1);
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  return { canvas, ctx, resize };
}

export const prefersReducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Seeded PRNG (mulberry32), so a tab haunts the same way each time. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A viewport rectangle in CSS pixels. */
export interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where each creature has settled on screen, so the others keep out of its way
 * (drips don't run through the eyes' darkness, webs don't string across them).
 * Each owner replaces its own list whenever it moves and clears it when it goes.
 */
const claimed = new Map<string, Area[]>();

export function claimAreas(owner: string, areas: Area[]): void {
  if (areas.length) claimed.set(owner, areas);
  else claimed.delete(owner);
}

/** Everything claimed by owners other than `owner`. */
export function areasTaken(owner: string): Area[] {
  const out: Area[] = [];
  for (const [name, areas] of claimed) if (name !== owner) out.push(...areas);
  return out;
}
