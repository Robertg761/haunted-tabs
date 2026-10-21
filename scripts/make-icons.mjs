// Renders the extension icons to the PNG sizes the browsers want.
// Run with `npm run icons`; the PNGs are committed in public/icons.
//
// Two drawings: the toolbar sizes (16 and 32) are a bare ghost that fills the square,
// drawn on a 16px grid with a dark outline so it reads on light and dark toolbars alike.
// The large sizes (48 and 128, for the extensions page and stores) sit on a night tile.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

// Toolbar ghost, 16px grid. Eyes and mouth sit on whole pixels so they stay crisp at 1x.
const small = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <defs>
    <linearGradient id="b" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#c9f7e3"/>
    </linearGradient>
  </defs>
  <path d="M1.5 14.5V7C1.5 3.7 4.3 1.5 8 1.5s6.5 2.2 6.5 5.5v7.5l-2.15-1.7-2.2 1.7L8 12.8l-2.15 1.7-2.2-1.7z"
        fill="url(#b)" stroke="#1d1233" stroke-width="1" stroke-linejoin="round"/>
  <rect x="5" y="5" width="2" height="3" rx=".7" fill="#1d1233"/>
  <rect x="9" y="5" width="2" height="3" rx=".7" fill="#1d1233"/>
  <rect x="7" y="10" width="2" height="2" rx="1" fill="#1d1233"/>
</svg>`;

const large = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <radialGradient id="bg" cx="50%" cy="30%" r="75%">
      <stop offset="0" stop-color="#3b2366"/>
      <stop offset="1" stop-color="#0d0914"/>
    </radialGradient>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#d4fbe9"/>
    </linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="5" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#bg)"/>
  <g filter="url(#glow)">
    <path d="M64 16C42 16 28 32 28 54v56l12-10 12 10 12-10 12 10 12-10 12 10V54c0-22-14-38-36-38z" fill="url(#body)"/>
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
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${size <= 32 ? small : large}`);
  await page.screenshot({ path: `public/icons/icon${size}.png`, omitBackground: true });
}
await browser.close();
console.log('icons written');
