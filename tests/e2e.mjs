// End-to-end check against a real Chromium with the built extension loaded.
// Serves a few local pages, turns haunting on, fast-forwards the worker's clock,
// and checks real tabs decay, possess, get buried, resurrect, and exorcise.
//   npm run e2e            (set SHOTS=dir to save screenshots)
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const MIN = 60_000;
const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

// The test build grants host access up front, standing in for the user
// accepting the permission prompt when they switch haunting on.
const extDir = mkdtempSync(join(tmpdir(), 'haunted-ext-'));
cpSync('dist/chrome', extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest));

const FAV = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#e33"/></svg>`;
const pages = {
  '/alpha': `<title>Alpha page</title><link rel="icon" href="/fav.svg"><h1 style="font:48px sans-serif">Alpha: a perfectly normal page</h1><p>Lorem ipsum dolor sit amet.</p>`,
  '/form': `<title>Form page</title><link rel="icon" href="/fav.svg"><form><input id="name"><textarea></textarea></form>`,
  '/plain': `<title>Plain page</title><p>No favicon here.</p>`,
  '/editor': `<title>Editor page</title><div contenteditable="true"><p>A draft the page loaded or someone typed</p></div>`,
  '/ticker': `<title>Ticker 0</title><link rel="icon" href="/fav.svg"><script>let n=0;setInterval(()=>{document.title='Ticker '+(++n)},300)</script>`,
};
const server = createServer((req, res) => {
  if (req.url === '/fav.svg') {
    res.writeHead(200, { 'content-type': 'image/svg+xml' });
    return res.end(FAV);
  }
  const body = pages[req.url];
  if (body === undefined) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const userDir = mkdtempSync(join(tmpdir(), 'haunted-profile-'));
const context = await chromium.launchPersistentContext(userDir, {
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  headless: false,
  viewport: { width: 1000, height: 640 },
  args: ['--headless=new', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
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
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;

  // Shift the worker's clock instead of waiting for hours.
  await sw.evaluate(() => {
    const realNow = Date.now.bind(Date);
    self.__offset = 0;
    Date.now = () => realNow() + self.__offset;
  });
  const advance = (ms) => sw.evaluate((ms) => (self.__offset += ms), ms);
  const tabTitle = (url) => sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.title, url);

  const control = context.pages()[0] ?? (await context.newPage());
  await control.goto(`chrome-extension://${extId}/popup/index.html`);
  const ask = (req) => control.evaluate((req) => chrome.runtime.sendMessage(req), req);

  const alpha = await context.newPage();
  await alpha.goto(`${origin}/alpha`);
  const form = await context.newPage();
  await form.goto(`${origin}/form`);
  const plain = await context.newPage();
  await plain.goto(`${origin}/plain`);
  const ticker = await context.newPage();
  await ticker.goto(`${origin}/ticker`);
  await form.bringToFront();
  await form.fill('#name', 'half-written message');
  await control.bringToFront();
  await sleep(300);

  let snap = await ask({ type: 'snapshot' });
  check(snap.settings.enabled === false, 'haunting is off until the user opts in');
  check(snap.tabs.length >= 5, `popup sees every real tab (${snap.tabs.length})`);
  check((await alpha.title()) === 'Alpha page', 'nothing is touched while dormant');

  // Poltergeists are random; they get their own check below.
  snap = await ask({ type: 'setSettings', settings: { enabled: true, thresholdMinutes: 30, poltergeist: false } });
  check(snap.settings.enabled && snap.hostPermission, 'haunting turns on');
  check((await alpha.title()) === 'Alpha page', 'fresh tabs stay alive');

  await advance(31 * MIN);
  await ask({ type: 'setSettings', settings: {} });
  const withered = await alpha.title();
  check(withered !== 'Alpha page' && !withered.startsWith('👻'), `withering title rots: "${withered}"`);
  check(await alpha.evaluate(() => !!document.querySelector('link[data-haunted-tabs][rel=icon]')), 'favicon replaced');
  check(await alpha.evaluate(() => !document.querySelector('link[href="/fav.svg"]')), 'real favicon set aside, not deleted');

  await advance(30 * MIN);
  await ask({ type: 'setSettings', settings: {} });
  check((await alpha.title()).startsWith('👻'), `ghost title: "${await alpha.title()}"`);
  const stripTitle = await tabTitle(`${origin}/alpha`);
  check(stripTitle?.startsWith('👻'), 'tab strip shows the ghost title');
  snap = await ask({ type: 'snapshot' });
  const alphaView = snap.tabs.find((t) => t.url.endsWith('/alpha'));
  check(alphaView?.title === 'Alpha page', 'popup still shows the real title');
  check(alphaView?.stage === 2, 'popup reports ghost stage');
  const paintedRecord = await sw.evaluate(async () => (await chrome.storage.local.get('painted')).painted);
  check(
    paintedRecord?.[`${origin}/alpha`]?.some((e) => e.painted === stripTitle && e.real === 'Alpha page'),
    'painted pages are remembered per tab, surviving a restart',
  );

  // Discarding itself can't run here (Playwright drops the whole context when a
  // tab is discarded), but the safety check in front of it can.
  const formId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${origin}/form`);
  const refused = await ask({ type: 'discard', tabId: formId });
  check(refused.ok === false, 'tab with unsaved input refuses to be discarded');
  const kept = await ask({ type: 'bury', tabId: formId });
  const stillOpen = await sw.evaluate(async (id) => !!(await chrome.tabs.get(id).catch(() => null)), formId);
  check(kept.ok === false && stillOpen, 'closing a tab with unsaved input from the popup is refused');

  // A page that keeps rewriting its own title stays haunted.
  await sleep(1000);
  check((await ticker.title()).startsWith('👻'), `self-retitling page stays haunted: "${await ticker.title()}"`);

  await advance(61 * MIN);
  await ask({ type: 'setSettings', settings: {} });
  check((await alpha.title()).startsWith('💀'), `dead title: "${await alpha.title()}"`);
  snap = await ask({ type: 'snapshot' });
  check(snap.level.index >= 2, `haunt level rises: ${snap.level.name}`);

  // Poltergeist: with chance forced, a dead tab flickers its title.
  await sw.evaluate(() => {
    self.__random = Math.random;
    Math.random = () => 0;
  });
  await advance(20 * MIN);
  await ask({ type: 'setSettings', settings: { poltergeist: true } });
  const flickered = await eventually(async () => {
    const t = await alpha.title();
    return t === '👁 👁' || t === '…help…' || (!t.startsWith('💀') && t !== 'Alpha page');
  }, 3000);
  check(flickered, 'poltergeist flickers a dead tab title');
  check(await eventually(async () => (await alpha.title()).startsWith('💀'), 4000), 'flicker settles back to the haunting');
  await sw.evaluate(() => (Math.random = self.__random));
  await ask({ type: 'setSettings', settings: { poltergeist: false } });

  // Returning to a dead tab: it possesses the screen, then comes back to life.
  await alpha.bringToFront();
  const glitched = await eventually(() => alpha.evaluate(() => !!document.querySelector('[data-haunted-tabs="glitch"]')), 2000);
  check(glitched, 'returning to a dead tab triggers the glitch');
  if (shots && glitched) {
    await sleep(350);
    await alpha.screenshot({ path: join(shots, 'possession.png') });
  }
  const restored = await eventually(async () => (await alpha.title()) === 'Alpha page', 4000);
  check(restored, 'real title comes back after the possession');
  check(await alpha.evaluate(() => !!document.querySelector('link[href="/fav.svg"]') && !document.querySelector('link[data-haunted-tabs][rel=icon]')), 'real favicon restored');
  check(await alpha.evaluate(() => !document.querySelector('[data-haunted-tabs="glitch"]')), 'glitch overlay cleaned up');
  const webs = () => alpha.evaluate(() => Number(document.querySelector('[data-haunted-tabs="cobwebs"]')?.dataset.webs ?? 0));
  check((await webs()) >= 4, `a long-dead tab is full of cobwebs (${await webs()})`);
  const effectsOn = () => alpha.evaluate(() => [...document.querySelectorAll('[data-haunted-tabs^="effect-"]')].map((e) => e.getAttribute('data-haunted-tabs')).sort());
  const greeted = await eventually(async () => (await effectsOn()).length >= 3 && (await effectsOn()), 3000);
  check(
    JSON.stringify(greeted) === JSON.stringify(['effect-dust', 'effect-eyes', 'effect-fog']),
    `a dead tab is greeted by dust, fog and eyes (${greeted})`,
  );
  if (shots) await alpha.screenshot({ path: join(shots, 'cobwebs.png') });
  // Switching one effect off fades it out of the open page and leaves the rest running.
  await ask({ type: 'setSettings', settings: { fog: false } });
  const unfogged = await eventually(async () => !(await effectsOn()).includes('effect-fog') && (await effectsOn()), 4000);
  check(JSON.stringify(unfogged) === JSON.stringify(['effect-dust', 'effect-eyes']), `turning fog off clears it from the page (${unfogged})`);
  await ask({ type: 'setSettings', settings: { fog: true } });
  for (let i = 0; i < 8; i++) {
    await alpha.mouse.move(980, 620, { steps: 14 });
    await alpha.mouse.move(20, 20, { steps: 14 });
    await alpha.mouse.move(980, 20, { steps: 14 });
    await alpha.mouse.move(20, 620, { steps: 14 });
  }
  const swept = await eventually(async () => (await webs()) < 4, 4000);
  check(swept, `sweeping the mouse tears cobwebs away (${await webs()} left)`);
  // Pinned and audible tabs must never be touched: pinning one clears its webs.
  const alphaId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${origin}/alpha`);
  const websBefore = await webs();
  await sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'haunt:cobwebs', webs: 3, growAfterMs: 60_000 }), alphaId);
  check((await webs()) === websBefore + 3, 'webs can be laid on a tab');
  await sw.evaluate((id) => chrome.tabs.update(id, { pinned: true }), alphaId);
  check(
    await eventually(() => alpha.evaluate(() => !document.querySelector('[data-haunted-tabs="cobwebs"]')), 4000),
    'pinning a tab clears its cobwebs',
  );
  await sw.evaluate((id) => chrome.tabs.update(id, { pinned: false }), alphaId);

  // Manual close from the popup also lands in the Graveyard.
  const tickerId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${origin}/ticker`);
  await ask({ type: 'bury', tabId: tickerId });
  const graves2 = await sw.evaluate(async () => (await chrome.storage.local.get('graveyard')).graveyard);
  check(graves2.some((g) => g.url.endsWith('/ticker') && g.cause === 'you'), 'closing from the popup buries the tab');

  // Burial: only safe tabs go to the Graveyard. Alpha stays in view.
  await advance(250 * MIN);
  await ask({ type: 'setSettings', settings: { autoBury: true } });
  await sleep(500);
  const open = await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.url));
  check(!open.some((u) => u.endsWith('/plain')), 'entombed tab is buried');
  check(open.some((u) => u.endsWith('/form')), 'tab with unsaved input is never buried');
  check(open.some((u) => u.endsWith('/alpha')), 'the tab in view survives');
  const graves = await sw.evaluate(async () => (await chrome.storage.local.get('graveyard')).graveyard);
  check(graves?.some((g) => g.url.endsWith('/plain') && g.title === 'Plain page'), 'grave keeps the real URL and title');
  await ask({ type: 'setSettings', settings: { autoBury: false } });

  // Resurrect from the Graveyard page.
  const yard = await context.newPage();
  await yard.goto(`chrome-extension://${extId}/graveyard/index.html`);
  await yard.waitForSelector('.stone');
  check((await yard.locator('.stone').count()) === 2, 'Graveyard lists the buried tabs');
  if (shots) await yard.screenshot({ path: join(shots, 'graveyard.png') });
  await yard.locator('.stone', { hasText: 'Plain page' }).getByRole('button', { name: /Resurrect/ }).click();
  const back = await eventually(() => sw.evaluate(async (url) => (await chrome.tabs.query({ url })).length === 1, `${origin}/plain`));
  check(back, 'resurrected tab is open again');
  check(await eventually(async () => (await yard.locator('.stone').count()) === 1), 'its grave is gone');

  // Exorcise restores every haunted tab.
  check((await form.title()).startsWith('⚰️'), `long-forgotten tab is entombed: "${await form.title()}"`);
  await control.bringToFront();
  if (shots) {
    await control.setViewportSize({ width: 420, height: 600 });
    await control.reload();
    await sleep(800);
    await control.screenshot({ path: join(shots, 'popup.png') });
  }
  // A frozen or hung tab can't answer during Exorcise. It must stay marked and be
  // cleaned up once it responds, not silently left haunted. Blocking the page's
  // main thread makes it unresponsive the same way (content scripts share it).
  await sw.evaluate((url) => {
    chrome.tabs.query({ url }).then(([t]) =>
      chrome.scripting.executeScript({ target: { tabId: t.id }, world: 'MAIN', func: () => { const end = Date.now() + 7000; while (Date.now() < end); } }),
    );
  }, `${origin}/form`);
  await sleep(300);
  snap = await ask({ type: 'exorcise' });
  check(snap.settings.enabled === false, 'exorcise switches haunting off');
  check((await alpha.title()) === 'Alpha page', 'exorcise restores the tabs that can answer');
  const pending = () =>
    sw.evaluate(async (url) => {
      const [t] = await chrome.tabs.query({ url });
      const st = (await chrome.storage.session.get('hauntState')).hauntState;
      return { marked: !!st.records[t.id]?.needsExorcise, alarm: !!(await chrome.alarms.get('haunt-tick')) };
    }, `${origin}/form`);
  const during = await pending();
  check(during.marked && during.alarm, 'an unresponsive tab stays marked and the retry alarm keeps running');
  await sleep(7000); // the page comes back
  await ask({ type: 'setSettings', settings: {} }); // stands in for the next alarm tick
  check(await eventually(async () => (await form.title()) === 'Form page'), 'it is restored once it responds');
  const after = await pending();
  check(!after.marked && !after.alarm, 'then the mark and the retry alarm are cleared');
  check((await form.inputValue('#name')) === 'half-written message', 'unsaved input is untouched');
  check(await form.evaluate(() => !document.querySelector('link[data-haunted-tabs][rel=icon]')), 'exorcise restores favicons');
  check(
    await eventually(() => alpha.evaluate(() => !document.querySelector('[data-haunted-tabs="cobwebs"]')), 4000),
    'exorcise sweeps away the cobwebs',
  );
  check(
    await eventually(() => alpha.evaluate(() => !document.querySelector('[data-haunted-tabs^="effect-"]')), 5000),
    'exorcise clears every page effect',
  );
  const badge = await sw.evaluate(() => chrome.action.getBadgeText({}));
  check(badge === '', 'badge cleared');

  // Chrome reports pushState and #hash changes as page loads. A dead tab that
  // updates its own URL right after possessing you must not possess you twice.
  await ask({ type: 'setSettings', settings: { enabled: true } });
  await advance(130 * MIN);
  await ask({ type: 'setSettings', settings: {} });
  const plainPage = context.pages().find((p) => p.url() === `${origin}/plain`);
  check(/^(💀|⚰️)/.test((await plainPage?.title()) ?? ''), `a resurrected tab can die again: "${await plainPage?.title()}"`);
  const glitchShown = () => plainPage.evaluate(() => !!document.querySelector('[data-haunted-tabs="glitch"]'));
  await plainPage.bringToFront();
  check(await eventually(glitchShown, 2000), 'it possesses the screen when you return');
  // The tab strip still shows the tombstone while the possession plays. It is not the page's name.
  const midPossession = (await ask({ type: 'snapshot' })).tabs.find((t) => t.url === `${origin}/plain`);
  check(midPossession?.title === 'Plain page', `the popup shows the real title mid-possession ("${midPossession?.title}")`);
  check(await eventually(async () => !(await glitchShown()) && (await plainPage.title()) === 'Plain page', 4000), 'and lets go');
  const plainWebs = () => plainPage.evaluate(() => Number(document.querySelector('[data-haunted-tabs="cobwebs"]')?.dataset.webs ?? 0));
  const websAfterVisit = await eventually(plainWebs, 2000);
  await plainPage.evaluate(() => history.replaceState({ view: 1 }, '', location.href));
  await plainPage.evaluate(() => history.pushState({}, '', '/plain?view=2'));
  await plainPage.evaluate(() => (location.hash = 'section'));
  check(!(await eventually(glitchShown, 2500)), 'a replaceState, pushState or #hash change straight after does not possess it again');
  check((await plainWebs()) <= websAfterVisit, `nor lay a second set of webs (${websAfterVisit} → ${await plainWebs()})`);
  check((await plainPage.title()) === 'Plain page', 'the page keeps its real title');
  const later = (await ask({ type: 'snapshot' })).tabs.find((t) => t.url.startsWith(`${origin}/plain`));
  check(later?.title === 'Plain page', `and the popup remembers it ("${later?.title}")`);
  await ask({ type: 'exorcise' });

  // The Graveyard removes graves through the worker, in the same queue as burials.
  const gravesNow = async () => (await sw.evaluate(async () => (await chrome.storage.local.get('graveyard')).graveyard)) ?? [];
  const before = await gravesNow();
  const plainTabId = await sw.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url.startsWith(url))?.id, `${origin}/plain`);
  const [removeRes] = await Promise.all([
    ask({ type: 'removeGraves', ids: before.map((g) => g.id) }),
    ask({ type: 'bury', tabId: plainTabId }),
  ]);
  const afterGraves = await gravesNow();
  check(removeRes?.ok === true, 'removeGraves answers ok');
  check(
    afterGraves.length === 1 && afterGraves[0].url.startsWith(`${origin}/plain`) && !afterGraves.some((g) => before.some((b) => b.id === g.id)),
    `removing graves never loses a burial made at the same moment (${afterGraves.length} left)`,
  );

  // Closing from the popup skips the leave-page prompt. A page that cannot be
  // checked for unsaved input (here: too busy to answer) must not be closed.
  const busyPage = await context.newPage();
  await busyPage.goto(`${origin}/form#busy`);
  await busyPage.fill('#name', 'unsaved thoughts');
  const busyId = await sw.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url).id, `${origin}/form#busy`);
  await control.bringToFront();
  await sw.evaluate((id) => {
    chrome.scripting.executeScript({ target: { tabId: id }, world: 'MAIN', func: () => { const end = Date.now() + 5000; while (Date.now() < end); } });
  }, busyId);
  await sleep(300);
  const busyBury = await ask({ type: 'bury', tabId: busyId });
  check(busyBury.ok === false && /isn't responding/.test(busyBury.reason ?? ''), `a tab that cannot be checked is not closed (${busyBury.reason})`);
  const insisted = await ask({ type: 'bury', tabId: busyId, force: true });
  check(insisted.ok === false, 'and burying it again does not force a busy page closed');
  await sleep(5000);
  check((await busyPage.inputValue('#name')) === 'unsaved thoughts', 'and its input is still there');
  await busyPage.close();

  // An editor holding text we never saw typed is a doubt the user may settle by burying again.
  const editorPage = await context.newPage();
  await editorPage.goto(`${origin}/editor`);
  const editorId = await sw.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url).id, `${origin}/editor`);
  await control.bringToFront();
  const doubt = await ask({ type: 'bury', tabId: editorId });
  check(doubt.ok === false && doubt.unchecked === true && /editor/.test(doubt.reason ?? ''), `an editor with text is not closed at first (${doubt.reason})`);
  const settled = await ask({ type: 'bury', tabId: editorId, force: true });
  const editorGone = await sw.evaluate(async (id) => !(await chrome.tabs.get(id).catch(() => null)), editorId);
  check(settled.ok === true && editorGone, 'burying it again closes it');

} catch (err) {
  console.error(err);
  failures++;
} finally {
  await context.close();
  server.close();
  rmSync(userDir, { recursive: true, force: true });
  rmSync(extDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
