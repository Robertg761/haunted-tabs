# haunted-tabs

A haunted tab manager browser extension. It manages your real tabs, and neglected ones come back as ghosts.

Solo entry for [Hackyard Yard #5: Haunted](https://hackyard.tech/yards/yard-5).

- `SPEC.md` describes what is being built.
- `HACKYARD.md` lists the rules, dates, and the submission checklist.
- `AGENTS.md` has instructions for AI coding agents.

## What it does

Haunted Tabs is a working tab manager: the popup lists every open tab across windows, with search, switch, close, and how long each tab has sat idle. You can group them by window, by site, or by how far they've decayed.

Turn haunting on and tabs you leave alone start to **decay**. Every stage starts at a multiple of the idle threshold (default 30 minutes):

| Idle for | Stage | Title | Favicon |
| --- | --- | --- | --- |
| 1x (30m) | 🥀 Withering | The real title slowly rots: letters swap for lookalikes and pick up glitch marks | The site's own icon, drained of colour and cracked |
| 2x (1h) | 👻 Ghost | `👻 You forgot me on github.com`, `👻 I waited an hour for you`… | Ghost |
| 4x (2h) | 💀 Dead | `💀 Here lies Inbox (3)`, `💀 Don't look behind you`… | Skull with red eyes |
| 8x (4h) | ⚰️ Entombed | `⚰️ The grave for youtube.com is dug`… | Tombstone |

When you return to a **dead** tab it **possesses your screen** for a second or so. The page drains to a dim, washed-out grey, signal tears and colour bands slide across it, and a message like `I WAITED 3 HOURS` types itself out and holds, with a pale face surfacing above it for one beat. Then the message collapses into a line, the screen lets go, and the tab is back to normal with its real title and icon. Nothing on the page is moved or restyled: it all happens on an overlay. Titles in any script work, including Arabic, Hebrew, Devanagari and emoji.

Neglected pages also gather **cobwebs**. When you come back to a stale tab, its corners and open spaces are strung with webs: 2 for a withering tab, up to 5 for an entombed one, and a spider dangles on its thread. Some threads are glued to the window frame and some to the page itself. Scrolling drags the glued ends along with the content until they stretch and snap. Sweeping the mouse through them cuts threads and flings them. A web that loses enough threads gives way and drifts down out of sight. Even the tab you're on starts weaving a new web if you leave it untouched for the idle threshold. The webs are drawn on a click-through overlay, so the page underneath keeps working. They can be switched off in Settings.

### The page itself decays

Each stage also leaves its mark on the page, on top of what came before. Every effect is drawn on its own click-through layer in a closed shadow root, so links, buttons, text selection and scrolling all keep working. None of them touches the page's own DOM or styles, and they are hidden when you print. Each one can be switched off in Settings, and switching one off fades it out in every open tab.

| From | Effect | What you see |
| --- | --- | --- |
| 🥀 Withering | **Dust and decay** | Film grain, a yellowing vignette and paper-brown edges, with dust motes drifting in a shaft of light. Moving the mouse stirs the dust, and it settles again once you stop. |
| 👻 Ghost | **Fogged glass** | Frost creeps in from the edges of the window like breath on cold glass. Moving the mouse wipes clear streaks with a wet edge. Beads of water collect, and now and then one runs down. Wiped areas slowly mist over again. Sometimes a handprint is left in the frost. |
| 💀 Dead | **Eyes in the dark** | Darkness pools in an empty part of the page and a pair of eyes opens in it. They follow your cursor, blink and squint. They shut the moment you go for them, then open somewhere else. They only ever use empty space, so they never cover content. An entombed tab gets a second, fainter pair. |
| ⚰️ Entombed | **Drips** | A dark, glossy liquid gathers along the top of the window, swells into beads and runs down in fits and starts. The trails thin, dry and go matte, and it collects in a thin film along the bottom that ripples when a drop lands. Drips only run where there is no text. Scrolling drags them along and sloshes the pool, and a fast scroll wipes it all away in streaks. |

Two more belong to the **poltergeist**. They are rare, happen only on the tab you're reading, and never stack:

- **Something behind the text:** once, while you read, a tall gaunt shadow walks past *behind* the page. It slows, turns its head to look at you, and walks on. The text stays crisp in front of it on light and dark pages alike.
- **Ghost cursor:** a faint second pointer copies yours from a moment ago, then goes off on its own. It glides to a link, turns into a pointing hand, gives it a slow phantom click, and drifts away. Sweep your mouse at it and it flinches and vanishes. It never sends the page a real event.

With "reduce motion" turned on in your OS, every effect becomes a calm, mostly static version of itself.

Optional extras:

- **Poltergeists:** rare, rate-limited events. A dead tab's title flickers in the tab strip (`👁 👁`), or a dead tab reaches into the tab you're using and glitches it with a message like `"INBOX (3)" WANTS YOU BACK`. They get more frequent as the **haunt level** rises (Peaceful → Uneasy → Haunted → Possessed → Damned). The level depends on how many tabs you have and how old they are, and it shows in the popup and on the toolbar badge.
- **Whispers:** notifications about forgotten tabs. Clicking one takes you to the tab.
- **Put ghosts to sleep:** discards ghost tabs to free memory. In the tab strip they keep their ghostly title and icon.
- **Bury the entombed:** closes tabs that reach the grave and moves them to the **Graveyard**. That page shows a tombstone for each buried tab with its URL, title, and time of death, and one click resurrects it (or all of them). Closing a tab from the popup buries it there too.

## Safety

- **Opt-in.** Nothing happens until you flip the switch in the popup. Haunting asks for permission to repaint pages only at that moment.
- **Exorcise** turns everything off at once and gives every tab back its real title and favicon.
- **Nothing is deleted.** The extension only paints over a page's title and icon, and it puts the originals back when you look at the tab. Anything it closes goes to the Graveyard first.
- **Never touches** pinned tabs, tabs playing audio, private (incognito) tabs, tabs with unsaved form input, or pages it can't inspect (`chrome://`, the Web Store, and so on). Closing and discarding only happen after a check finds no unsaved input, and that includes closing a tab from the popup.
- **No network.** No backend, no analytics, no remote fonts or images. State lives in `chrome.storage`. Favicons in the popup and Graveyard come from the browser's local favicon cache.
- **Photosensitivity:** the possession effect has at most one bright flash and no strobing, well under the three-flashes-a-second limit. With "reduce motion" turned on in your OS, it and every page effect become a slow, calm fade instead. Each effect can be switched off on its own in Settings.
- **Pages keep working.** Effects are click-through overlays that never change the page's DOM, styles or events, and they are hidden when printing. Exorcise and the master switch fade them all away.

### Permissions

| Permission | Why |
| --- | --- |
| `tabs` | List tabs, read titles and URLs, switch, close, discard |
| `storage` | Settings, Graveyard, and per-tab idle times |
| `alarms` | The decay clock (every 30 seconds) |
| `scripting` | Inject the small script that repaints a tab's title and favicon |
| `favicon` | Read favicons from the browser's local cache (Chrome only; Firefox has no equivalent, so it shows icons tabs already hold as `data:` URLs and a plain globe otherwise) |
| `<all_urls>` (optional) | Requested when you turn haunting on, so pages can be repainted |
| `notifications` (optional) | Requested only if you enable Whispers |

## When the browser saves memory

Browsers quietly put idle tabs to sleep. Chrome's Memory Saver and Firefox/Zen tab unloading throw the page away and keep only its title and icon. The page reloads when you click the tab. Browsers can also freeze a background tab's scripts. The haunting is built to survive all of this:

- **Decay pauses when your computer does.** Time the computer spends asleep, or the browser spends closed, doesn't count. Waking your laptop or reopening the browser never entombs every tab at once.
- **Decay keeps counting while a tab sleeps.** Idle time, stage, the haunt level, and the popup are all tracked by the extension, not the page. A sleeping tab keeps whatever face it had in the tab strip. Nothing can repaint it without waking it up, and the extension will not reload your tabs just to haunt them.
- **The scare waits for the reload.** When you return to a tab the browser unloaded, the possession and cobwebs are queued until the fresh page has loaded and answered. A dead tab gets its skull back for a moment, glitches, and then comes back to life, exactly as if it had never been unloaded. Firefox briefly wakes tabs as a blank placeholder before the real reload, and that case is handled too.
- **A frozen tab can't jam the haunting.** Every message to a page gives up after 3 seconds, so one frozen tab never holds up the rest. Tabs known to be asleep or frozen are skipped until they wake.
- **Restarts are remembered.** After a browser restart, restored tabs may still show a ghost title before they load. The extension keeps a small record of which pages it painted, so it recognises them, still knows their real titles, and Exorcise can clean them up.
- **It never buries what it can't check.** A tab the browser unloaded can't be checked for unsaved input, so auto-burial leaves it alone. The extension only auto-buries tabs it inspected itself.

## Install

```sh
npm install
npm run build
```

That builds two copies of the same extension: `dist/chrome` and `dist/firefox`.

### Chrome, Edge, Brave, Arc, Vivaldi

Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and pick `dist/chrome`.

### Firefox, Zen, LibreWolf, Floorp

Firefox 128 or newer (any current Zen release qualifies).

- **Try it now:** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…**, and pick `dist/firefox/manifest.json`. It stays installed until the browser restarts.
- **Keep it installed:** Firefox-based browsers only permanently install signed add-ons. Signing is free and can be private ("unlisted"): create API keys at [addons.mozilla.org](https://addons.mozilla.org/developers/addon/api/key/), then run `npx web-ext sign --source-dir dist/firefox --channel unlisted --api-key ... --api-secret ...` and open the `.xpi` it produces. (Firefox Developer Edition and Nightly can instead set `xpinstall.signatures.required` to `false` in `about:config`.)

When you flip the switch, Firefox asks to let the add-on "access your data for all websites". The prompt may close the popup; haunting still turns on once you accept. You can review or revoke the permission in `about:addons` at any time.

### Quick demo

Open Settings in the popup and set **Tabs start to decay after** to **30 seconds (demo)**. Tabs wither at 30s, ghost at 1m, die at 2m, and are entombed at 4m.

## Development

```sh
npm run typecheck   # TypeScript
npm test            # unit tests for the decay logic (Vitest)
npm run e2e         # builds, then drives a real Chromium with the extension loaded
npm run e2e:firefox # same idea in a real Firefox (downloads one into .cache/, or set FIREFOX_PATH)
npm run lint:firefox  # Mozilla's add-on linter on dist/firefox
npm run test:popup  # smoke test of the popup UI
npm run test:content  # the in-page script: paint, unsaved input, overlay stacking
```

To look at one effect on a realistic page, build and then run the effect harness. It saves screenshots over time, reports the frame rate and console errors, and with `--stop` checks that nothing is left behind:

```sh
node scripts/effect-harness.mjs --effect fog --stage 2 --theme dark --frames 500,3000,8000 --interact --stop
# --effect dust|fog|eyes|drips|shadow|ghostCursor|cobwebs|possession|popup|graveyard
# --reduced for prefers-reduced-motion, --width/--height for the viewport
```

The end-to-end tests open real local pages and turn haunting on. It fast-forwards the service worker's clock, then checks:
- titles and favicons decay, and pages that keep retitling themselves stay haunted
- returning to a dead tab triggers the possession glitch and restores the page
- page effects start at their stages, stop when switched off, and are cleared by Exorcise
- poltergeist flickers happen
- burial skips the tab with unsaved input
- the Graveyard resurrects tabs
- Exorcise restores everything

Set `SHOTS=some/dir` to save screenshots.

Firefox runs the same code. The differences are handled at runtime:
- Firefox exposes the promise-based API as `browser`, aliased in `src/shared/ext.ts`.
- It runs the background as an event page instead of a service worker. `scripts/build-firefox.mjs` writes that into the Firefox manifest.
- It has no favicon cache API.
- Its `tabs.discard` resolves with nothing.

Layout:

- `src/background/`: service worker. Tracks idle time, decides stages, buries, discards, poltergeists.
- `src/content/`: injected into pages on demand. Swaps the title and favicon, runs the page effects, checks for unsaved input. `cobwebs.ts` is the cobweb physics: a small Verlet simulation on a canvas overlay.
- `src/content/effects/`: one module per page effect (dust, fog, eyes, drips, shadow, ghost cursor) and the possession glitch, all built on the shared overlay in `overlay.ts`.
- `src/popup/`: the tab manager.
- `src/graveyard/`: the Graveyard page.
- `src/shared/haunt.ts`: pure decay logic (stages, eerie titles, haunt level), unit tested.

License: MIT
