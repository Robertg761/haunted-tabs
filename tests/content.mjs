// The content script in a real Chromium: title and icon paint, double injection, orphaned copies,
// unsaved-input detection (shadow roots, editor frames) and overlay stacking.   npm run test:content
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const pages = {
  '/a': `<title>Real title</title><link rel="icon" href="/fav.svg"><link rel="apple-touch-icon" href="/t.png"><p>hi`,
  '/controls': `<title>Controls</title><input type="color"><input type="range"><input type="date" value="garbage"><input value="a&#10;b">
    <select><option>One<option>Two</select><select><option disabled>Pick<option>A<option>B</select><select multiple><option>x<option selected>y</select><textarea>hello</textarea>`,
  '/changed-select': `<title>S</title><select id=s><option>One<option>Two</select>`,
  '/shadow': `<title>Shadow</title><div id=h></div><script>const r = document.getElementById('h').attachShadow({mode:'open'}); r.innerHTML = '<input id=i>';</script>`,
  '/frame': `<title>Frame</title><iframe id=f srcdoc="<body contenteditable>hello</body>"></iframe>`,
  '/closed': `<title>C</title><x-field></x-field><button id=b>b</button><script>customElements.define('x-field',class extends HTMLElement{constructor(){super();const r=this.attachShadow({mode:'closed'});r.innerHTML='<input id=i>';window.__inner=r.querySelector('input')}})</script>`,
  '/tiny': `<title>T</title><iframe id=f srcdoc="<div contenteditable id=e style='height:50px'></div>"></iframe><button id=b>b</button>`,
  '/transformed': `<title>X</title><style>html{transform:translateZ(0)}</style><p>text`,
};
const server = createServer((req, res) => {
  if (req.url === '/fav.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg"/>'); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8">${pages[req.url] ?? ''}</html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const extDir = mkdtempSync(join(tmpdir(), 'haunt-ext-'));
cpSync(process.env.EXT_DIR || 'dist/chrome', extDir, { recursive: true });
const m = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
m.host_permissions = ['<all_urls>'];
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(m));
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'p-')), {
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: false,
  args: ['--headless=new', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
await sleep(800);
let failures = 0;
const check = (c, label) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${label}`); if (!c) failures++; };
const tab = ctx.pages()[0];
const send = (path, cmd, inject = true) => sw.evaluate(async ([url, cmd, inject]) => {
  const [t] = await chrome.tabs.query({ url });
  try {
    if (inject) await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] });
    return await chrome.tabs.sendMessage(t.id, cmd);
  } catch (e) { return 'ERR ' + e.message; }
}, [origin + path, cmd, inject]);
const orphan = (path, dead) => sw.evaluate(async ([url, dead]) => {
  const [t] = await chrome.tabs.query({ url });
  const [r] = await chrome.scripting.executeScript({ target: { tabId: t.id }, args: [dead], func: (dead) => {
    if (dead) Object.defineProperty(chrome.runtime, 'id', { get: () => undefined, configurable: true });
    else delete chrome.runtime.id;
    return String(chrome.runtime.id);
  } });
  return r.result;
}, [origin + path, dead]);
const icons = () => tab.evaluate(() => [...document.querySelectorAll('link')].map((l) => `${l.rel}=${l.getAttribute('href').slice(0, 20)}${l.hasAttribute('data-haunted-tabs') ? '*' : ''}`).join(' '));

try {
  // --- title and icon
  await tab.goto(origin + '/a');
  let r = await send('/a', { type: 'haunt:apply', title: process.env.GT || '👻 You  forgot me ', icon: 'data:image/svg+xml,<svg/>' });
  check(r?.realTitle === 'Real title', `apply reports the real title (${JSON.stringify(r)})`);
  await sleep(200);
  check((await tab.title()) === '👻 You forgot me', `ghost title with odd whitespace settles (${await tab.title()})`);
  r = await send('/a', { type: 'haunt:apply', title: process.env.GT || '👻 You  forgot me ', icon: 'data:image/svg+xml,<svg/>' });
  check(r?.realTitle === 'Real title', `second injection keeps one copy and the real title (${JSON.stringify(r)})`);
  check((await icons()) === 'apple-touch-icon=/t.png icon=data:image/svg+xml,<*', `only our icon left, touch icon untouched (${await icons()})`);
  await tab.evaluate(() => { document.title = 'Inbox (3)'; });
  await sleep(100);
  check((await tab.title()) === '👻 You forgot me', 'page retitle is painted over');
  // A favicon badge script grabbing the only icon link.
  await tab.evaluate(() => document.querySelector('link[rel~=icon]').setAttribute('href', '/badge.png'));
  await sleep(100);
  check((await icons()).includes('icon=data:image/svg+xml,<*') && !(await icons()).includes('badge'), `ghost icon kept when a script repoints it (${await icons()})`);
  r = await send('/a', { type: 'haunt:restore' });
  await sleep(100);
  check((await tab.title()) === 'Inbox (3)', `restore gives back the page's latest title (${await tab.title()})`);
  check((await icons()) === 'icon=/fav.svg apple-touch-icon=/t.png icon=/badge.png', `restore gives back the page's icons (${await icons()})`);
  r = await send('/a', { type: 'haunt:apply', title: 'Ghost', icon: 'data:,x' });
  r = await send('/a', { type: 'haunt:restore' });
  check(!(await icons()).includes('restored'), 'no fallback left when the page had icons');

  // --- orphaned copy: make every copy in this world look orphaned, inject a fresh one, check the old let go.
  r = await send('/a', { type: 'haunt:apply', title: 'Ghost', icon: 'data:,x' });
  r = await send('/a', { type: 'haunt:cobwebs', webs: 2, growAfterMs: 0 });
  await sleep(300);
  await orphan('/a', true);
  await sw.evaluate(async (url) => { const [t] = await chrome.tabs.query({ url }); await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] }); }, origin + '/a');
  await sleep(100);
  check((await tab.title()) === 'Inbox (3)', `orphaned copy gives back the title when a fresh one arrives (${await tab.title()})`);
  check((await tab.evaluate(() => document.querySelectorAll('[data-haunted-tabs="cobwebs"]').length)) === 0, 'orphaned copy removes its webs');
  await orphan('/a', false);

  // --- unsaved input
  await tab.goto(origin + '/controls');
  r = await send('/controls', { type: 'haunt:dirty' });
  check(r?.dirty === false, `untouched colour/range/date/select/textarea are not unsaved (${JSON.stringify(r)})`);
  await tab.goto(origin + '/changed-select');
  await send('/changed-select', { type: 'haunt:ping' });
  await tab.selectOption('#s', 'Two');
  r = await send('/changed-select', { type: 'haunt:dirty' }, false);
  check(r?.dirty === true, 'a changed select is unsaved');
  await tab.goto(origin + '/shadow');
  r = await send('/shadow', { type: 'haunt:dirty' });
  check(r?.dirty === false, 'empty shadow input is clean');
  await tab.evaluate(() => { const i = document.getElementById('h').shadowRoot.getElementById('i'); i.value = 'typed'; });
  r = await send('/shadow', { type: 'haunt:dirty' }, false);
  check(r?.dirty === true, 'a filled field in a shadow root is unsaved');
  await tab.goto(origin + '/shadow');
  await send('/shadow', { type: 'haunt:ping' });
  await tab.locator('#h >> input').click();
  await tab.keyboard.type('x');
  await tab.locator('#h >> input').evaluate((i) => { i.value = ''; });
  r = await send('/shadow', { type: 'haunt:dirty' }, false);
  check(r?.dirty === true, 'typing in a shadow root is noticed');
  await tab.goto(origin + '/frame');
  r = await send('/frame', { type: 'haunt:dirty' });
  check(r?.dirty === true && r?.sure === false, 'an editor frame holding text we never saw typed is a doubt, not a certainty');
  await tab.frameLocator('#f').locator('body').click();
  r = await send('/frame', { type: 'haunt:dirty' }, false);
  check(r?.dirty === true, 'focus in a same-origin editor frame counts');

  // --- closed shadow root and a TinyMCE-style frame: type, then click away
  for (const path of ['/closed', '/tiny']) {
    await tab.goto(origin + path);
    await send(path, { type: 'haunt:ping' });
    if (path === '/tiny') await tab.frameLocator('#f').locator('#e').click();
    else await tab.evaluate(() => window.__inner.focus());
    await tab.keyboard.type('draft reply');
    await tab.click('#b');
    r = await send(path, { type: 'haunt:dirty' }, false);
    check(r?.dirty === true, `typing then leaving ${path} counts as unsaved (${JSON.stringify(r)})`);
  }
  // A fresh copy taking over keeps what the old one saw typed (value cleared, so only the mark remembers).
  await tab.goto(origin + '/closed');
  await send('/closed', { type: 'haunt:ping' });
  await tab.evaluate(() => window.__inner.focus());
  await tab.keyboard.type('x');
  await tab.evaluate(() => { window.__inner.value = ''; });
  await orphan('/closed', true);
  await sw.evaluate(async (url) => { const [t] = await chrome.tabs.query({ url }); await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] }); }, origin + '/closed');
  await orphan('/closed', false);
  r = await send('/closed', { type: 'haunt:dirty' }, false);
  check(r?.dirty === true, `takeover keeps the unsaved mark (${JSON.stringify(r)})`);

  // --- top layer keeps Z order on a transformed root
  await tab.goto(origin + '/transformed');
  await send('/transformed', { type: 'haunt:ping' });
  await sw.evaluate(async (url) => {
    const [t] = await chrome.tabs.query({ url });
    await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => {
      window.__shown = [];
      const show = HTMLElement.prototype.showPopover;
      const hide = HTMLElement.prototype.hidePopover;
      HTMLElement.prototype.showPopover = function () { window.__shown = window.__shown.filter((x) => x !== this); window.__shown.push(this); return show.call(this); };
      HTMLElement.prototype.hidePopover = function () { window.__shown = window.__shown.filter((x) => x !== this); return hide.call(this); };
    } });
  }, origin + '/transformed');
  await send('/transformed', { type: 'haunt:cobwebs', webs: 2, growAfterMs: 0 }, false);
  await sleep(300);
  await send('/transformed', { type: 'haunt:effects', effects: ['dust', 'fog'], stage: 2, idleMs: 3_700_000, seed: 1 }, false);
  await sleep(500);
  const order = await sw.evaluate(async (url) => {
    const [t] = await chrome.tabs.query({ url });
    const [res] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => window.__shown.filter((h) => h.isConnected && h.matches(':popover-open')).map((h) => h.getAttribute('data-haunted-tabs')).join(',') });
    return res.result;
  }, origin + '/transformed');
  check(order === 'effect-dust,effect-fog,cobwebs', `lifted overlays stack in Z order (${order})`);
} catch (e) {
  console.error(e);
  failures++;
} finally {
  await ctx.close();
  server.close();
}
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
