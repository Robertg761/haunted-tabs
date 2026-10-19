// End-to-end check in a real Firefox (the engine behind Zen, LibreWolf, ...).
// Installs dist/firefox over WebDriver BiDi, serves local pages, fast-forwards
// the background clock, and checks real tabs decay, possess, bury, resurrect,
// and exorcise.    npm run e2e:firefox    (FIREFOX_PATH=... to use your own)
import { Browser, detectBrowserPlatform, install, resolveBuildId } from '@puppeteer/browsers';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const MIN = 60_000;
const ADDON_ID = 'haunted-tabs@robertg761';
const UUID = '0b7d6c1e-1d9e-4c1b-9f9a-6a8e5d3f2a11';

async function firefoxPath() {
  if (process.env.FIREFOX_PATH) return process.env.FIREFOX_PATH;
  const platform = detectBrowserPlatform();
  const buildId = await resolveBuildId(Browser.FIREFOX, platform, 'stable');
  const installed = await install({ browser: Browser.FIREFOX, buildId, cacheDir: resolve('.cache') });
  return installed.executablePath;
}

// Test copy of the build: host access granted up front (standing in for the
// user accepting the prompt), plus a hook that opens the popup as a tab and lets
// the test move the background clock. WebDriver cannot open moz-extension:// pages.
const extDir = mkdtempSync(join(tmpdir(), 'haunted-ff-'));
cpSync('dist/firefox', extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
manifest.background.scripts.unshift('test-hook.js');
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest));
writeFileSync(
  join(extDir, 'test-hook.js'),
  `const realNow = Date.now.bind(Date);
globalThis.__offset = 0;
Date.now = () => realNow() + globalThis.__offset;
browser.tabs.create({ url: browser.runtime.getURL('popup/index.html') });`,
);

const FAV = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#e33"/></svg>`;
const pages = {
  '/alpha': `<title>Alpha page</title><link rel="icon" href="/fav.svg"></head><body><h1>Alpha</h1>`,
  '/form': `<title>Form page</title><link rel="icon" href="/fav.svg"></head><body><form><input id="name"></form>`,
  '/plain': `<title>Plain page</title></head><body><p>No favicon here.</p>`,
};
const server = createServer((req, res) => {
  if (req.url === '/fav.svg') {
    res.writeHead(200, { 'content-type': 'image/svg+xml' });
    return res.end(FAV);
  }
  const body = pages[req.url];
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body ? `<!doctype html><html><head><meta charset="utf-8">${body}</body></html>` : '');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  browser: 'firefox',
  headless: true,
  executablePath: await firefoxPath(),
  args: ['-remote-allow-system-access'],
  extraPrefsFirefox: {
    'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: UUID }),
    'extensions.originControls.grantByDefault': true,
    'extensions.background.idle.timeout': 600_000,
  },
});

