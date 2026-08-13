---
satisfies: [R1, R2, R3, R5, R6]
---
# gno-27-fast-reliable-watcher-reconciliation.2 Integrate exact and ambiguous watcher reconciliation

## Description
Wire the snapshot/fallback substrate into the shared resident `CollectionWatchService` while preserving exact-path content hashing and existing serve/daemon lifecycle behavior (R1, R2, R3, R5, R6).

**Size:** M
**Files:** `src/serve/watch-service.ts`, `src/serve/watch-reconciliation.ts`, `test/serve/watch-service.test.ts`, `test/serve/watch-reconciliation.test.ts`
**Touches:** [src/serve/watch-service.ts, src/serve/watch-reconciliation.ts, test/serve/watch-service.test.ts, test/serve/watch-reconciliation.test.ts]

### Approach
- Start event capture before snapshot initialization; buffer exact and ambiguous hints until a baseline exists, then reconcile them against a newer generation.
- Route every contained eligible path directly to `defaultSyncService.syncPaths()` so exact events always retain full content-hash decisions. Route missing filenames, ineligible temp names, directory/root events, vanished paths, and other ambiguous shapes to a dirty-directory queue.
- Deduplicate exact and reconciled candidates into one targeted batch; keep excluded subtrees ignored and reject absolute, escaping, malformed, or outside-root hints before joins/suppression checks.
- Commit snapshot generations only after successful classification and successful per-path synchronization. Requeue scan/store failures and file-level sync errors without treating them as deletes.
- Preserve config-generation full reconciliation, root replacement, suppression, ABA, in-flight edits, callbacks, scheduler/event-bus settlement, and disposal. Clear snapshot/pending state atomically when collection ownership changes.
- Bound dirty hints and suppression history, add a hard maximum flush deadline above the existing debounce, and degrade overflow/unreliable metadata to the bounded store/disk fallback.

### Investigation targets
**Required** (read before coding):
- `src/serve/watch-service.ts:127-231` — collection generation, watcher creation, filtering, suppression
- `src/serve/watch-service.ts:278-435` — debounce, serial flush, config reconciliation, queued-work loop
- `src/serve/watch-service.ts:437-470` — settlement, scheduler, and event emission
- `src/ingestion/sync.ts:1164-1260` — targeted content-safe synchronization authority
- `test/serve/watch-service.test.ts:148-346` — config, in-flight, disposal lifecycle regressions

**Optional** (reference as needed):
- `test/serve/watch-service.test.ts:390-595` — ABA, queued-edit, and deletion patterns
- `src/serve/embed-scheduler.ts:77-305` — bounded debounce/max-wait scheduler pattern; do not duplicate embedding ownership

### Key context
- `serve` and `daemon` already share this service through `ResidentRuntime`; do not fork mode-specific watcher implementations.
- Snapshot metadata is candidate discovery only, never evidence that exact eligible content is unchanged.

### Acceptance
- [ ] Exact events always reach targeted sync even when the fingerprint is unchanged; ambiguous temp/directory/missing events reconcile only proven candidates.
- [ ] Recursive deletion, new directories, atomic replacement, record containers, invalid paths, exclusions, suppression, config/root generations, initialization/in-flight events, ABA, disposal, and partial failures have focused regressions.
- [ ] Failed scans/store queries/sync paths retain dirty work and never infer inactivation; retry remains bounded and observable through existing error callbacks/state.
- [ ] Sustained unique-temp churn flushes within the documented hard maximum and all watcher-owned maps remain capped.
- [ ] Focused tests and `bun run lint:check` pass.

## Acceptance
- [ ] TBD

## Done summary
Integrated snapshot-backed exact and ambiguous watcher reconciliation into the shared resident watcher service. Exact eligible events retain targeted content-hash synchronization; ambiguous, directory, vanished, and special-file events use bounded snapshot/store/disk classification with durable full-reconcile escalation. Added capped queues, maximum flush latency, retry ownership, generation/root lifecycle protection, record-container removal handling, and failure propagation through inventory, backlink, and typed-edge cleanup paths. Host-native implementation review concluded SHIP.
## Evidence
- Commits: 10e5721e, 9b1952cf, f456a34c, 80dace84, ac59bd71, ac961639, 4974bf13
- Tests: bun test test/serve/watch-service*.test.ts test/serve/watch-reconciliation*.test.ts test/serve/watch-snapshot-*.test.ts test/store/watcher-source-paths*.test.ts test/ingestion/sync-incremental.test.ts test/ingestion/sync-links.test.ts test/ingestion/record-sync.test.ts (211 pass, 0 fail), bun run lint:check (0 warnings, 0 errors; formatting clean), host-native implementation review SHIP (reservation 041e31fa5f5248d2997e34f6c671e4fe)
- PRs: