# fn-57-mac-and-linux-packaging-matrix-and Mac and Linux packaging matrix and support tiers

## Overview
Decide what GNO should actually ship on macOS and Linux, in what order, and with what support level.

Right now the repo has enough pieces to plausibly ship multiple packaging shapes, but the support promise is still fuzzy. This epic defines the packaging matrix, target artifacts, support tiers, and what "supported" means per platform.

## Scope
- define packaging targets separately for:
  - CLI
  - desktop app shell
- define support tiers per OS:
  - supported
  - beta
  - experimental
  - unsupported
- define recommended artifact shapes per OS
- define which architectures are in-scope vs explicitly deferred
- capture the SQLite/runtime assumptions that affect packaging choices

## Approach
1. Split the matrix by product surface:
   - CLI distribution
   - desktop-shell distribution
2. For macOS, decide:
   - signed desktop app bundle
   - dmg/pkg path
   - whether standalone CLI artifacts are also first-class
3. For Linux, decide separately for:
   - CLI support tier
   - desktop support tier
   - distro baseline (for example Ubuntu 22.04+ first)
4. Record what must be bundled vs assumed present:
   - Bun runtime
   - SQLite runtime/extension path
   - `sqlite-vec`
   - FTS stemmer binary
5. Make the support matrix user-facing enough for docs/releases.

## Quick commands
- `gno doctor --json`
- `desktop/electrobun-shell: bun run build`
- `mise exec ruby@3.3.6 -- make build`

## Acceptance
- [ ] macOS and Linux packaging targets are defined separately for CLI and desktop.
- [ ] Support tiers are explicit by OS/architecture.
- [ ] Artifact recommendations are recorded (tarball/dmg/pkg/AppImage/etc.).
- [ ] Runtime bundling assumptions are documented.
- [ ] Docs/release planning can reference the matrix without guesswork.

## References
- `/Users/gordon/work/gno/docs/DESKTOP-BETA-ROLLOUT.md`
- `/Users/gordon/work/gno/desktop/electrobun-shell/README.md`
- `/Users/gordon/work/gno/src/store/sqlite/setup.ts`
- `/Users/gordon/work/gno/src/store/vector/sqlite-vec.ts`
- `/Users/gordon/work/gno/src/store/sqlite/fts5-snowball.ts`
