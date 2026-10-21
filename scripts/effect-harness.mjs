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
//     --width/--height viewport (default 1280x800)   --dpr  device pixel ratio (default 1)
//     --page     article (default) | dark | colourful | docs | video | rtl | short | tall | wide
//                | transform (html transformed) | bodytransform | filter (html filtered) | zoom (html zoom)
//     --duration possession length in ms (default 1100; longer plays it in slow motion)
//     --cpu      slow the page's CPU down N times (Chromium), e.g. to see possession drop to its lite tier
//     --video    also record the tab as a .webm in --out (frame-by-frame review: ffmpeg -i x.webm f%03d.png)
//     --browser  chromium (default) | firefox (FIREFOX_PATH=..., possession and page effects)
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
const dpr = Number(opt('dpr', 1));
const pageKind = String(opt('page', 'article'));
const duration = Number(opt('duration', 1100));
const engine = String(opt('browser', 'chromium'));
const video = !!opt('video', false);
const cpu = Number(opt('cpu', 1));
mkdirSync(out, { recursive: true });

const dark = theme === 'dark' || pageKind === 'dark' || pageKind === 'video';
const paragraphs = Array.from(
  { length: 30 },
  (_, i) =>
    `<p>${i % 3 === 0 ? '<b>Update.</b> ' : ''}The quarterly figures came in slightly ahead of forecast, with most of the gain in the northern region. Paragraph ${i + 1} goes on about logistics, staffing and a few open questions for next week's review.</p>`,
).join('');
const article = `<!doctype html><html><head><meta charset="utf-8"><title>Quarterly report — Notes</title>
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


const doc = (title, css, body, attrs = '') =>
  `<!doctype html><html${attrs}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>${css}</style></head><body>${body}</body></html>`;
const lorem = (n, word = 'The') =>
  Array.from({ length: n }, (_, i) => `<p>${word} build finished in ${12 + i} seconds. Nothing in the logs explains the warning on line ${40 + i}, so it stays open for now.</p>`).join('');
const pages = {
  article,
  // Same article, but the root carries a transform, filter or zoom: fixed overlays must still cover the viewport.
  transform: article.replace('<html>', '<html style="transform: translateZ(0) rotate(0.0001deg)">'),
  bodytransform: article.replace('<body>', '<body style="transform: scale(1); filter: saturate(1.1)">'),
  filter: article.replace('<html>', '<html style="filter: invert(1) hue-rotate(180deg)">'),
  zoom: article.replace('<html>', '<html style="zoom: 1.5">'),
  dark: doc('Dashboard · Acme Cloud', `body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: #0d1117; color: #c9d1d9; display: grid; grid-template-columns: 240px 1fr; min-height: 100vh; }
    nav { background: #010409; padding: 20px; } nav a { display: block; color: #8b949e; padding: 8px 0; text-decoration: none; }
    main { padding: 28px; } .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 18px; height: 120px; } .card b { font-size: 28px; color: #58a6ff; display: block; }`,
    `<nav><a>Overview</a><a>Deployments</a><a>Logs</a><a>Settings</a></nav><main><h1>Overview</h1><div class="cards">${Array.from({ length: 9 }, (_, i) => `<div class="card">Requests<b>${(i + 3) * 1270}</b>last 24h</div>`).join('')}</div>${lorem(6)}</main>`),
  colourful: doc('Summer sale — 40% off', `body { margin: 0; font: 18px/1.5 system-ui, sans-serif; color: #fff; background: linear-gradient(135deg, #ff006e, #fb5607 30%, #ffbe0b 55%, #3a86ff 80%, #8338ec); min-height: 100vh; }
    h1 { font-size: 72px; margin: 0; padding: 60px 40px 10px; } .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; padding: 40px; }
    .tiles div { height: 180px; border-radius: 16px; background: rgba(255,255,255,.25); }`, `<h1>Summer sale</h1><p style="padding: 0 40px">Everything must go.</p><div class="tiles">${'<div></div>'.repeat(8)}</div>`),
  docs: doc('API reference — Widgets', `body { margin: 0; font: 15px/1.6 system-ui, sans-serif; } aside { position: fixed; top: 0; bottom: 0; width: 260px; background: #f6f8fa; border-right: 1px solid #ddd; padding: 20px; box-sizing: border-box; overflow: auto; }
    article { margin-left: 260px; padding: 32px 48px; max-width: 760px; } pre { background: #f0f2f4; padding: 14px; border-radius: 6px; } code { font: 13px ui-monospace, monospace; }`,
    `<aside>${Array.from({ length: 40 }, (_, i) => `<div>widgets.method${i}()</div>`).join('')}</aside><article><h1>Widgets</h1>${Array.from({ length: 12 }, (_, i) => `<h2>widgets.method${i}()</h2><p>Creates a widget and returns its handle.</p><pre><code>const w = widgets.method${i}({ size: ${i} });</code></pre>`).join('')}</article>`),
  video: doc('A long film — Watch', `body { margin: 0; background: #0f0f0f; color: #eee; font: 14px system-ui, sans-serif; } .player { width: 100%; aspect-ratio: 16/9; max-height: 75vh; background: radial-gradient(circle at 40% 40%, #3a4a5a, #000); display: grid; place-items: center; font-size: 60px; }
    h1 { font-size: 20px; padding: 12px 24px; margin: 0; }`, `<div class="player">▶</div><h1>A long film</h1>${lorem(4)}`),
  rtl: doc('مقالة — أخبار', `body { margin: 0; font: 18px/1.7 system-ui, sans-serif; padding: 32px 48px; } h1 { font-size: 36px; }`,
    `<h1>عنوان المقالة الرئيسية</h1>${Array.from({ length: 20 }, () => '<p>هذا نص تجريبي طويل يملأ الصفحة لكي نرى كيف تبدو خيوط العنكبوت على صفحة مكتوبة من اليمين إلى اليسار.</p>').join('')}`, ' dir="rtl" lang="ar"'),
  short: doc('Login', `body { margin: 0; font: 16px system-ui, sans-serif; display: grid; place-items: center; height: 300px; }`, '<form><h2>Sign in</h2><input placeholder="Email"> <button>Go</button></form>'),
  tall: doc('Changelog', `body { margin: 0 auto; max-width: 700px; font: 16px/1.6 system-ui, sans-serif; padding: 20px; }`, lorem(400)),
  wide: doc('Spreadsheet', `body { margin: 0; font: 13px system-ui, sans-serif; } table { border-collapse: collapse; } td { border: 1px solid #ccc; padding: 4px 10px; min-width: 90px; }`,
    `<table>${Array.from({ length: 60 }, (_, r) => `<tr>${Array.from({ length: 40 }, (_, c) => `<td>${r * c}</td>`).join('')}</tr>`).join('')}</table>`),
};
const page = pages[pageKind] ?? article;

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (engine === 'firefox') {
  // Firefox over WebDriver BiDi, like tests/e2e-firefox.mjs. A hook opens the popup
  // as a tab, since WebDriver cannot open moz-extension:// pages itself.
  const { default: puppeteer } = await import('puppeteer-core');
  const UUID = '0b7d6c1e-1d9e-4c1b-9f9a-6a8e5d3f2a11';
  const ffDir = mkdtempSync(join(tmpdir(), 'haunt-ff-'));
  cpSync('dist/firefox', ffDir, { recursive: true });
  const ffManifest = JSON.parse(readFileSync(join(ffDir, 'manifest.json'), 'utf8'));
  ffManifest.host_permissions = ['<all_urls>'];
  ffManifest.background.scripts.unshift('test-hook.js');
  writeFileSync(join(ffDir, 'manifest.json'), JSON.stringify(ffManifest));
  writeFileSync(join(ffDir, 'test-hook.js'), `browser.tabs.create({ url: browser.runtime.getURL('popup/index.html'), active: false });`);
  const report = { effect, stage, theme, page: pageKind, dpr, reduced, browser: 'firefox', frames: [], consoleErrors: [], leftovers: null };
  const browser = await puppeteer.launch({
    browser: 'firefox',
    headless: true,
    executablePath: process.env.FIREFOX_PATH,
    args: ['-remote-allow-system-access'],
    extraPrefsFirefox: {
      'extensions.webextensions.uuids': JSON.stringify({ 'haunted-tabs@robertg761': UUID }),
      'extensions.originControls.grantByDefault': true,
      'ui.prefersReducedMotion': reduced ? 1 : 0,
      'layout.css.devPixelsPerPx': String(dpr),
      'ui.systemUsesDarkTheme': dark ? 1 : 0,
    },
  });
  try {
    const tab = (await browser.pages())[0] ?? (await browser.newPage());
    tab.on('pageerror', (e) => report.consoleErrors.push(String(e)));
    await tab.setViewport({ width, height });
    await browser.installExtension(ffDir);
    let control;
    for (let i = 0; i < 40 && !control; i++, await sleep(150)) {
      for (const p of await browser.pages()) if ((await p.evaluate(() => location.href).catch(() => '')).startsWith(`moz-extension://${UUID}/`)) control = p;
    }
    await tab.goto(url);
    await tab.mouse.move(width * 0.55, height * 0.45);
    const command =
      effect === 'cobwebs'
        ? { type: 'haunt:cobwebs', webs: [0, 2, 3, 4, 5][stage], growAfterMs: 0 }
        : effect === 'possession'
          ? { type: 'haunt:glitch', message: 'I WAITED 3 HOURS', thenRestore: false, durationMs: duration }
          : { type: 'haunt:effects', effects: [effect], stage, idleMs: [0, 31, 61, 125, 245][stage] * 60_000, seed: 12345 };
    report.started = await control.evaluate(async (cmd) => {
      const [t] = await browser.tabs.query({ url: 'http://127.0.0.1/*' });
      await browser.tabs.update(t.id, { active: true });
      await browser.scripting.executeScript({ target: { tabId: t.id }, files: ['/content.js'] });
      return browser.tabs.sendMessage(t.id, cmd);
    }, command);
    const t0 = Date.now();
    for (const ms of frames) {
      const wait = t0 + ms - Date.now();
      if (wait > 0) await sleep(wait);
      const path = join(out, `${effect}-ff-${ms}ms.png`);
      await tab.screenshot({ path });
      report.frames.push({ at: ms, path });
    }
    if (stop) {
      await control.evaluate(async () => {
        const [t] = await browser.tabs.query({ url: 'http://127.0.0.1/*' });
        return browser.tabs.sendMessage(t.id, { type: 'haunt:sweep' });
      });
      await sleep(3500);
    }
    report.leftovers = await tab.evaluate(() => [...document.querySelectorAll('[data-haunted-tabs]')].map((e) => e.getAttribute('data-haunted-tabs')));
  } catch (err) {
    report.error = String(err?.stack || err);
  } finally {
    await browser.close().catch(() => {});
    server.close();
    rmSync(ffDir, { recursive: true, force: true });
  }
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const extDir = mkdtempSync(join(tmpdir(), 'haunt-ext-'));
cpSync('dist/chrome', extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest));

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'haunt-profile-')), {
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  headless: false,
  viewport: { width, height },
  deviceScaleFactor: dpr,
  ...(video ? { recordVideo: { dir: out, size: { width, height } } } : {}),
  reducedMotion: reduced ? 'reduce' : 'no-preference',
  colorScheme: dark ? 'dark' : 'light',
  args: ['--headless=new', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
const report = { effect, stage, theme, page: pageKind, dpr, reduced, frames: [], consoleErrors: [], fps: null, leftovers: null };

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
    if (cpu > 1) await (await context.newCDPSession(tab)).send('Emulation.setCPUThrottlingRate', { rate: cpu });
    const command =
      effect === 'cobwebs'
        ? { type: 'haunt:cobwebs', webs: [0, 2, 3, 4, 5][stage], growAfterMs: 0 }
        : effect === 'possession'
          ? { type: 'haunt:glitch', message: 'I WAITED 3 HOURS', thenRestore: false, durationMs: duration }
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
      report.frames.push({ at: ms, label, path, took: Date.now() - t0 });
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
