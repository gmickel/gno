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
Enforced `sourceAvailability` across hierarchical traversal, full and targeted sync, scheduled/watch ingestion, snapshot fallback, and reconciliation. Local mode now refuses dataless or unproven directory descent, preserves indexed descendants under those prefixes, caches directory checks per operation, and retains the guarded content boundary for files; default `any` behavior remains unchanged.

Focused coverage exercises eligible files, cloud and dataless skips, actual availability errors, missing-root and eviction races, symlink refusal, targeted paths, watcher fallback, and run-level overrides. Full verification: 4,328 passed, 2 skipped, 0 failed.

GATE_SKIPPED:unittest:green-receipt e84a2e84 - baseline reused from prior post-gate pass
GATE_SKIPPED:smoke:green-receipt e84a2e84 - baseline reused from prior post-gate pass

stage: impl-review - skipped(config: REVIEW_MODE=none)
stage: plan-sync - ran [2026-08-16T12:48:54Z..2026-08-16T12:50:39Z] (model: gpt-5.6-terra)
## Evidence
- Commits: 3c868824549ad8e115d548a35e814febd4b877b3
- Tests: GATE_SKIPPED:unittest:green-receipt e84a2e84 - baseline reused from prior post-gate pass, GATE_SKIPPED:smoke:green-receipt e84a2e84 - baseline reused from prior post-gate pass, bun run lint:check, bun test test/ingestion/source-availability test/ingestion/walker.test.ts test/ingestion/sync-incremental.test.ts test/serve/watch-snapshot-availability.test.ts test/serve/watch-reconciliation.test.ts test/serve/watch-reconciliation-fallback-bounds.test.ts, bun test, bun scripts/macos-file-provider-smoke.ts --help
- PRs:
