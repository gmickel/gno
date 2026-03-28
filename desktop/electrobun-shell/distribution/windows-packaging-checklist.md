# Windows Packaging Checklist

Current target: `windows-x64`

## Recommended first artifact

Portable packaged artifact first.

Reason:

- simpler support story
- fewer installer-specific failure modes
- easier runtime proof for Bun + SQLite + extensions

MSI / installer polish can follow after runtime proof and tester feedback.

## Runtime proof checklist

- packaged app contains staged `gno-runtime`
- packaged app contains bundled `bun.exe`
- packaged runtime verifier passes:
  - `gno doctor --json`
  - `init`
  - `update`
  - `search`
- doctor confirms:
  - `sqlite-fts5`
  - `fts5-snowball`
  - `sqlite-vec`
- shell self-test exits successfully

## Manual tester checklist

- launch app normally
- onboarding works
- add-folder paste works
- indexing completes
- search works
- preset switching is visible
- deep link works:
  - `open 'gno://open?route=/search'`
- second app launch hands off to existing instance

## Not supported yet

- `windows-arm64`
- official MSI path
- auto-update path
