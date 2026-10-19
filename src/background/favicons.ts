import { Stage } from '../shared/types';

const svgUrl = (svg: string) => 'data:image/svg+xml,' + encodeURIComponent(svg.replace(/\s*\n\s*/g, ' ').trim());

const WITHERED = svgUrl(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <circle cx="16" cy="16" r="13" fill="#6f6a4e" stroke="#2c2a1d" stroke-width="2"/>
  <path d="M16 3l-2 6 3 4-4 5 2 4-3 7M27 11l-5 3-2 5M6 21l5-1 2 3" fill="none" stroke="#1e1c13" stroke-width="1.6"/>
</svg>`);

const GHOST = svgUrl(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <path d="M16 2C9.4 2 5 6.8 5 13.6V30l3.7-3.2 3.6 3.2 3.7-3.2 3.7 3.2 3.6-3.2L27 30V13.6C27 6.8 22.6 2 16 2z"
    fill="#f3f0ff" stroke="#5b4c8a" stroke-width="1.6" stroke-linejoin="round"/>
  <ellipse cx="11.8" cy="13" rx="2.5" ry="3.4" fill="#17111f"/>
  <ellipse cx="20.2" cy="13" rx="2.5" ry="3.4" fill="#17111f"/>
  <ellipse cx="16" cy="21" rx="2.1" ry="2.8" fill="#17111f"/>
</svg>`);

const SKULL = svgUrl(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <path d="M16 2C8.8 2 4 7 4 13.5c0 4 1.8 6.8 4.5 8.3V26c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2v-4.2c2.7-1.5 4.5-4.3 4.5-8.3C28 7 23.2 2 16 2z"
    fill="#ece5d3" stroke="#2f2920" stroke-width="1.6"/>
  <circle cx="10.8" cy="14" r="3.6" fill="#120d0a"/>
  <circle cx="21.2" cy="14" r="3.6" fill="#120d0a"/>
  <circle cx="10.8" cy="14.6" r="1.1" fill="#ff2a2a"/>
  <circle cx="21.2" cy="14.6" r="1.1" fill="#ff2a2a"/>
  <path d="M16 17.6l-2.2 3.6h4.4z" fill="#120d0a"/>
  <path d="M12.6 23.5v4.5M16 23.5v4.5M19.4 23.5v4.5" stroke="#2f2920" stroke-width="1.4"/>
</svg>`);

const TOMB = svgUrl(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <path d="M7 29V12.5C7 6.8 11 3 16 3s9 3.8 9 9.5V29z" fill="#9097a3" stroke="#262a31" stroke-width="1.6"/>
  <path d="M16 8v13M11.5 12.5h9" stroke="#262a31" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M2 29.5h28" stroke="#3b2a1d" stroke-width="3" stroke-linecap="round"/>
</svg>`);

export const STAGE_ICONS: Record<Exclude<Stage, Stage.Alive>, string> = {
  [Stage.Withering]: WITHERED,
  [Stage.Ghost]: GHOST,
  [Stage.Dead]: SKULL,
  [Stage.Entombed]: TOMB,
};

/** True for icons we painted, so they are never mistaken for a page's real favicon. */
export function isOurIcon(url: string | undefined): boolean {
  return !!url && (Object.values(STAGE_ICONS).includes(url) || witheredValues.has(url));
}

const witheredCache = new Map<string, Promise<string>>();
const witheredValues = new Set<string>();

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * The page's own favicon, drained of colour and cracked. Reads the browser's
 * local favicon cache through the `favicon` permission; nothing leaves the machine.
 */
async function paintWithered(pageUrl: string): Promise<string> {
  const res = await fetch(chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=32`));
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = new OffscreenCanvas(32, 32);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(bitmap, 0, 0, 32, 32);
  const img = ctx.getImageData(0, 0, 32, 32);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const grey = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
    d[i] = grey * 0.7 + 18;
    d[i + 1] = grey * 0.78 + 26;
    d[i + 2] = grey * 0.5 + 6;
    d[i + 3] = d[i + 3] * 0.88;
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = 'rgba(16, 10, 4, 0.9)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(17, 0);
  ctx.lineTo(14, 8);
  ctx.lineTo(18, 13);
  ctx.lineTo(13, 20);
  ctx.lineTo(16, 25);
  ctx.lineTo(12, 32);
  ctx.moveTo(18, 13);
  ctx.lineTo(26, 16);
  ctx.lineTo(32, 14);
  ctx.stroke();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const url = 'data:image/png;base64,' + toBase64(await blob.arrayBuffer());
  witheredValues.add(url);
  return url;
}

export async function iconFor(stage: Exclude<Stage, Stage.Alive>, pageUrl: string): Promise<string> {
  if (stage !== Stage.Withering) return STAGE_ICONS[stage];
  let key: string;
  try {
    const u = new URL(pageUrl);
    key = u.origin + u.pathname;
  } catch {
    return WITHERED;
  }
  let pending = witheredCache.get(key);
  if (!pending) {
    pending = paintWithered(pageUrl).catch(() => WITHERED);
    witheredCache.set(key, pending);
    if (witheredCache.size > 200) witheredCache.delete(witheredCache.keys().next().value!);
  }
  return pending;
}
