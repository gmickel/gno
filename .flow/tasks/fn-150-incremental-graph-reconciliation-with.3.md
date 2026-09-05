---
satisfies: [R1, R2, R4]
---
# fn-150-incremental-graph-reconciliation-with.3 Reconcile affected incoming source closure during scoped sync

## Description
Reconcile affected incoming source closure during scoped sync. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/ingestion/sync.ts, src/store/sqlite/adapter.ts, test/ingestion/graph-reconciliation.test.ts (new), docs/ARCHITECTURE.md, docs/DAEMON.md
**Touches:** [src/ingestion/sync.ts, src/store/sqlite/adapter.ts, test/ingestion/graph-reconciliation.test.ts, docs/ARCHITECTURE.md, docs/DAEMON.md]

### Approach

- Union changed sources with referrers matching both old and new target identities and affected ambiguous keys; include incoming sources outside the selected collection.
- Reuse selected-ID projection and existing before/after backlink collection, extending it with unresolved reference inventory. True no-op with complete state skips global content backfill.
- Fallback to complete reconciliation whenever closure completeness cannot be established; retain current rebuild path instead of inventing a new public repair command.
- Couple scoped-sync/incoming-reference guidance to changed behavior and coordinate committed restoration events with fn-147.

### Investigation targets

**Required:**
- `src/ingestion/sync.ts:1756`
- `src/ingestion/sync.ts:1606`
- `src/ingestion/sync.ts:2342`
- `src/store/sqlite/adapter.ts:4939`
- `test/ingestion/sync-incremental.test.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/ingestion/graph-reconciliation.test.ts test/ingestion/sync-incremental.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Every mutation equals full oracle including unresolved/ambiguous diagnostics.
- [ ] No-op avoids global content reads while target additions/removals update outside owned edges.
- [ ] Collection/config change or incomplete reference state triggers truthful full fallback.

## Done summary
# fn-150.3 handover

Status: in_progress; host owns Git, Flow and final QA. No commits, lifecycle mutations, bridges, formal reviews, native models or live-index access.

Implemented affected incoming-source reconciliation for scoped/path/all sync. Prior identity snapshots plus unresolved frontmatter references preserve outside-collection updates. A complete unchanged projection skips content reads and edge backfill. Explicit reconcileTypedEdges still forces the full repair/oracle path.

### Files

- src/ingestion/graph-reconciliation.ts (new, 319 LOC): extracted projection, one indexed relation resolver per old/current catalog, closure selection, conservative fallback and projection completion.
- src/ingestion/sync.ts: delegates graph orchestration; inactive identical-source restoration uses existing repair/upsert path.
- src/store/sqlite/graph-reference-state.ts: incomingLinkSources(old/new identities), querying existing doc_links via shared SQL wiki matching plus conservative configured-link candidates.
- src/store/types.ts: narrow GraphReferenceStore incomingLinkSources method.
- src/store/sqlite/adapter.ts: logical markInactive count; direct-link-edit full-recovery guard.
- test/ingestion/graph-reconciliation.test.ts: strict original mutation matrix, 1001-document no-op/incoming budget, config/version/inventory/direct-link fallback.
- test/ingestion/sync-incremental.test.ts: existing no-op assertion/title changed from one full backfill to zero (host authorized).
- docs/ARCHITECTURE.md and docs/DAEMON.md: incoming unresolved references, no-op and fallback behavior. Existing hydration/rerank documentation retained.

Separate host-authorized fn148 integration hunk in adapter.searchFts: replace rowid IN(eligible query) with correlated EXISTS using eligible_docs.id = documents_fts.rowid. No indexes, normalization or ranking changes. The vector eligibility worker owns the read-only SQL profile, exact ordered URI/raw-score/snippet comparison and post-change scaling/regression reruns. Profile before this hunk: broad 10001 ~5060ms versus EXISTS ~7.5ms; selective rare query ~1.8ms versus ~3.4ms tradeoff. Do not treat those prior profile observations as my final post-change QA.

### Closure and recovery

- Read old inventory before begin. Compare active current identity snapshots with prior snapshots; union changed/deleted IDs and requested before/after backlinks.
- Parsed-link incoming discovery matches all old/new candidate identities, not only winners, so ambiguous changes and unresolved additions are included. SQL default wiki/path semantics reuse the existing matcher; additional normalized configured-link candidates conservatively include cross-collection referrers.
- Frontmatter closure compares old/current indexed resolution using legacy first-document URI/docid/path/local-wiki/global-wiki precedence. Reuses stored raw references for unchanged affected sources; reads content only for new/changed sources.
- Missing/version/config/interrupted state takes full fallback. Collection metadata fingerprint excludes syncedAt; graph rules include hints. A dirty input epoch with no changed source identities also takes full fallback.
- setDocLinks on an unchanged inventoried source persists full-recovery authority in its write transaction, covering direct link edits even when combined with unrelated target changes.
- begin commits the dirty/inProgress marker before projection work. A changed epoch while computing closure fails rather than acknowledging an old snapshot. Projection and successful completeness commit compose with store.withTransaction; failures retain recovery authority.
- The next task still owns setDocEdges/backfill idempotence, broader interruption cases and final performance gates. Affected unchanged edge sets may still churn; genuine no-op performs no edge writes.

### Integration fixes

Baseline was RED before edits: sync-incremental expected filesMarkedInactive=1, received3 because Bun db.run().changes included vector028 and graph029 trigger writes. markInactive now captures SQLite changes() directly after the document update, before journal writes. Existing deletion regression now passes with both migrations.

The frozen fn150.1 fixture, manifest, comparator and prior baseline files are unchanged. Its current mutation test now requires exact parity on restore too: decideAction repairs inactive documents even with identical bytes, preserving existing upsert identity and journal semantics. The original five-field allowed negative branch was removed only from the current production-path expectation. fn147 workers were notified; their other entrypoints remain outside this task.

### Verification

- Final closure/storage: TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn150-closure timeout 600 bun test ./test/ingestion/graph-reconciliation.test.ts ./test/ingestion/sync-incremental.test.ts ./test/store/graph-reference-state.test.ts — 11 passed, 74 assertions.
- Related existing integration: same isolated TMPDIR, bun test ./test/ingestion/sync-links.test.ts ./test/ingestion/embedding-identity.test.ts ./test/ingestion/sync-conversion-errors.test.ts — 32 passed, 248 assertions.
- Focused typed Oxlint, Oxfmt --check, git diff --check passed.
- Exact measured 1001-document unchanged scoped sync: 0 getContent calls, 0 edge INSERT/DELETE operations. Adding Future then produced 1000 outside-owned edges with exactly 1 content read; a subsequent forced full reconciliation matched the captured incremental graph via the paired comparator.
- Original add/delete/restore/rename/title/ambiguity/config/source-disappearance matrix matches fresh-source full rebuild including diagnostics.

Logs: /home/gordon/.cache/agent-tmp/gno-fn150-closure/{baseline,final,integration,lint,format}.log.

Known downstream work: graph-performance.test.ts still pins the old production no-op amplification and will need task4's approved counter transition. Do not refresh its frozen baseline artifacts. Host full project gates, live CLI/MCP/API/site QA and website documentation reconciliation remain outstanding; no live QA verdict claimed.

stage: impl-review - skipped(config: user disabled formal reviews; host owns acceptance)
## Evidence
- Commits: 23ba2c258e2d6c27b03aa7504a7d28f88d1ae2cf
- Tests: baseline: red — bun test ./test/ingestion/graph-reconciliation.test.ts ./test/ingestion/sync-incremental.test.ts; inherited markInactive count expected 1 received 3, fixed trigger-count root cause, TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn150-closure timeout 600 bun test ./test/ingestion/graph-reconciliation.test.ts ./test/ingestion/sync-incremental.test.ts ./test/store/graph-reference-state.test.ts — 11 pass, 74 assertions, TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn150-closure timeout 600 bun test ./test/ingestion/sync-links.test.ts ./test/ingestion/embedding-identity.test.ts ./test/ingestion/sync-conversion-errors.test.ts — 32 pass, 248 assertions, bunx oxlint --type-aware --type-check src/ingestion/sync.ts src/ingestion/graph-reconciliation.ts src/store/sqlite/adapter.ts src/store/sqlite/graph-reference-state.ts src/store/types.ts test/ingestion/graph-reconciliation.test.ts test/ingestion/sync-incremental.test.ts, bunx oxfmt --check src/ingestion/sync.ts src/ingestion/graph-reconciliation.ts src/store/sqlite/adapter.ts src/store/sqlite/graph-reference-state.ts src/store/types.ts test/ingestion/graph-reconciliation.test.ts test/ingestion/sync-incremental.test.ts docs/ARCHITECTURE.md docs/DAEMON.md, git diff --check
- PRs: