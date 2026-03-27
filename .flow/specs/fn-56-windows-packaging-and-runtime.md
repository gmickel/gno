# fn-56-windows-packaging-and-runtime Windows packaging and runtime validation for GNO

## Overview

Windows distribution is not blocked by the macOS custom-SQLite issue. Current code explicitly treats Linux/Windows as native-extension platforms for `bun:sqlite`, and the repo already vendors `fts5-snowball` for `windows-x64`.

The real unresolved work is proving that the packaged Windows app/runtime can still load and use:

- Bun SQLite
- `sqlite-vec`
- vendored `fts5-snowball.dll`
- the rest of the desktop/CLI lifecycle under a shipped Windows artifact

This epic covers the missing proof and packaging work for Windows users.

## Scope

- verify desktop-shell/runtime assumptions on Windows
- verify packaged app can load SQLite extensions in the shipped environment
- validate `sqlite-vec` behavior on packaged Windows builds
- validate vendored FTS5 stemmer loading on Windows
- decide packaging/distribution shape for Windows users:
  - portable zip
  - installer/exe/msi
  - update path
- document unsupported architectures if necessary (for example, `windows-arm64`)

## Approach

1. Prove the runtime, not just source checkout behavior.
2. Run `gno doctor`, indexing, BM25, vector search, and hybrid search inside a packaged Windows artifact.
3. Confirm where the blocker really is if Windows fails:
   - Bun packaged runtime
   - `sqlite-vec`
   - vendored FTS DLL loading
   - Electrobun shell packaging
   - installer/update plumbing
4. Only after runtime proof, define the user-facing Windows distribution path.

## Quick commands

- `gno doctor --json`
- `gno index --yes`
- `gno query "test"`
- `desktop/electrobun-shell: bun run build`

## Acceptance

- [ ] Windows runtime/packaged-build proof exists for core GNO flows.
- [ ] SQLite / `sqlite-vec` / FTS extension loading is explicitly validated on packaged Windows artifacts.
- [ ] Any remaining Windows blockers are identified precisely, not guessed.
- [ ] A concrete Windows distribution recommendation is recorded.
- [ ] Docs call out supported vs unsupported Windows targets.

## References

- `/Users/gordon/work/gno/src/store/sqlite/setup.ts`
- `/Users/gordon/work/gno/src/store/vector/sqlite-vec.ts`
- `/Users/gordon/work/gno/src/store/sqlite/fts5-snowball.ts`
- `/Users/gordon/work/gno/desktop/electrobun-shell/electrobun.config.ts`
- `/Users/gordon/work/gno/docs/DESKTOP-BETA-ROLLOUT.md`
