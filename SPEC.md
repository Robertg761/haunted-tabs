# Haunted Tabs: Basic Spec

A browser extension tab manager that is haunted. It really manages your tabs, and it gets spookier the worse your tab habits are. Built for Hackyard Yard #5 (see `HACKYARD.md`).

## Platform

- Manifest V3, TypeScript, Vite.
- Chrome first, Firefox as a stretch goal.
- No backend. All state stays in `chrome.storage.local`. No network requests and no analytics.

## Core tab manager (must work, not a demo)

- Popup lists all open tabs across windows, with search, switch-to-tab, and close.
- Shows each tab's idle time since it was last active.
- Group or sort by window, domain, or idle time.

## The haunting

- **Ghosting:** tabs idle past a configurable threshold (default 30 minutes) turn into ghosts. Their title and favicon change to a ghostly version, and they can be discarded to free memory. Real title and favicon come back when the tab is focused.
- **Graveyard:** tabs closed by the haunting go to a Graveyard page with URL, title, and time of death. One click resurrects any tab or all of them. Nothing is ever lost.
- **Poltergeist events (optional, rate-limited):** small harmless scares, like a tab flickering its title, a whisper notification about a forgotten tab, or a ghost peeking out on the new tab page.
- **Haunt level:** the more tabs and the older they are, the stronger the haunting, shown in the popup.

## Safety rules (from Hackyard, non-negotiable)

- Haunting is off until the user turns it on in the popup (opt-in).
- An "Exorcise" button turns off all haunting immediately and restores every ghosted tab's real title and favicon.
- Never permanently delete tabs, history, bookmarks, or any user data. Everything that is closed goes to the Graveyard.
- Never touch pinned tabs, tabs that are playing audio, or tabs with unsaved form input.
- Request only the permissions needed (`tabs`, `storage`, `alarms`, optional `notifications`). No `<all_urls>` host access unless a feature truly needs it.

## Out of scope

- Accounts, sync, or servers.
- Anything that affects other users or devices.

## Demo plan

Show a real browser with a lot of tabs, turn haunting on, fast-forward the idle threshold, watch tabs ghost and get buried, resurrect them from the Graveyard, then hit Exorcise.
