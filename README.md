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

When you return to a **dead** tab it **possesses your screen** for about a second. The real page gets colour-rotted, inverted, sliced, and shaken, and a message like `I WAITED 3 HOURS` flashes up. Then it snaps back to normal with its real title and icon.

Optional extras:

- **Poltergeists:** rare, rate-limited events. A dead tab's title flickers in the tab strip (`👁 👁`), or a dead tab reaches into the tab you're using and glitches it with a message like `"INBOX (3)" WANTS YOU BACK`. They get more frequent as the **haunt level** rises (Peaceful → Uneasy → Haunted → Possessed → Damned). The level depends on how many tabs you have and how old they are, and it shows in the popup and on the toolbar badge.
- **Whispers:** notifications about forgotten tabs. Clicking one takes you to the tab.
- **Put ghosts to sleep:** discards ghost tabs to free memory. In the tab strip they keep their ghostly title and icon.
- **Bury the entombed:** closes tabs that reach the grave and moves them to the **Graveyard**. That page shows a tombstone for each buried tab with its URL, title, and time of death, and one click resurrects it (or all of them). Closing a tab from the popup buries it there too.

## Safety

- **Opt-in.** Nothing happens until you flip the switch in the popup. Haunting asks for permission to repaint pages only at that moment.
- **Exorcise** turns everything off at once and gives every tab back its real title and favicon.
- **Nothing is deleted.** The extension only paints over a page's title and icon, and it puts the originals back when you look at the tab. Anything it closes goes to the Graveyard first.
- **Never touches** pinned tabs, tabs playing audio, tabs with unsaved form input, or pages it can't inspect (`chrome://`, the Web Store, and so on). Closing and discarding only happen after a check finds no unsaved input.
- **No network.** No backend, no analytics, no remote fonts or images. State lives in `chrome.storage`. Favicons in the popup and Graveyard come from the browser's local favicon cache.
- **Photosensitivity:** the possession effect has at most one bright flash and no strobing. With "reduce motion" turned on in your OS, it becomes a slow fade instead. You can also switch possession off in Settings.

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
```

The end-to-end tests open real local pages and turn haunting on. It fast-forwards the service worker's clock, then checks:
- titles and favicons decay, and pages that keep retitling themselves stay haunted
- returning to a dead tab triggers the possession glitch and restores the page
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
- `src/content/`: injected into pages on demand. Swaps the title and favicon, plays the glitch, checks for unsaved input.
- `src/popup/`: the tab manager.
- `src/graveyard/`: the Graveyard page.
- `src/shared/haunt.ts`: pure decay logic (stages, eerie titles, haunt level), unit tested.

License: MIT
