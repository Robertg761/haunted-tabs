// Smoke test for the popup page itself, in a real Chromium with the built extension:
// the switch, the settings sheet, search, grouping, keyboard, bury and exorcise all
// driven through the DOM the way a person would.
//   npm run build && node tests/popup-smoke.mjs
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

// The test build grants host access up front, standing in for the user
// accepting the permission prompt when they switch haunting on.
const extDir = mkdtempSync(join(tmpdir(), 'haunted-ext-'));
cpSync('dist/chrome', extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest));

const pages = {
  '/lantern': 'Lantern notes',
  '/raven': 'Raven recipes',
  '/stories': 'Ghost stories',
  '/tower': 'Bell tower timetable',
};
const server = createServer((req, res) => {
  const title = pages[req.url];
  if (!title) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1></body></html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const userDir = mkdtempSync(join(tmpdir(), 'haunted-profile-'));
const context = await chromium.launchPersistentContext(userDir, {
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  headless: false,
  viewport: { width: 420, height: 600 },
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
    await sleep(100);
  }
  return last;
}

try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  for (const path of Object.keys(pages)) {
    const p = await context.newPage();
    await p.goto(origin + path);
  }
  const popupUrl = `chrome-extension://${extId}/popup/index.html`;
  const popup = context.pages()[0] ?? (await context.newPage());
  const errors = [];
  popup.on('pageerror', (e) => errors.push(String(e)));
  popup.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await popup.goto(popupUrl);
  await popup.bringToFront();
  const ask = (req) => popup.evaluate((req) => chrome.runtime.sendMessage(req), req);
  const snapshot = () => ask({ type: 'snapshot' });
  const liveRows = () => popup.locator('#list .tab:not(.leaving)');
  const active = () => popup.evaluate(() => {
    const a = document.activeElement;
    return { id: a?.id ?? '', cls: a?.className ?? '', action: a?.dataset?.action ?? '' };
  });
  const tabId = async (path) => (await snapshot()).tabs.find((t) => t.url === origin + path)?.id;

  await popup.waitForSelector('#list .tab');
  check(await popup.evaluate(() => document.body.classList.contains('dormant')), 'popup opens dormant');
  check(await popup.isVisible('#intro'), 'the introduction explains the haunting while dormant');
  check(await popup.isDisabled('#exorcise'), 'nothing to exorcise while dormant');

  // The master switch.
  await popup.click('#enabled');
  check(await eventually(async () => (await snapshot()).settings.enabled), 'clicking the switch turns haunting on');
  check(await eventually(() => popup.evaluate(() => !document.body.classList.contains('dormant'))), 'the popup wakes up');
  check((await popup.textContent('#enabled-label')) === 'Haunting', 'switch label says Haunting');
  check(await popup.isVisible('#level'), 'the haunt level appears');
  check(!(await popup.isVisible('#intro')), 'the introduction steps aside');

  // One Tab stop for the whole list, arrows inside it.
  const tabStops = await popup.evaluate(() => [...document.querySelectorAll('#list button')].filter((b) => b.tabIndex >= 0).length);
  check(tabStops === 1, `the list is a single Tab stop (${tabStops})`);
  await popup.focus('#search');
  await popup.keyboard.press('ArrowDown');
  const first = await active();
  check(first.action === 'switch', 'ArrowDown from search lands on the first row');
  await popup.keyboard.press('ArrowDown');
  const second = await popup.evaluate(() => document.activeElement?.closest('[data-id]')?.dataset.id);
  await popup.keyboard.press('ArrowRight');
  const action = await active();
  check(action.action === 'discard' || action.action === 'bury', `ArrowRight reaches the row's actions (${action.action})`);
  check(
    await popup.evaluate((id) => document.querySelector(`[data-id="${id}"] .open`)?.tabIndex === 0, second),
    'the row you visited keeps the Tab stop',
  );

  // Settings sheet: modal, closes with Esc, the close button and the scrim.
  await popup.click('#settings-toggle');
  check(await eventually(() => popup.isVisible('#settings')), 'settings sheet opens');
  check(
    await popup.evaluate(() => document.querySelector('.top').inert && document.getElementById('content').inert),
    'everything behind the sheet is inert',
  );
  check((await active()).id === 'settings-close', 'focus moves into the sheet');
  await popup.focus('#autoBury');
  await popup.keyboard.press('Tab');
  check((await active()).id === 'settings-close', 'Tab wraps around inside the sheet');
  await popup.keyboard.press('Escape');
  check(await eventually(async () => !(await popup.isVisible('#settings'))), 'Esc closes the sheet');
  check((await active()).id === 'settings-toggle', 'focus returns to the settings button');
  await popup.click('#settings-toggle');
  await eventually(() => popup.isVisible('#settings'));
  await popup.click('#settings-close');
  check(await eventually(async () => !(await popup.isVisible('#settings'))), 'the close button closes the sheet');
  await popup.click('#settings-toggle');
  await eventually(() => popup.isVisible('#settings'));
  await popup.mouse.click(40, 20);
  check(await eventually(async () => !(await popup.isVisible('#settings'))), 'clicking outside closes the sheet');

  // A setting persists.
  await popup.click('#settings-toggle');
  await eventually(() => popup.isVisible('#settings'));
  await popup.click('#dust');
  check(await eventually(async () => (await snapshot()).settings.dust === false), 'switching a setting off saves it');
  await popup.reload();
  await popup.waitForSelector('#list .tab');
  await sleep(300);
  check(!(await popup.isChecked('#dust')), 'the setting is still off after reopening');
  await popup.click('#settings-toggle');
  await eventually(() => popup.isVisible('#settings'));
  await popup.click('#dust');
  check(await eventually(async () => (await snapshot()).settings.dust === true), 'and switches back on');
  await popup.keyboard.press('Escape');
  await eventually(async () => !(await popup.isVisible('#settings')));

  // Search.
  await popup.fill('#search', 'raven');
  check(await eventually(async () => (await liveRows().count()) === 1), 'search narrows the list to the match');
  check((await liveRows().first().textContent()).includes('Raven recipes'), 'and it is the right tab');
  check(await popup.isVisible('#search-clear'), 'a clear button appears');
  await popup.fill('#search', 'nothing-goes-by-this-name');
  check(await eventually(() => popup.isVisible('#list .empty')), 'no match shows the empty state');
  await popup.click('#search-clear');
  const total = (await snapshot()).tabs.length;
  check((await popup.inputValue('#search')) === '' && (await eventually(async () => (await liveRows().count()) === total)), 'clearing brings every tab back');

  // Grouping, remembered between openings.
  await popup.selectOption('#group', 'domain');
  check(
    await eventually(async () => (await popup.locator('#list .group-label').allTextContents()).includes('127.0.0.1')),
    'grouping by site groups the local pages',
  );
  await popup.reload();
  await popup.waitForSelector('#list .tab');
  check((await popup.inputValue('#group')) === 'domain', 'the grouping is remembered');
  await popup.selectOption('#group', 'idle');
  check(await eventually(async () => (await popup.locator('#list .group-label').allTextContents()).includes('Alive')), 'grouping by decay works');
  await popup.selectOption('#group', 'window');

  // Bury with the mouse.
  const ravenId = await tabId('/raven');
  const ravenRow = popup.locator(`[data-id="${ravenId}"]`);
  await ravenRow.hover();
  await ravenRow.locator('[data-action="bury"]').click();
  check(await eventually(async () => (await popup.locator(`[data-id="${ravenId}"]`).count()) === 0), 'the buried row leaves the list');
  const open = await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.url));
  check(!open.includes(origin + '/raven'), 'the tab is really closed');
  const graves = await sw.evaluate(async () => (await chrome.storage.local.get('graveyard')).graveyard ?? []);
  check(graves.some((g) => g.url === origin + '/raven'), 'and kept in the Graveyard');
  check(await eventually(async () => (await popup.textContent('#grave-count')) === '1'), 'the Graveyard button counts it');

  // Bury with the keyboard.
  const towerId = await tabId('/tower');
  await popup.focus(`[data-id="${towerId}"] .open`);
  await popup.keyboard.press('Delete');
  check(await eventually(async () => (await popup.locator(`[data-id="${towerId}"]`).count()) === 0), 'Delete buries the focused row');
  check(await eventually(async () => (await active()).action === 'switch'), 'focus lands on a neighbouring row');

  // Backspace in the list is someone fixing their search: it buries nothing.
  const gravesBefore = (await sw.evaluate(async () => (await chrome.storage.local.get('graveyard')).graveyard ?? [])).length;
  await popup.fill('#search', 'lanter');
  await eventually(async () => (await liveRows().count()) === 1);
  await popup.keyboard.press('ArrowDown');
  await popup.keyboard.press('Backspace');
  check((await active()).id === 'search' && (await popup.inputValue('#search')) === 'lante', 'Backspace in the list goes back to the search and edits it');
  await popup.keyboard.press('ArrowDown');
  await popup.keyboard.type('r');
  check((await popup.inputValue('#search')) === 'lanter', 'typing in the list types into the search');
  await popup.fill('#search', '');
  await sleep(200);
  const gravesAfter = (await sw.evaluate(async () => (await chrome.storage.local.get('graveyard')).graveyard ?? [])).length;
  check(gravesAfter === gravesBefore, 'and nothing was buried');

  // A double Delete buries once, without an error.
  const storiesId = await tabId('/stories');
  await popup.focus(`[data-id="${storiesId}"] .open`);
  await popup.evaluate(() => {
    for (let i = 0; i < 2; i++) document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  });
  check(await eventually(async () => (await popup.locator(`[data-id="${storiesId}"]`).count()) === 0), 'a double Delete buries the row');
  await sleep(500);
  const buried = (await sw.evaluate(async () => (await chrome.storage.local.get('graveyard')).graveyard ?? [])).length;
  check(buried === gravesAfter + 1, `exactly once (${buried - gravesAfter})`);
  check(await popup.isHidden('#notice'), 'and no error is shown');

  // A row whose tab closed elsewhere since the last refresh.
  const lanternId = await tabId('/lantern');
  await sw.evaluate((id) => chrome.tabs.remove(id), lanternId);
  await popup.evaluate((id) => document.querySelector(`[data-id="${id}"] .open`)?.click(), lanternId);
  await sleep(400);
  const gone = (await popup.isVisible('#notice')) ? await popup.textContent('#notice') : '';
  check(!/refused|error/i.test(gone), `a tab closed meanwhile gets a gentle answer${gone ? ` ("${gone}")` : ''}`);

  // Reopening lays the popup out as it was before the first answer arrives.
  check(await popup.evaluate(() => JSON.parse(localStorage.getItem('boot') ?? 'null')?.[0] === 1), 'the popup remembers it was haunting');

  // Exorcise.
  await popup.focus('#exorcise');
  await popup.keyboard.press('Enter');
  check(await eventually(() => popup.isVisible('#banish'), 1000), 'Exorcise plays its ritual');
  check(await eventually(async () => !(await snapshot()).settings.enabled), 'Exorcise turns haunting off');
  check(await eventually(() => popup.evaluate(() => document.body.classList.contains('dormant'))), 'the popup goes dormant again');
  check((await active()).id === 'enabled', 'keyboard focus moves to the switch');

  // A popup squeezed below 600px keeps its footer on screen.
  await popup.setViewportSize({ width: 420, height: 500 });
  const fits = await eventually(() =>
    popup.evaluate(() => document.getElementById('exorcise').getBoundingClientRect().bottom <= innerHeight && document.documentElement.scrollHeight <= innerHeight),
  );
  check(fits, 'a shorter popup shrinks the list, not the footer');

  check(errors.length === 0, `no errors on the page${errors.length ? `: ${errors.join(' | ')}` : ''}`);
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