let failures = 0;
function check(cond, label) {
  console.log(`${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(150);
  }
  return last;
}

try {
  await browser.installExtension(extDir);
  const control = await eventually(async () => {
    for (const p of await browser.pages()) {
      const href = await p.evaluate(() => location.href).catch(() => '');
      if (href.startsWith(`moz-extension://${UUID}/popup/`)) return p;
    }
  });
  check(!!control, 'extension installs and its popup loads in Firefox');
  const ask = (req) => control.evaluate((req) => browser.runtime.sendMessage(req), req);
  const inExt = (fn, arg) => control.evaluate(fn, arg);
  const advance = (ms) => inExt(async (ms) => ((await browser.runtime.getBackgroundPage()).__offset += ms), ms);
  const tick = () => ask({ type: 'setSettings', settings: {} });
  // Switch tabs the way a user would; WebDriver may not activate extension tabs.
  const showControl = () => inExt(async () => browser.tabs.update((await browser.tabs.getCurrent()).id, { active: true }));
  const show = (path) =>
    inExt(async (url) => browser.tabs.update((await browser.tabs.query({})).find((t) => t.url === url).id, { active: true }), `${origin}${path}`);

  const open = async (path) => {
    const p = await browser.newPage();
    await p.goto(`${origin}${path}`);
    return p;
  };
  const alpha = await open('/alpha');
  const form = await open('/form');
  await open('/plain');
  await show('/form');
  await form.type('#name', 'half-written message');
  await showControl();
  await sleep(300);

  let snap = await ask({ type: 'snapshot' });
  check(snap.settings.enabled === false, 'haunting is off until the user opts in');
  check(snap.tabs.length >= 4, `popup sees every real tab (${snap.tabs.length})`);

  snap = await ask({ type: 'setSettings', settings: { enabled: true, thresholdMinutes: 30, poltergeist: false } });
  check(snap.settings.enabled && snap.hostPermission, 'haunting turns on');
  check((await alpha.title()) === 'Alpha page', 'fresh tabs stay alive');

  await advance(31 * MIN);
  await tick();
  const withered = await alpha.title();
  check(withered !== 'Alpha page' && !withered.startsWith('👻'), `withering title rots: "${withered}"`);
  check(await alpha.evaluate(() => !!document.querySelector('link[data-haunted-tabs][rel=icon]')), 'favicon replaced');

  await advance(30 * MIN);
  await tick();
  check((await alpha.title()).startsWith('👻'), `ghost title: "${await alpha.title()}"`);
  const stripTitle = await inExt(async (url) => (await browser.tabs.query({})).find((t) => t.url === url)?.title, `${origin}/alpha`);
  check(stripTitle?.startsWith('👻'), 'tab strip shows the ghost title');
  snap = await ask({ type: 'snapshot' });
  check(snap.tabs.find((t) => t.url.endsWith('/alpha'))?.title === 'Alpha page', 'popup still shows the real title');

  await advance(61 * MIN);
  await tick();
  check((await alpha.title()).startsWith('💀'), `dead title: "${await alpha.title()}"`);

  await show('/alpha');
  const glitched = await eventually(() => alpha.evaluate(() => !!document.querySelector('[data-haunted-tabs="glitch"]')), 2000);
  check(glitched, 'returning to a dead tab triggers the glitch');
  if (process.env.SHOTS && glitched) {
    await sleep(300);
    await alpha.screenshot({ path: join(process.env.SHOTS, 'firefox-possession.png') });
  }
  check(await eventually(async () => (await alpha.title()) === 'Alpha page', 4000), 'real title comes back after the possession');
  check(
    await alpha.evaluate(() => !!document.querySelector('link[href="/fav.svg"]') && !document.querySelector('link[data-haunted-tabs][rel=icon]')),
    'real favicon restored',
  );

  // Alpha stays in view while everything else rots into the ground.
  await advance(250 * MIN);
  await ask({ type: 'setSettings', settings: { autoBury: true } });
  await sleep(800);
  const urls = await inExt(async () => (await browser.tabs.query({})).map((t) => t.url));
  check(!urls.some((u) => u.endsWith('/plain')), 'entombed tab is buried');
  check(urls.some((u) => u.endsWith('/form')), 'tab with unsaved input is never buried');
  check(urls.some((u) => u.endsWith('/alpha')), 'the tab in view survives');
  await ask({ type: 'setSettings', settings: { autoBury: false } });

  const graves = await inExt(async () => (await browser.storage.local.get('graveyard')).graveyard);
  check(graves?.length === 1 && graves[0].title === 'Plain page', 'grave keeps the real title');
  await inExt(() => {
    const yard = browser.runtime.getURL('graveyard/index.html');
    return browser.tabs.create({ url: yard, active: false });
  });
  const yard = await eventually(async () => {
    for (const p of await browser.pages()) {
      const href = await p.evaluate(() => location.href).catch(() => '');
      if (href.includes('/graveyard/')) return p;
    }
  });
  await yard.waitForSelector('.stone');
  await yard.click('.stone [data-action="resurrect"]');
  check(
    await eventually(() => inExt(async (url) => (await browser.tabs.query({})).filter((t) => t.url === url).length === 1, `${origin}/plain`)),
    'Graveyard resurrects the tab',
  );

  check((await form.title()).startsWith('⚰️'), `long-forgotten tab is entombed: "${await form.title()}"`);
  const formId = await inExt(async (url) => (await browser.tabs.query({})).find((t) => t.url === url).id, `${origin}/form`);
  check((await ask({ type: 'discard', tabId: formId })).ok === false, 'tab with unsaved input refuses to be discarded');

  snap = await ask({ type: 'exorcise' });
  check(snap.settings.enabled === false, 'exorcise switches haunting off');
  check(await eventually(async () => (await form.title()) === 'Form page'), 'exorcise restores real titles');
  check((await form.evaluate(() => document.querySelector('#name').value)) === 'half-written message', 'unsaved input is untouched');

  // Discard last: the page goes away, which WebDriver may not enjoy.
  await advance(120 * MIN);
  await ask({ type: 'setSettings', settings: { enabled: true } });
  const plainId = await inExt(async (url) => (await browser.tabs.query({})).find((t) => t.url === url).id, `${origin}/plain`);
  const slept = await ask({ type: 'discard', tabId: plainId });
  const sleptTab = await inExt(async (id) => browser.tabs.get(id), plainId);
  check(slept.ok && sleptTab.discarded, 'a safe ghost tab can be discarded');
} catch (err) {
  console.error(err);
  failures++;
} finally {
  await browser.close().catch(() => {});
  server.close();
  rmSync(extDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
