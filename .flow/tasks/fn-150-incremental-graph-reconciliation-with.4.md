---
satisfies: [R1, R3]
---
# fn-150-incremental-graph-reconciliation-with.4 Make edge application idempotent and recover interrupted work

## Description
Make edge application idempotent and recover interrupted work. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/store/sqlite/adapter.ts, src/ingestion/sync.ts, test/store/graph-reference-state.test.ts (new), test/ingestion/graph-reconciliation.test.ts (new)
**Touches:** [src/store/sqlite/adapter.ts, src/ingestion/sync.ts, test/store/graph-reference-state.test.ts, test/ingestion/graph-reconciliation.test.ts]

### Approach

- Diff equal edge sets rather than delete/reinsert; preserve established edge identity/order guarantees where externally relevant.
- Commit projection-complete state only with successful graph application. Failure after source writes or midway projection leaves dirty state recoverable on next sync.
- Test retry idempotence, stale inventory, failed transaction and complete rebuild recovery. No partial projection may be exposed as authoritative complete state.

### Investigation targets

**Required:**
- `src/store/sqlite/adapter.ts:4248`
- `src/ingestion/sync.ts:1787`
- `src/store/migrations/runner.ts`
- `test/store/graph-performance.test.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/store/graph-reference-state.test.ts test/ingestion/graph-reconciliation.test.ts test/store/graph-performance.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Unchanged edges cause zero actual delete/insert churn in linked1001-document case.
- [ ] Injected failures preserve dirty recovery and next sync/full rebuild matches oracle.
- [ ] Retry does not duplicate edges or suppress legitimate change-consumer state.

## Done summary
# fn-150.4 handover

Status: in_progress. Host owns Git/Flow/QA. Worker made no commits, lifecycle mutations, native-model runs, formal reviews or live-index access.

Implemented scoped edge-set diffing and validated durable projection recovery. Identical edges keep IDs/created_at and perform no actual edge INSERT/DELETE/UPDATE. Confidence-only changes update the retained row. Configured projection bypasses temporary default application, so full repair also preserves configured/manual/parsed edge identities.

### Exact files

- src/store/sqlite/graph-edge-application.ts (new): synchronous connection-local temporary staging and transactional scoped set diff.
- src/store/sqlite/adapter.ts: setDocEdges delegates normalized desired edges to diff; backfillDocEdges resolves existing SQL wiki/markdown targets then diffs. Existing target/rank semantics retained; source-ID parameters use JSON to avoid variable-limit overflow. inserted reports actual SQLite direct insert count, excluding trigger side effects.
- src/ingestion/graph-reconciliation.ts: only default/unconfigured and inactive sources enter default backfill; configured sources receive their final edge sets directly.
- test/store/graph-reference-state.test.ts: same-set identity/timestamp preservation, duplicate input normalization, confidence-only update, invalid-target rollback.
- test/store/graph-performance.test.ts: approved current production counter transition at 101/1001/5001; full-repair identity preservation added. Frozen fixture/baseline artifacts unchanged.
- test/store/links.test.ts: approved single second-backfill inserted count changes 1 to 0; first insertion remains 1.
- test/ingestion/graph-recovery.test.ts (new): three interruption cases and configured/default/manual idempotence.
- docs/DAEMON.md: unchanged edge retention and interruption/journal recovery.

No modifications to sync.ts, graph-reference-state.ts, types.ts or ARCHITECTURE.md in this task.

### Recovery evidence

Tests drive actual SyncService and a file-backed SQLite store. Cases: failure before begin after source writes, process.exit(73) while the graph transaction is open, failure immediately before completion. The child process exits without adapter.close or graceful rollback; reopen observes the old edge set and durable dirty state. Retry matches the fresh-source full oracle through the paired comparator. Exactly one committed create event for the new target remains in the source journal; retry/forced repair leave that journal byte-for-byte unchanged and retain edge IDs/timestamps.

The existing transaction/completion machinery from task3 passed these cases without further lifecycle changes. Invalid-target diff failure also rolls back deletions. No partial graph state is acknowledged as complete. Idempotence covers configured and parsed links as well as frontmatter relations; it avoids the prior default-then-configured churn.

### Gates

Baseline RED, expected existing production-counter mismatch: 9 pass/3 fail. The three tests still asserted frozen legacy no-op amplification after task3 already eliminated it. Only current production assertions changed; historical fixture identities and artifacts were not refreshed.

- Final: TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn150-idempotence timeout 600 bun test ./test/ingestion/graph-recovery.test.ts ./test/store/graph-reference-state.test.ts ./test/ingestion/graph-reconciliation.test.ts ./test/store/graph-performance.test.ts ./test/store/change-journal.test.ts ./test/core/graph-query.test.ts ./test/traces/trace-propagation.test.ts — 44 passed, 409 assertions.
- Earlier set-diff gate with complete existing links suite: bun test ./test/store/graph-reference-state.test.ts ./test/ingestion/graph-reconciliation.test.ts ./test/store/graph-performance.test.ts ./test/store/links.test.ts — 55 passed, 3800 assertions.
- Focused typed Oxlint, Oxfmt --check and git diff --check passed.

Measured current production budgets at all three pinned sizes: unchanged scoped sync 0 content reads and 0 actual edge mutations; forced full repair reads size documents but performs 0 actual edge mutations and preserves every edge row exactly.

Logs: /home/gordon/.cache/agent-tmp/gno-fn150-idempotence/{baseline,focused,final,lint,format}.log.

Host checkpoint before next owner: adapter ownership must transfer to fn147.5 only after host commits these exact files. Full project gates and public CLI/MCP/API/site QA remain host/task5 work; no public-surface QA verdict claimed.

stage: impl-review - skipped(config: user disabled formal reviews; host owns acceptance)
## Evidence
- Commits: e4e7c266
- Tests: baseline: red — 9 pass, 3 obsolete no-op amplification assertions failed before edits; intentional current-production expectation transition, TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn150-idempotence timeout 600 bun test ./test/ingestion/graph-recovery.test.ts ./test/store/graph-reference-state.test.ts ./test/ingestion/graph-reconciliation.test.ts ./test/store/graph-performance.test.ts ./test/store/change-journal.test.ts ./test/core/graph-query.test.ts ./test/traces/trace-propagation.test.ts — 44 pass, 409 assertions, TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn150-idempotence timeout 600 bun test ./test/store/graph-reference-state.test.ts ./test/ingestion/graph-reconciliation.test.ts ./test/store/graph-performance.test.ts ./test/store/links.test.ts — 55 pass, 3800 assertions, bunx oxlint --type-aware --type-check src/store/sqlite/adapter.ts src/store/sqlite/graph-edge-application.ts src/ingestion/graph-reconciliation.ts test/store/graph-reference-state.test.ts test/store/graph-performance.test.ts test/store/links.test.ts test/ingestion/graph-recovery.test.ts, bunx oxfmt --check src/store/sqlite/adapter.ts src/store/sqlite/graph-edge-application.ts src/ingestion/graph-reconciliation.ts test/store/graph-reference-state.test.ts test/store/graph-performance.test.ts test/store/links.test.ts test/ingestion/graph-recovery.test.ts docs/DAEMON.md, git diff --check
- PRs: