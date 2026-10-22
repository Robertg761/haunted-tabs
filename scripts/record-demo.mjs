// Records docs/demo.mp4: the built extension in a real, headed Chromium on a
// virtual display (Xvfb), driven by Playwright like a user would, filmed with
// ffmpeg. Nothing is staged: the tabs, the decay and every effect are the real
// extension on local pages, in real time with the 30-second demo threshold. The
// long wait while tabs decay is sped up in the edit, and says so on screen.
//
//   npm run build && node scripts/record-demo.mjs          (records, then edits)
//   node scripts/record-demo.mjs --edit-only               (re-edits the last recording)
//
// Needs Xvfb and ffmpeg. The popup is the real toolbar popup (chrome.action.openPopup),
// driven over the DevTools protocol with puppeteer since Playwright doesn't expose
// it. The recording copy of the extension has its optional <all_urls> permission
// granted up front, as the e2e tests do, because a browser permission prompt
// can't be clicked by automation.
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import puppeteer from 'puppeteer-core';

const OUT = resolve('docs/demo.mp4');
const WORK = resolve('.cache/demo');
const W = 1920;
const H = 1080;
const SCALE = 1.5; // the screen is 1280×720 in browser pixels, so the tab strip reads well
const DISPLAY = ':99';
const FONT = '/usr/share/fonts/opentype/inter/Inter-SemiBold.otf';
const editOnly = process.argv.includes('--edit-only');
mkdirSync(WORK, { recursive: true });
mkdirSync(resolve('docs'), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- local "sites"

const icon = (bg, glyph) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${bg}"/><text x="16" y="23" font-family="Georgia,serif" font-size="20" font-weight="700" text-anchor="middle" fill="#fff">${glyph}</text></svg>`;
const para = (n, text) => Array.from({ length: n }, (_, i) => `<p>${text(i)}</p>`).join('');
const base = (accent) => `
  body { margin: 0; font: 17px/1.65 system-ui, sans-serif; color: #1f2328; background: #fff; }
  header { display: flex; align-items: center; gap: 28px; padding: 14px 40px; background: ${accent}; color: #fff; }
  header b { font-size: 21px; } header span { opacity: .85; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-size: 34px; line-height: 1.2; margin: 8px 0 12px; }
  .meta { color: #59636e; font-size: 14px; margin-bottom: 20px; }
  .hero { height: 220px; border-radius: 12px; margin: 18px 0 24px; }`;

const SITES = {
  'news.example.com': {
    title: 'City council approves riverside plan – The Daily Ledger',
    icon: icon('#b3261e', 'L'),
    body: `<style>${base('#b3261e')} h1{font-family:Georgia,serif} .hero{background:linear-gradient(135deg,#5b6e8a,#a8957a)}</style>
      <header><b>The Daily Ledger</b><span>World</span><span>City</span><span>Business</span><span>Culture</span></header>
      <main><h1>City council approves riverside housing plan after a heated session</h1><div class="meta">By Margaret Hale · 6 min read</div>
      <div class="hero"></div>${para(14, (i) => `The old mill has stood empty since 1987. Paragraph ${i + 1} weighs the traffic, the flood maps and what the neighbours said at the late-night vote, with the final reading due next spring.`)}</main>`,
  },
  'wiki.example.org': {
    title: 'Lighthouse – The Free Field Guide',
    icon: icon('#3d4f63', 'W'),
    body: `<style>${base('#3d4f63')} h1{font-family:Georgia,serif;font-weight:400}</style>
      <header><b>Field Guide</b><span>Article</span><span>Talk</span><span>History</span></header>
      <main><h1>Lighthouse</h1><div class="meta">From the Field Guide</div>${para(12, (i) => `A lighthouse is a tower built to guide ships at night. Section ${i + 1} covers lenses, keepers, storms and the lamps that burned whale oil before kerosene.`)}</main>`,
  },
  'mail.example.com': {
    title: 'Inbox (3) – Mail',
    icon: icon('#1a73e8', '✉'),
    body: `<style>${base('#1a73e8')} .row{display:flex;gap:16px;padding:12px 4px;border-bottom:1px solid #e6e8eb} .row b{width:160px}</style>
      <header><b>Mail</b><span>Inbox (3)</span><span>Sent</span><span>Drafts</span></header>
      <main><h1>Inbox</h1>${Array.from({ length: 12 }, (_, i) => `<div class="row"><b>${['Sam', 'Priya', 'The bank', 'Ana', 'Leo', 'Calendar'][i % 6]}</b><span>${['Lunch on Friday?', 'Your statement is ready', 'Re: the cabin trip', 'Notes from Tuesday', 'Invitation: review', 'Photos from the weekend'][i % 6]}</span></div>`).join('')}</main>`,
  },
  'recipes.example.net': {
    title: "Grandma's pumpkin soup – Recipes",
    icon: icon('#e8710a', 'R'),
    body: `<style>${base('#e8710a')} .hero{background:linear-gradient(135deg,#f6b26b,#cc4125)}</style>
      <header><b>Recipes</b><span>Soups</span><span>Bread</span><span>Desserts</span></header>
      <main><h1>Grandma's pumpkin soup</h1><div class="meta">Serves 4 · 45 minutes</div><div class="hero"></div>${para(10, (i) => `Step ${i + 1}: roast the pumpkin until the edges caramelise, then simmer with onion, a little nutmeg and stock until soft enough to blend.`)}</main>`,
  },
  'docs.example.com': {
    title: 'Getting started – Docs',
    icon: icon('#188038', 'D'),
    body: `<style>${base('#188038')} code{background:#f2f4f7;padding:2px 6px;border-radius:5px}</style>
      <header><b>Docs</b><span>Guides</span><span>Reference</span><span>Changelog</span></header>
      <main><h1>Getting started</h1><div class="meta">Last updated today</div>${para(14, (i) => `Step ${i + 1}: run <code>widgets init</code>, then open the config file and set the fields you need. Everything else has a sensible default.`)}</main>`,
  },
};

// ---------------------------------------------------------------- record

async function record() {
  const marks = {};
  const procs = [];
  const run = (cmd, args, opts = {}) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'], ...opts });
    procs.push(p);
    return p;
  };

  const xvfb = run('Xvfb', [DISPLAY, '-screen', '0', `${W}x${H}x24`, '-nolisten', 'tcp']);
  await sleep(800);

  const server = createServer((req, res) => {
    const site = SITES[(req.headers.host || '').split(':')[0]];
    if (!site) return res.writeHead(404).end();
    if (req.url === '/favicon.svg') return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(site.icon);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${site.title}</title><link rel="icon" href="/favicon.svg"></head><body>${site.body}</body></html>`);
  });
  await new Promise((r) => server.listen(80, '127.0.0.1', r));

  const extDir = mkdtempSync(join(tmpdir(), 'haunt-demo-ext-'));
  cpSync('dist/chrome', extDir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest));

  const hosts = Object.keys(SITES).map((h) => `MAP ${h} 127.0.0.1`).join(', ');
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'haunt-demo-profile-')), {
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    env: { ...process.env, DISPLAY },
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      `--host-resolver-rules=${hosts}`,
      `--force-device-scale-factor=${SCALE}`,
      '--window-position=0,0',
      `--window-size=${W / SCALE},${H / SCALE}`,
      '--no-first-run',
      '--test-type', // no "unsupported command-line flag" bar for the --no-sandbox Playwright adds as root
      '--remote-debugging-port=9333',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--hide-crash-restore-bubble',
    ],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;

  // Real tabs: four to neglect, and the one you're reading.
  const [news, wiki, mail, recipes] = [context.pages()[0], await context.newPage(), await context.newPage(), await context.newPage()];
  await news.goto('http://news.example.com/');
  await wiki.goto('http://wiki.example.org/');
  await mail.goto('http://mail.example.com/');
  await recipes.goto('http://recipes.example.net/');
  const docs = await context.newPage();
  await docs.goto('http://docs.example.com/');
  await docs.bringToFront();
  await sleep(1500);

  // The real toolbar popup, opened under the extension's icon and driven over CDP.
  const devtools = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333', defaultViewport: null });
  const openPopup = async () => {
    await sw.evaluate(() => chrome.action.openPopup());
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      target = devtools.targets().find((t) => t.url().startsWith(`chrome-extension://${extId}/popup/`));
      if (!target) await sleep(100);
    }
    const popup = await target.asPage();
    await popup.waitForSelector('#switch');
    await sleep(700);
    return popup;
  };
  const closePopup = (popup) => popup.evaluate(() => window.close()).catch(() => {});

  const ffmpeg = run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '0', '-video_size', `${W}x${H}`, '-framerate', '30', '-i', DISPLAY, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', join(WORK, 'raw.mkv')]);
  const t0 = Date.now();
  const mark = (name) => {
    marks[name] = (Date.now() - t0) / 1000;
    console.log(`${marks[name].toFixed(1).padStart(6)}s  ${name}`);
  };
  await sleep(1500);

  try {
    // 1. Turn haunting on, with the 30-second demo threshold and no random poltergeists.
    mark('enable');
    let popup = await openPopup();
    await sleep(1800);
    await popup.click('#settings-toggle');
    await sleep(1200);
    await popup.select('#threshold', '0.5');
    await sleep(900);
    await popup.evaluate(() => {
      const p = document.getElementById('poltergeist');
      if (p.checked) p.click();
    });
    await sleep(700);
    await popup.click('#settings-close');
    await sleep(900);
    await popup.click('#switch');
    await sleep(3000);
    await closePopup(popup);
    mark('decay');

    // 2. Leave the other tabs alone. Their titles and favicons rot in the tab strip.
    const stageOf = (title) => (title.startsWith('⚰') ? 'entombed' : title.startsWith('💀') ? 'dead' : title.startsWith('👻') ? 'ghost' : null);
    const realNews = SITES['news.example.com'].title;
    const until = Date.now() + 7 * 60_000;
    while (Date.now() < until) {
      const title = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.includes('news.example.com'))?.title ?? '');
      const stage = stageOf(title) ?? (title && title !== realNews ? 'withering' : null);
      if (stage && marks[stage] === undefined) mark(stage);
      if (marks.entombed !== undefined) break;
      await sleep(500);
    }
    await sleep(2500);

    // 3. Come back to a dead tab: it possesses the screen, then the page itself has decayed.
    mark('possess');
    await news.bringToFront();
    await sleep(11000); // the glitch, then webs, dust, fog, eyes and drips settle in
    mark('sweep');
    for (let i = 0; i < 3; i++) {
      await news.mouse.move(120, 200, { steps: 45 });
      await news.mouse.move(1180, 580, { steps: 60 });
      await news.mouse.move(220, 620, { steps: 45 });
    }
    await news.mouse.wheel(0, 500);
    await sleep(3000);
    mark('popup');

    // 4. The popup is a real tab manager.
    popup = await openPopup();
    await sleep(2600);
    await sleep(1500);

    // 5. Bury two tabs, then bring one back from the Graveyard.
    mark('bury');
    for (const words of ['pumpkin', 'Lighthouse']) {
      const rowId = await popup.evaluate((w) => [...document.querySelectorAll('#list [data-id]')].find((r) => r.textContent.includes(w))?.dataset.id, words);
      await popup.hover(`#list [data-id="${rowId}"]`);
      await sleep(600);
      await popup.click(`#list [data-id="${rowId}"] [data-action="bury"]`);
      await sleep(2200);
    }
    const graveyardOpened = context.waitForEvent('page', (p) => p.url().includes('/graveyard/'));
    await popup.click('#graveyard');
    const graveyard = await graveyardOpened;
    await graveyard.waitForLoadState('domcontentloaded');
    mark('graveyard');
    await sleep(6000);
    await graveyard.locator('.stone', { hasText: 'pumpkin' }).locator('[data-action="resurrect"]').click();
    await sleep(5000);

    // 6. Exorcise: every title, favicon and page goes back to normal.
    mark('exorcise');
    await news.bringToFront();
    await sleep(1500);
    popup = await openPopup();
    await sleep(1600);
    await popup.click('#exorcise');
    await sleep(3500);
    await closePopup(popup);
    await sleep(2500);
    mark('end');
  } finally {
    ffmpeg.stdin.write('q');
    await new Promise((r) => ffmpeg.on('close', r));
    devtools.disconnect();
    await context.close().catch(() => {});
    server.close();
    xvfb.kill();
    rmSync(extDir, { recursive: true, force: true });
  }
  writeFileSync(join(WORK, 'marks.json'), JSON.stringify(marks, null, 2));
  return marks;
}

