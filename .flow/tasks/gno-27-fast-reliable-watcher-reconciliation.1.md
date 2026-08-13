---
satisfies: [R2, R4, R5]
---
# gno-27-fast-reliable-watcher-reconciliation.1 Add bounded watcher snapshot and active-source fallback primitives

## Description
Build the watcher-owned no-follow snapshot/diff substrate and the bounded active-source store queries used by fallback reconciliation (R2, R4, R5). Keep these primitives independent from event scheduling so their candidate and failure semantics are directly testable.

**Size:** M
**Files:** `src/serve/watch-snapshot.ts`, `src/store/types.ts`, `src/store/sqlite/adapter.ts`, `test/serve/watch-snapshot.test.ts`, `test/store/watcher-source-paths.test.ts`
**Touches:** [src/serve/watch-snapshot.ts, src/store/types.ts, src/store/sqlite/adapter.ts, test/serve/watch-snapshot.test.ts, test/store/watcher-source-paths.test.ts]

### Approach
- Add a watcher-local hierarchical snapshot whose no-follow entry fingerprint records kind, device, inode, size, nanosecond mtime, and nanosecond ctime; fingerprints identify ambiguous candidates only.
- Make filesystem/stat/clock operations injectable for deterministic initialization, metadata-uncertainty, symlink, scan-failure, and performance tests.
- Diff dirty directories by direct children, recurse only into changed/new directories, expand removals from the old snapshot, and climb missing hints to the nearest surviving in-root ancestor.
- Define one fixed service-wide snapshot-entry ceiling and deterministic overflow result; overflow must request fallback without mutating the last proven snapshot.
- Add active-only, path-boundary-safe direct-child and descendant source-path queries to the store contract and SQLite adapter, with deterministic ordering and record-container source-path semantics. Query errors remain explicit; an empty successful result is distinct from failure.

### Investigation targets
**Required** (read before coding):
- `src/serve/watch-service.ts:87-118` — watcher ownership and injected factory pattern
- `src/store/types.ts:1680-1750` — document and inactivation store contracts
- `src/store/sqlite/adapter.ts:1580-1715` — active-document query patterns
- `src/ingestion/sync.ts:1164-1260` — targeted sync source-path semantics

**Optional** (reference as needed):
- `test/ingestion/record-sync.test.ts` — record-container reconciliation expectations
- `test/ingestion/sync-incremental.test.ts:71-130` — no-walk targeted-sync assertions

### Key context
- Use Bun-native file reads/writes where applicable; `node:fs/promises` is acceptable only for filesystem-structure operations and must carry the repo-required rationale comment.
- A failed scan/query never proves removal and never advances the snapshot.

### Acceptance
- [ ] Snapshot diff tests cover unchanged, added, changed, removed, nested, atomic replacement, nearest-surviving-ancestor, symlink no-follow, invalid/outside-root hints, unreliable metadata, and ceiling overflow.
- [ ] A one-of-5,000 fixture selects only the changed path and records discovery timing without invoking ingestion.
- [ ] Store tests prove active-only direct-child/descendant boundaries, deterministic order, logical record source-container handling, and explicit query failure.
- [ ] Focused tests and `bun run lint:check` pass.

## Acceptance
- [ ] TBD

## Done summary
Implemented bounded, no-follow watcher snapshot primitives and active-source store queries for GNO-27 task 1. The snapshot layer now supports injectable filesystem seams, exact fingerprint comparison, recursive additions/removals and kind transitions, nearest-surviving-ancestor hint resolution, fixed entry ceilings, explicit fallback without snapshot mutation, and fail-closed handling for filesystem races. SQLite direct-child and descendant source queries are active-only, record-container-aware, Unicode-safe, deterministic, and bounded with explicit overflow.

Host-native implementation review converged to SHIP in round 7 after remediation of root-loss, algorithmic, containment, cross-platform, FIFO, inconsistent-scan, new-directory, bounded-materialization, Unicode, special-file, and nested-directory race findings.
## Evidence
- Commits: d41d0c37bdbe02bbb322746dcc781d63a45a4174, 2997e7582b2c44247ebf08294b7a777eaa32bd00, 153f721bacbb3745e0a603f29215da251294a5cd, eaeb7511baa401bf4ce217a560d945840b7b5193, 111dc21c208f693ddb7e2efbe6d1244c1d0ec03a, eb80ff5143e07495b0b046c9ff78db118b1bcdbf, 704257300c1a90e5e60813d42311ec44633bf160
- Tests: PATH=/Users/gordon/.local/share/mise/installs/bun/1.3.11/bin:$PATH bun test test/serve/watch-snapshot-*.test.ts test/store/watcher-source-paths*.test.ts (73 pass, 0 fail), PATH=/Users/gordon/.local/share/mise/installs/bun/1.3.11/bin:$PATH bun run lint:check (clean), host-native gpt-5.6-sol implementation review round 7: SHIP
- PRs: