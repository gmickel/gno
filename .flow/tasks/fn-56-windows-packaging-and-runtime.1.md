# fn-56-windows-packaging-and-runtime.1 Validate Windows runtime and SQLite extension story

## Description

Validate the Windows runtime and packaging story with emphasis on SQLite and extensions.

Important current conclusion to preserve: Windows is probably not blocked by the macOS custom-SQLite issue. The code already assumes native extension loading on Windows. The real question is whether that still holds inside the packaged/shipped Windows runtime.

Focus on:

- packaged `bun:sqlite` behavior on Windows
- `sqlite-vec` availability in packaged builds
- vendored `fts5-snowball.dll` loading
- x64 vs arm64 support gaps
- desktop-shell packaging vs pure CLI packaging needs

## Acceptance

- [ ] Windows packaged runtime is exercised, not just source checkout.
- [ ] `gno doctor` results for SQLite/vector/FTS are captured on Windows.
- [ ] Any blocker is identified precisely by subsystem.
- [ ] Recommendation recorded for Windows distribution shape and support scope.

## Done summary

Implemented Windows packaging/runtime validation end-to-end.

- staged the real GNO runtime into Electrobun app resources before build
- taught the desktop shell to launch packaged GNO from bundled Bun when available
- added packaged-runtime verifier that exercises doctor/init/update/search inside the built app bundle and checks sqlite-fts5, vendored fts5-snowball, and sqlite-vec
- added shell self-test mode for headless packaged launcher validation
- added Windows packaging workflow, support docs, rollout/docs updates, and support-target guidance (windows-x64 first, arm64 unsupported)
- added tests for runtime layout, shell packaging scaffolding, and snowball tokenizer load

## Evidence

- Commits:
- Tests: bun run lint:check, bun run typecheck, bun test, bun run docs:verify, mise exec ruby@3.3.6 -- make build, cd desktop/electrobun-shell && bun run build, cd desktop/electrobun-shell && bun run verify:packaged-runtime
- PRs:
