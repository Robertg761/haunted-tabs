/**
 * The WebExtension API. Firefox (and Firefox-based browsers like Zen) expose the
 * promise-based API as `browser`; Chrome exposes it as `chrome`. Same shapes.
 */
export const ext: typeof chrome = (globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome;

/** Whether the browser can serve favicons from its local cache (Chrome's `_favicon`). */
export const hasFaviconCache = (): boolean => !!ext.runtime.getManifest().permissions?.includes('favicon');
