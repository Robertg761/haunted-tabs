# Hackyard Yard #5: Haunted

This repo is a solo entry for [Hackyard Yard #5](https://hackyard.tech/yards/yard-5). Full rules: [Hackyard FAQ](https://hackyard.tech/faq).

## Key dates (UTC)

| Milestone | UTC | UTC-2:30 |
| --- | --- | --- |
| Kickoff | Mon Oct 19, 18:00 | Mon Oct 19, 3:30 PM |
| Late joins close | Wed Oct 21, 18:00 | Wed Oct 21, 3:30 PM |
| Ship deadline | Fri Oct 23, 18:00 | Fri Oct 23, 3:30 PM |
| Voting closes, Champion crowned | Sun Oct 25, 22:00 | Sun Oct 25, 7:30 PM |

## Rules this project must follow

1. **On theme: Haunted.** It has to scare, surprise, or creep into something real. It must act on the real browser and real tabs. A spooky page playing a canned demo does not count.
2. **Harmless.** Opt-in, reversible, and on the user's own stuff only.
3. **Nothing destructive.** Never permanently delete data. Anything the extension hides, closes, or changes must be restorable.
4. **No spreading.** Nothing that spreads, phones home, or touches anyone else's device or account.
5. **Code written during build week only.** All code is written between Mon Oct 19 18:00 UTC and Fri Oct 23 18:00 UTC. Repo commit timing is published on the submission, so do not import pre-written project code. Third-party libraries and frameworks are fine.
6. **Any AI model is allowed.** Note which ones are used so the model declaration is accurate.
7. **Solo.** One builder (Robertg761). No outside human contributors.
8. **Open source.** The repo must be public by submission time.

## Submission checklist

- [x] Repo is public
- [x] Repo URL (required): https://github.com/Robertg761/haunted-tabs, in `SUBMISSION.md`
- [x] Writeup, 500 characters max (required): drafted in `SUBMISSION.md` (478 characters)
- [x] Model declaration listing every AI model used (required): in `SUBMISSION.md`
- [ ] Demo video on YouTube, Vimeo, or Loom (optional, strongly recommended): recorded as `docs/demo.mp4`, still to be uploaded
- [x] Screenshot for the submission card (optional): `docs/screenshot.png`
- [ ] Submitted before Fri Oct 23, 18:00 UTC

## Model log

Add each AI model or tool used during the build here, so the declaration is easy to write.

- Claude Opus 5.5 (via Claude Code): initial extension build (tab manager popup, decay stages, possession glitch, poltergeists, Graveyard, tests), then Firefox/Zen support, cobwebs, and memory-saver handling
- Claude Opus 5.5 (via Claude Code, as a team of parallel subagents with a coordinator): page effects (dust and decay, fogged glass, eyes in the dark, drips, the shadow behind the text, the ghost cursor), the reworked possession glitch, cobweb polish, the popup and Graveyard redesigns, and the review and refinement passes on all of them
- Claude Opus 5.5 (via Claude Code, a team of area owners plus fresh cross-reviewers): final polish and bug-fix pass (sleep-aware decay, unsaved-input safety, top-layer overlays, cobweb placement, fog legibility, drips, eyes, popup and Graveyard refinements)
- OpenAI Codex (ChatGPT Codex connector for GitHub): automated code review on pull requests #3, #4 and #5; its findings were checked and fixed by Claude
- Claude Opus 5.5 (via Claude Code): final finish pass (full verification on Chrome and Firefox, the demo video recorder `scripts/record-demo.mjs` and `docs/demo.mp4`, and `SUBMISSION.md`)
