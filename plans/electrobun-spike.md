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

## What still feels shaky

- Dev-mode automation of app menu clicks and shortcut callbacks was inconsistent under Peekaboo-driven smoke.
- `open-url` worked, but timing in dev mode felt a little odd; needs cleaner packaged-app testing.
- Single-instance handoff not tested.
- File associations / open-file OS events not tested.
- Signing, notarization, updater, installer flow not tested.
- No browser<->Bun RPC bridge into the existing React app yet; current spike stays shell-side on purpose.

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

Promising for `fn-50`.

Best current reading:

- good enough to keep evaluating
- especially strong fit for “thin Bun shell around existing GNO workspace”
- not yet enough evidence to lock `fn-51` on Electrobun without packaged-app tests for single-instance, file associations, and updater/distribution behavior
