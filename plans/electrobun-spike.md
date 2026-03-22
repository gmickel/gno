# Electrobun Spike Notes

## Goal

Test whether Electrobun can wrap the existing GNO Bun/web workspace without forking core app logic.

## What this spike proves

- Electrobun can launch a Bun child process that runs the real GNO server.
- The native window can load the existing GNO web app over loopback.
- Build-time runtime config is enough to hand the packaged shell the repo root and port.
- A `gno://open?route=...` mapping can be translated into the existing web routes from `fn-41`.
- `Utils.moveToTrash()` works in practice for a probe file.
- `Utils.openFileDialog()` surfaces a real native macOS Open dialog when called directly from the Bun side.
- A manual singleton workaround is feasible on top of Electrobun using a localhost control port.

## What was observed

- Boot path:
  - Electrobun dev shell launched successfully on macOS.
  - GNO child server started and became healthy at `http://127.0.0.1:3927`.
  - BrowserWindow navigated to the real GNO workspace.
- Deep-link path:
  - Self-test navigation to `/search?q=workspace` worked.
  - Direct `open 'gno://open?route=/search?q=protocol-spike'` eventually emitted `open-url` and navigated the live window.
- Native file primitive:
  - Probe file moved into Trash successfully.
- Native dialog:
  - Folder picker dialog opened as a real macOS `Open` window when triggered directly in self-test mode.
- Singleton workaround:
  - first instance opened a localhost control port
  - forced second launch via `open -n` handed off `focus` to the first instance
  - second instance exited instead of leaving a second shell/server alive

## What still feels shaky

- Dev-mode automation of app menu clicks and shortcut callbacks was inconsistent under Peekaboo-driven smoke.
- No obvious built-in single-instance support surfaced in docs or package source.
- The singleton story currently needs app-level workaround code; not a framework-level feature.
- No obvious file-association / `open-file` support surfaced in docs or package source.
- Signing, notarization, updater, installer flow not tested.
- No browser<->Bun RPC bridge into the existing React app yet; current spike stays shell-side on purpose.

## Extra packaged-app findings

- `bunx electrobun build` produced a runnable `.app` bundle in `build/dev-macos-arm64/`.
- Generated `Info.plist` contains `CFBundleURLTypes` for `gno`.
- I did not find `CFBundleDocumentTypes` / `LSItemContentTypes` generation in package source or built metadata.
- Source contains a real app-level `reopen` event on macOS (`applicationShouldHandleReopen`), but this is not surfaced prominently in docs.
- Packaged app handled `open 'gno://open?route=/search?q=packaged'` and routed into the live GNO window.
- Plain `open app` reused the existing app bundle process.
- Before the workaround, forced `open -n app` launched a second bundle instance and second `gno serve`.
- After adding the control-port handoff, forced `open -n app` no longer left a second shell/server alive.

## Current spike shape

- `desktop/electrobun-spike/`
  - isolated package
  - Electrobun config with `urlSchemes: ["gno"]`
  - Bun main process starts `gno serve` as child
  - waits for `/api/health`
  - opens BrowserWindow on loopback URL
  - event journal in app cache for smoke evidence
  - optional self-test env vars for deterministic checks

## Initial takeaway

Promising. No longer blocked on singleton as a hard blocker, but still not decision-ready for `fn-51`.

Best current reading:

- good enough to keep evaluating
- especially strong fit for “thin Bun shell around existing GNO workspace”
- packaged `gno://` support is better than expected
- singleton is workable with app-level glue
- file-association story is still unclear / weak
- recommendation right now: keep Electrobun in the running, but do **not** lock GNO onto it until another candidate is compared against these exact gaps
