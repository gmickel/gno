# fn-50-desktop-beta-native-runtime-evaluation.1 Run Electrobun fit spike

## Description

Build an isolated Electrobun spike that wraps the current GNO Bun/web workspace with the minimum native shell needed to test fit.

Goals for the spike:

- boot the existing GNO web app inside Electrobun without forking the workspace UI
- prove app->server lifecycle is manageable from a desktop shell
- test folder picker / open file dialog plumbing
- test deep-link routing into the existing `/doc` and `/edit` routes
- test Finder integration primitives relevant to later file ops (`showItemInFolder`, `moveToTrash` if available)
- document what works, what is missing, and what blocks `fn-51`

This is a spike, not a production desktop app. Keep scope tight. Prefer isolation under a dedicated spike directory and avoid leaking Electrobun-specific code into the core workspace unless an abstraction boundary is clearly justified.

## Acceptance

- [ ] Electrobun spike can launch GNO and render the existing workspace UI in a native window.
- [ ] Spike exercises at least one native dialog/file primitive and one deep-link/protocol-like path.
- [ ] Findings are documented in repo docs or the Flow task summary with explicit pass/fail notes for GNO needs.
- [ ] Core app/server logic is not polluted with shell-specific hacks beyond what the spike strictly needs.

## Done summary

Built an isolated Electrobun spike under `desktop/electrobun-spike/`.

What landed:

- Electrobun shell launches the real GNO Bun server as a child process.
- BrowserWindow loads the existing GNO workspace over loopback.
- Runtime config carries repo root + port into the packaged/dev shell.
- `gno://open?route=...` deep-link mapping routes into existing web paths.
- Native Trash integration is smoke-tested with a probe file.
- Native macOS Open dialog is smoke-tested via `Utils.openFileDialog()`.
- Findings are documented in `plans/electrobun-spike.md`.

Current read:

- promising for `fn-50`
- enough evidence to continue Electrobun evaluation
- still missing single-instance, file associations, updater/signing, and packaged-app rollout validation

## Evidence

- Commits:
- Tests: bunx tsc -p desktop/electrobun-spike/tsconfig.json --noEmit, bun run lint:check, bun test, bun run docs:verify, desktop/electrobun-spike: self-test booted GNO window, navigated to /search?q=workspace, opened native Open dialog, moved probe file to Trash
- PRs:
