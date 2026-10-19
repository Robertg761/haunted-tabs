// Renders the extension icon SVG to the PNG sizes Chrome wants.
// Run with `npm run icons`; the PNGs are committed in public/icons.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <radialGradient id="bg" cx="50%" cy="30%" r="75%">
      <stop offset="0" stop-color="#3b2366"/>
      <stop offset="1" stop-color="#0d0914"/>
    </radialGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="5" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#bg)"/>
  <g filter="url(#glow)">
    <path d="M64 16C42 16 28 32 28 54v56l12-10 12 10 12-10 12 10 12-10 12 10V54c0-22-14-38-36-38z" fill="#effff6"/>
  </g>
  <ellipse cx="51" cy="54" rx="8" ry="11" fill="#140d1f"/>
  <ellipse cx="77" cy="54" rx="8" ry="11" fill="#140d1f"/>
  <ellipse cx="64" cy="80" rx="7" ry="9" fill="#140d1f"/>
</svg>`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
mkdirSync('public/icons', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: `public/icons/icon${size}.png`, omitBackground: true });
}
await browser.close();
console.log('icons written');