// ---------------------------------------------------------------- edit

function ffmpeg(args) {
  return new Promise((ok, fail) => {
    const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
    p.on('close', (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited ${code}`))));
  });
}

let captionN = 0;
function caption(text, { y = 'h-118', size = 40, enable } = {}) {
  const file = join(WORK, `caption-${captionN++}.txt`);
  writeFileSync(file, text);
  return `drawtext=fontfile=${FONT}:textfile=${file}:fontsize=${size}:fontcolor=white:x=(w-text_w)/2:y=${y}:box=1:boxcolor=black@0.62:boxborderw=22${enable ? `:enable='${enable}'` : ''}`;
}

async function edit(m) {
  const parts = [];
  const enc = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', '30', '-an'];
  const clip = async (from, to, speed, filters) => {
    const out = join(WORK, `part-${parts.length}.mp4`);
    await ffmpeg(['-ss', String(from), '-to', String(to), '-i', join(WORK, 'raw.mkv'), '-vf', [`setpts=(PTS-STARTPTS)/${speed}`, ...filters].join(','), ...enc, out]);
    parts.push(out);
  };
  const card = async (seconds, lines) => {
    const out = join(WORK, `part-${parts.length}.mp4`);
    const draw = lines.map(([text, y, size]) => caption(text, { y, size }).replace(':box=1:boxcolor=black@0.62:boxborderw=22', ''));
    await ffmpeg(['-f', 'lavfi', '-i', `color=c=0x0d0b14:s=${W}x${H}:d=${seconds}:r=30`, '-vf', draw.join(','), ...enc, out]);
    parts.push(out);
  };

  await card(4, [
    ['Haunted Tabs', 'h/2-130', 96],
    ['A tab manager where the tabs you neglect come back as ghosts.', 'h/2+10', 42],
    ['Real extension, real tabs, filmed in Chromium.', 'h/2+90', 32],
  ]);
  await clip(m.enable, m.decay, 1, [caption('Turn haunting on (here with the 30-second demo threshold)')]);

  // The four-minute wait, sped up to about 20 seconds, labelled with the stage the news tab is in.
  const decayEnd = m.possess;
  const speed = (decayEnd - m.decay) / 18;
  const at = (t) => ((t - m.decay) / speed).toFixed(2);
  const stages = [
    ['withering', 'Withering: the title rots, the favicon cracks'],
    ['ghost', 'Ghost: "You forgot me…"'],
    ['dead', 'Dead: a skull, and a tombstone title'],
    ['entombed', 'Entombed: the grave is dug'],
  ];
  const labels = stages.map(([key, text], i) => {
    const next = stages.slice(i + 1).find(([k]) => m[k] !== undefined);
    const from = m[key] !== undefined ? at(m[key]) : null;
    const to = next ? at(m[next[0]]) : '999';
    return from === null ? null : caption(text, { y: 'h-200', size: 36, enable: `between(t,${from},${to})` });
  });
  await clip(m.decay, decayEnd, speed, [
    caption(`Leave tabs alone and they decay in the tab strip (${Math.round(decayEnd - m.decay)} s, sped up ${speed.toFixed(0)}×)`),
    ...labels.filter(Boolean),
  ]);
  await clip(m.possess - 0.2, m.possess + 2.6, 1, [caption('Return to a dead tab and it possesses your screen')]);
  await clip(m.possess - 0.1, m.possess + 2.2, 0.4, [caption('Again, at 0.4× speed')]);
  await clip(m.possess + 2.6, m.sweep, 1, [caption('Then the page itself has decayed: cobwebs, dust, fog, eyes and drips')]);
  await clip(m.sweep, m.popup, 1, [caption('Sweep the mouse: cobwebs tear and the fog wipes clear')]);
  await clip(m.popup, m.bury, 1, [caption('The popup is a real tab manager: every tab, how long it sat, how far it has rotted')]);
  await clip(m.bury, m.graveyard, 1, [caption('Bury tabs from the popup. Nothing is lost.')]);
  await clip(m.graveyard, m.exorcise, 1, [caption('They wait in the Graveyard, and one click resurrects them')]);
  await clip(m.exorcise, m.end, 1, [caption('Exorcise: every title, favicon and page goes back to normal')]);
  await card(4, [
    ['Haunted Tabs', 'h/2-110', 84],
    ['Opt-in · reversible · never deletes data · no network', 'h/2+10', 40],
    ['Chrome, Edge, Brave · Firefox and Zen', 'h/2+80', 34],
  ]);

  const list = join(WORK, 'parts.txt');
  writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-preset', 'slow', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', OUT]);
  console.log(`wrote ${OUT}`);
  // The submission card: the Graveyard with both buried tabs, before the resurrection.
  await ffmpeg(['-ss', String(m.graveyard + 4.5), '-i', join(WORK, 'raw.mkv'), '-frames:v', '1', resolve('docs/screenshot.png')]);
  console.log(`wrote ${resolve('docs/screenshot.png')}`);
}

const marks = editOnly ? JSON.parse(readFileSync(join(WORK, 'marks.json'), 'utf8')) : await record();
await edit(marks);
