---
satisfies: [R3, R4, R5]
---
# fn-118-cloud-placeholder-safe-indexing.3 Enforce availability across traversal, targeted sync, watch, and reconciliation

## Description
Route every ingestion entry point through the source-availability contract and preserve sources whose absence is unproven (R3/R4/R5).

**Size:** M
**Files:** walker, sync pipeline, watcher snapshot/reconciliation, receipt types/schemas, focused regression tests
**Touches:** [src/ingestion/walker.ts, src/ingestion/sync.ts, src/ingestion/types.ts, src/serve/watch-snapshot*, src/serve/watch-reconciliation.ts, test/ingestion/**, test/serve/**, spec/output-schemas/**]

### Approach
- Extend `WalkerPort`/`SkippedEntry` instead of creating a parallel traversal result.
- Refuse descent into dataless directories and carry skipped prefixes through reconciliation as unproven absence.
- Apply the same guard to direct `syncPaths`, scheduled/full sync, watcher candidate discovery, and every sniff/read/hash/convert/import seam.
- Emit distinct eligible/cloud-skip/dataless-prefix/error receipts.

### Investigation targets
**Required** (read before implementation):
- `src/ingestion/walker.ts:227-317` — full traversal
- `src/ingestion/sync.ts:1280-1407` — targeted bypass
- `src/ingestion/sync.ts:1845-2115` — seen-path reconciliation
- `src/serve/watch-snapshot-scan.ts:154-295` — watcher traversal
- `test/ingestion/sync-incremental.test.ts:71-130` — targeted-path regression pattern

**Optional** (reference as needed):
- `test/ingestion/sync-max-bytes.test.ts:51-103` — pre-read rejection test pattern

### Acceptance
- [ ] Dataless directories are not enumerated or materialized; descendants remain active when absence is unproven.
- [ ] Full, targeted, scheduled, and watcher ingestion share identical availability and race semantics.
- [ ] Sniffing, hashing, conversion, and record import cannot bypass guarded content access.
- [ ] Receipts distinguish skips/prefixes/errors and focused tests cover all bypass paths.

## Acceptance
- [ ] R3 no-materialization enforcement complete
- [ ] R4 stale-index and receipt semantics complete
- [ ] R5 all ingestion surfaces share the contract

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
