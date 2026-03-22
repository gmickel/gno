# fn-51-desktop-beta-shell-packaging-and-os.1 Scaffold Electrobun shell packaging and launch glue

## Description

Implement the first thin Electrobun shell slice on top of the existing GNO workspace.

Initial slice:

- promote proven Electrobun spike patterns into repo-owned shell packaging scaffolding
- define shell-managed `gno serve` lifecycle and singleton/deep-link handoff shape
- wire packaged open-url/open-file strategy into the existing route/deep-link model
- document the interim file-association / plist-hook strategy for markdown/plaintext
- add verification/docs around install/open/deep-link behavior

## Acceptance

- [ ] Repo contains the shell packaging scaffolding and documented ownership boundary for the Electrobun wrapper
- [ ] Service startup/shutdown and singleton/deep-link routing have an explicit implementation path in code/docs
- [ ] Open-file / file-association strategy is recorded with the current interim packaging hook approach

## Done summary
Shipped the first Electrobun shell packaging slice.

Highlights:
- promoted the spike into a repo-owned `desktop/electrobun-shell/` package scaffold
- captured the thin shell boundary: child `gno serve`, singleton handoff, route-based deep links, and app-level tabs
- added an interim macOS plist fragment for markdown/plaintext file associations
- recorded the promotion path in `plans/electrobun-spike.md`
- added a shell scaffold test so package/docs/plist intent cannot silently disappear
## Evidence
- Commits:
- Tests: bun test test/desktop/electrobun-shell.test.ts, bun run lint:check, bun run typecheck, bun test, bun run docs:verify
- PRs: