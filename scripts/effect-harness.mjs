// Look at an effect in a real Chromium with the built extension, on a realistic page.
// Captures screenshots over time, optional interaction, frame rate, console errors,
// and whether everything is cleaned up afterwards. Run `npm run build` first.
//
//   node scripts/effect-harness.mjs --effect fog --stage 2 --out shots/fog
//   options:
//     --effect   dust|fog|eyes|drips|shadow|ghostCursor|cobwebs|possession|popup|graveyard
//     --stage    1..4 (default 3)             --theme  light|dark (default light)
//     --frames   ms list, e.g. 300,1500,4000  --interact  sweep the mouse and scroll, then more frames
//     --reduced  prefers-reduced-motion        --stop      sweep afterwards and check teardown
//     --width/--height viewport (default 1280x800)
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const effect = opt('effect', 'fog');
const stage = Number(opt('stage', 3));
const theme = opt('theme', 'light');
const out = resolve(opt('out', `shots/${effect}`));
const frames = String(opt('frames', '300,1200,3000')).split(',').map(Number);
const interact = !!opt('interact', false);
const reduced = !!opt('reduced', false);
const stop = !!opt('stop', false);
const width = Number(opt('width', 1280));
const height = Number(opt('height', 800));
mkdirSync(out, { recursive: true });

const dark = theme === 'dark';
const paragraphs = Array.from(
  { length: 30 },
  (_, i) =>
    `<p>${i % 3 === 0 ? '<b>Update.</b> ' : ''}The quarterly figures came in slightly ahead of forecast, with most of the gain in the northern region. Paragraph ${i + 1} goes on about logistics, staffing and a few open questions for next week's review.</p>`,
).join('');
const page = `<!doctype html><html><head><meta charset="utf-8"><title>Quarterly report — Notes</title>
<style>
  body { margin: 0; font: 17px/1.6 system-ui, sans-serif; background: ${dark ? '#121417' : '#ffffff'}; color: ${dark ? '#d9dde3' : '#1f2328'}; }
  header { position: sticky; top: 0; display: flex; gap: 24px; align-items: center; padding: 14px 32px; background: ${dark ? '#1b1f24' : '#1a73e8'}; color: #fff; }
  header b { font-size: 20px; } header span { opacity: .85; }
  .wrap { display: grid; grid-template-columns: 220px 1fr; gap: 40px; max-width: 1100px; margin: 0 auto; padding: 32px; }
  aside a { display: block; padding: 6px 0; color: inherit; opacity: .7; text-decoration: none; }
  .hero { height: 220px; border-radius: 12px; background: linear-gradient(120deg, #ff9a5a, #ff5f7e 40%, #6a5cff); margin-bottom: 24px; }
  h1 { margin: 0 0 12px; font-size: 34px; }
  button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid ${dark ? '#3a3f46' : '#c9ced6'}; background: ${dark ? '#22262c' : '#f6f8fa'}; color: inherit; }
</style></head><body>
<header><b>Notes</b><span>Inbox</span><span>Docs</span><span>Calendar</span></header>
<div class="wrap"><aside><a href="#">Overview</a><a href="#">Q3 report</a><a href="#">Hiring</a><a href="#">Archive</a></aside>
<main><div class="hero"></div><h1>Quarterly report</h1><button>Share</button> <button>Export</button>${paragraphs}</main></div>
</body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const extDir = mkdtempSync(join(tmpdir(), 'haunt-ext-'));
cpSync('dist/chrome', extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest));

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'haunt-profile-')), {
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  headless: false,
  viewport: { width, height },
  reducedMotion: reduced ? 'reduce' : 'no-preference',
  colorScheme: dark ? 'dark' : 'light',
  args: ['--headless=new', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
const report = { effect, stage, theme, reduced, frames: [], consoleErrors: [], fps: null, leftovers: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await sleep(500);
  const extId = new URL(sw.url()).host;

  if (effect === 'popup' || effect === 'graveyard') {
    // Some real tabs, decayed by moving the worker's clock forward.
    for (const path of ['a', 'b', 'c', 'd']) {
      const p = await context.newPage();
      await p.goto(`${url}?${path}`);
    }
    const control = await context.newPage();
    await control.setViewportSize(effect === 'popup' ? { width: 420, height: 600 } : { width, height });
    await control.goto(`chrome-extension://${extId}/popup/index.html`);
    await control.evaluate(() => chrome.runtime.sendMessage({ type: 'setSettings', settings: { enabled: true, thresholdMinutes: 30 } }));
    await sw.evaluate((s) => {
      const real = Date.now.bind(Date);
      const offset = [0, 31, 61, 125, 245][s] * 60_000;
      Date.now = () => real() + offset;
    }, stage);
    await control.evaluate(() => chrome.runtime.sendMessage({ type: 'setSettings', settings: {} }));
    if (effect === 'graveyard') {
      await sw.evaluate((u) => {
        const now = Date.now();
        const graves = ['Quarterly report', 'Flight to Lisbon — booking', 'Untitled spreadsheet', 'How to fix a squeaky door'].map((title, i) => ({
          id: `g${i}`, url: `${u}?grave${i}`, title, diedAt: now - i * 3_600_000, idleMs: (i + 2) * 3_600_000, cause: i % 2 ? 'you' : 'haunting',
        }));
        return chrome.storage.local.set({ graveyard: graves });
      }, url);
      await control.goto(`chrome-extension://${extId}/graveyard/index.html`);
    } else {
      await control.reload();
    }
    control.on('console', (m) => m.type() === 'error' && report.consoleErrors.push(m.text()));
    for (const ms of frames) {
      await sleep(ms - (report.frames.at(-1)?.at ?? 0));
      const path = join(out, `${effect}-${ms}ms.png`);
      await control.screenshot({ path, fullPage: effect === 'popup' });
      report.frames.push({ at: ms, path });
    }
  } else {
    const tab = context.pages()[0];
    tab.on('console', (m) => m.type() === 'error' && report.consoleErrors.push(m.text()));
    tab.on('pageerror', (e) => report.consoleErrors.push(String(e)));
    await tab.goto(url);
    await tab.mouse.move(width * 0.55, height * 0.45);
    const command =
      effect === 'cobwebs'
        ? { type: 'haunt:cobwebs', webs: [0, 2, 3, 5, 7][stage], growAfterMs: 0 }
        : effect === 'possession'
          ? { type: 'haunt:glitch', message: 'I WAITED 3 HOURS', thenRestore: false, durationMs: 1100 }
          : { type: 'haunt:effects', effects: [effect], stage, idleMs: [0, 31, 61, 125, 245][stage] * 60_000, seed: 12345 };
    const res = await sw.evaluate(async (cmd) => {
      const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] });
      return chrome.tabs.sendMessage(t.id, cmd);
    }, command);
    report.started = res;
    const t0 = Date.now();
    const shoot = async (label, ms) => {
      const wait = t0 + ms - Date.now();
      if (wait > 0) await sleep(wait);
      const path = join(out, `${effect}-${label}.png`);
      await tab.screenshot({ path });
      report.frames.push({ at: ms, label, path });
    };
    for (const ms of frames) await shoot(`${ms}ms`, ms);
    // Frame rate while the effect runs, measured from the page's own rAF.
    report.fps = await tab.evaluate(
      () =>
        new Promise((done) => {
          let n = 0;
          const start = performance.now();
          const step = () => (performance.now() - start < 2000 ? (n++, requestAnimationFrame(step)) : done(Math.round(n / 2)));
          requestAnimationFrame(step);
        }),
    );
    if (interact) {
      for (let i = 0; i < 3; i++) {
        await tab.mouse.move(width * 0.1, height * 0.2, { steps: 20 });
        await tab.mouse.move(width * 0.9, height * 0.7, { steps: 20 });
      }
      await shoot('after-sweep', Date.now() - t0 + 200);
      await tab.mouse.wheel(0, 600);
      await shoot('after-scroll', Date.now() - t0 + 500);
      await shoot('after-scroll-settled', Date.now() - t0 + 2500);
    }
    if (stop) {
      await sw.evaluate(async () => {
        const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
        return chrome.tabs.sendMessage(t.id, { type: 'haunt:sweep' });
      });
      await shoot('stopping', Date.now() - t0 + 300);
      await sleep(3500);
      report.leftovers = await tab.evaluate(() => [...document.querySelectorAll('[data-haunted-tabs]')].map((e) => e.getAttribute('data-haunted-tabs')));
    }
  }
} catch (err) {
  report.error = String(err?.stack || err);
} finally {
  await context.close().catch(() => {});
  server.close();
  rmSync(extDir, { recursive: true, force: true });
}
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
