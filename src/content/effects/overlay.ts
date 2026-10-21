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

/** A click-through, full-viewport overlay for one effect. */
export function createOverlay(name: EffectName, css = ''): Overlay {
  const host = document.createElement('div');
  host.setAttribute(OUR_ATTR, `effect-${name}`);
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    @media print { :host { display: none !important; } }
    .layer { position: fixed; inset: 0; pointer-events: none; overflow: hidden; z-index: ${Z[name]}; contain: strict; }
    ${css}
  `;
  const layer = document.createElement('div');
  layer.className = 'layer';
  root.append(style, layer);
  document.documentElement.appendChild(host);
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
