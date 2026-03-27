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

TBD

## Evidence

- Commits:
- Tests:
- PRs:
