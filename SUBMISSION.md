# Hackyard Yard #5 submission: Haunted Tabs

Everything needed for the submission form, ready to paste.

## Repo URL

https://github.com/Robertg761/haunted-tabs (public)

## Writeup (478 of 500 characters)

> Haunted Tabs is a real tab manager extension for Chrome and Firefox/Zen where neglected tabs come back as ghosts. Leave a tab alone and its title rots and its favicon turns ghost, then skull, then tombstone. Return to a dead tab and it possesses your screen, then the page gathers cobwebs, fog, dust, watching eyes and drips. Bury tabs in the Graveyard and resurrect them. It's opt-in, one Exorcise undoes everything, it never loses unsaved input, and it makes no network calls.

## Model declaration

From the Model log in `HACKYARD.md`:

- **Claude Opus 5.5** (Anthropic), via Claude Code. It wrote the code, tests and docs:
  - the initial extension: tab manager popup, decay stages, possession glitch, poltergeists, Graveyard;
  - Firefox/Zen support, cobwebs and memory-saver handling;
  - the page effects;
  - the polish and bug-fix passes;
  - this final verification, the demo video recording and the submission prep.
  Parts of the work ran as teams of parallel Claude Opus 5.5 subagents: builders, reviewers and a coordinator.
- **OpenAI Codex**, through the ChatGPT Codex connector for GitHub. It gave automated code review on pull requests #3, #4 and #5. Its findings were checked and fixed by Claude.

No other AI models were used.

## Demo video

`docs/demo.mp4` in the repo, about 90 seconds. It shows the real extension in a real Chromium window, recorded with `scripts/record-demo.mjs`:
1. Turning haunting on.
2. Tabs decaying in the tab strip. This part is four real minutes on the 30-second demo threshold, sped up on screen.
3. The possession, with a slow-motion replay.
4. The decayed page and its cobwebs being swept.
5. The popup tab manager.
6. Burying two tabs and resurrecting one from the Graveyard.
7. Exorcise.

The form wants a YouTube, Vimeo or Loom link, so the file still needs uploading to one of them.

## Screenshot for the submission card

`docs/screenshot.png`: the Graveyard with two real burials, the live tab strip above it. A frame from the demo recording.

## Before submitting

- Upload `docs/demo.mp4` to YouTube, Vimeo or Loom and paste the link.
- Submit the form before **Fri Oct 23, 18:00 UTC**.
