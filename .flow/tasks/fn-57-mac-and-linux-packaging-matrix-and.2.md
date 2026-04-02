# fn-57-mac-and-linux-packaging-matrix-and.2 Build macOS signed/notarized desktop beta pipeline

## Description

Build the first real macOS desktop-beta release pipeline for GNO.

Use the existing `desktop/electrobun-shell/` scaffold plus the release/notarization patterns already proven in `~/work/transcribe`.

Scope:

- create a repeatable local release path for a macOS desktop beta
- produce the right signed artifacts from the packaged shell/runtime
- require hardened runtime signing
- notarize with `notarytool`
- staple the notarization ticket
- verify the signed/stapled result before considering it distributable
- document exactly which credentials, env vars, and local setup are required

Carry over the transcribe-style proof points where they fit:

- `codesign --verify --deep --strict`
- `xcrun stapler validate`
- `spctl --assess`
- zip/dmg artifacts must come from the stapled app, not a pre-staple build

Keep the output focused on the current GNO desktop shell/runtime, not Sparkle or a generic updater path.

## Acceptance

- [ ] A repo-local macOS desktop release path exists (script or equivalent documented command path) for `desktop/electrobun-shell`.
- [ ] The path signs with Developer ID + hardened runtime.
- [ ] The path submits the app for notarization and staples the result.
- [ ] The path verifies the final app or archive with `codesign`, `stapler validate`, and `spctl`.
- [ ] Output artifact shape is explicit (`.zip`, `.dmg`, or both) and matches the packaging matrix.
- [ ] Required signing/notarization prerequisites are documented in-repo.

## Done summary
Implemented the first real macOS desktop-beta release pipeline for GNO.

Changes:
- added `desktop/electrobun-shell/scripts/release-macos.ts`
- added `bun run release:macos`
- signs nested native binaries and app bundle with Developer ID + hardened runtime
- notarizes and staples the app and optional DMG
- verifies the final stapled app/zip with `codesign`, `stapler validate`, and `spctl`
- writes versioned zip/dmg/json artifacts under `desktop/electrobun-shell/artifacts/release-macos/`
- documented local and CI credential/setup requirements

Local proof was run successfully with real Apple credentials and produced notarized/stapled macOS artifacts.
## Evidence
- Commits:
- Tests: bun run release:macos --help, bun run release:macos --dry-run, bun run lint:check, bun run typecheck, bun test, bun run docs:verify, local notarized macOS release run completed successfully
- PRs: