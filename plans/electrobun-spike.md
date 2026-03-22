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

## Upstream issue read

- `#227` open: no built-in `requestSingleInstanceLock()` equivalent yet.
- `#304` open: `application:openFiles` support is currently missing on macOS.
- `#69` open: dock-icon reopen window request.
- `#253` open: the multitab-browser template has active tab/navigation problems.

Interpretation:

- singleton is not a first-class framework feature today, but can be worked around at app level
- open-file / default-app handling is still the main missing product capability for GNO
- native BrowserView-style tabs are not a stable enough foundation to base GNO tabs on right now

## Temp patch read

I patched a local Electrobun checkout to add an `open-file` event path:

- callback type in `callbacks.h`
- `open-file` event in `ApplicationEvents.ts`
- FFI registration in `native.ts`
- `application:openFiles:` bridge in macOS native wrapper
- Windows/Linux stubs to keep the symbol table aligned

This patch surface is small and plausible to upstream. I did not carry it into GNO because it belongs in Electrobun first.

## Tabs recommendation for GNO

If GNO ships tabs on Electrobun, they should be app-level tabs inside the existing React workspace, not native BrowserView tabs.

Why:

- GNO already has route/deep-link semantics from `fn-41`
- app-level tabs can reuse one shell window and one local service lifecycle
- open-file and deep-link events can map cleanly to `open in current tab` / `open in new tab`
- Electrobun's current multitab template is demo-quality and has an active bug around subsequent navigation/new tabs

## Current spike shape

- `desktop/electrobun-spike/`
  - isolated package
  - Electrobun config with `urlSchemes: ["gno"]`
  - Bun main process starts `gno serve` as child
  - waits for `/api/health`
  - opens BrowserWindow on loopback URL
  - event journal in app cache for smoke evidence
  - optional self-test env vars for deterministic checks

## Current recommendation

Proceed with Electrobun for the mac-first desktop beta.

Best current reading:

- especially strong fit for “thin Bun shell around existing GNO workspace”
- packaged `gno://` support is better than expected
- singleton is workable with app-level glue
- `open-file` / file associations remain the main unresolved platform gap
- tabs should be implemented in GNO app state, not native BrowserView tabs
- only fall back to another runtime if Electrobun still fails the `open-file` / distribution gates in `fn-50`
