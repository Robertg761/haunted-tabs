# Haunted Tabs spec

## Pitch

Your tab bar is a graveyard. Tabs you ignore die, become ghosts, and haunt you until you resurrect them or lay them to rest.

## Platform

- Manifest V3 browser extension, Chrome first, Firefox if time allows.
- TypeScript, Vite.
- No backend, no network calls, no analytics. All state in `chrome.storage.local`.

## Core features (must ship)

1. **Opt-in summoning.** On install, nothing happens until the user clicks "Summon" in the popup. A "Banish" switch turns every effect off and restores all tabs to normal.
2. **Dying tabs.** A tab idle past a threshold (default 30 min, adjustable) starts to "die": its title gets a fading prefix, then its favicon is swapped for a skull.
3. **Ghosts.** A dead tab is discarded with `chrome.tabs.discard` (frees memory, keeps the tab and its URL). Its title becomes a ghost name. Nothing is ever closed.
4. **Graveyard popup.** Lists ghosts with how long they have been dead. Actions: Resurrect (restore title and favicon and focus the tab) or Lay to rest (close it after saving it to a restorable "Crypt" list).
5. **Crypt.** Every tab laid to rest is saved with its URL and title and can be reopened. This keeps the "never delete data" rule.
6. **Hauntings.** At random, low-frequency intervals, one ghost "knocks": its title flickers or a notification whispers its name. The user can set frequency or mute.

## Stretch features

- Possession: the oldest ghost's tab gently rearranges itself to the front of the bar.
- Seance search: fuzzy search across ghosts and the crypt.
- Sound effects, off by default.

## Rule guardrails in code

- Every effect is gated on the "summoned" flag.
- Original titles and favicons are stored before any change and restored on Resurrect or Banish.
- No `chrome.tabs.remove` without first writing the tab to the Crypt.
- No permissions beyond `tabs`, `storage`, `alarms`, `notifications` and, if needed, `scripting` for title and favicon changes.
- Never touch pinned tabs, incognito tabs, or tabs playing audio.

## Demo video plan

Open a real browsing session, summon, fast-forward the idle threshold in a debug setting, show tabs dying, a ghost knocking, resurrection, laying to rest, and restoring from the Crypt. Finish with Banish restoring everything.

## Done when

- All core features work on real tabs in Chrome.
- Banish fully restores state.
- README has install steps, a screenshot and the demo link.
- Submission checklist in RULES.md is complete before Fri Oct 23, 18:00 UTC.
