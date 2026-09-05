---
satisfies: [R2, R3]
---
# fn-150-incremental-graph-reconciliation-with.2 Persist unresolved references and projection completeness

## Description
Persist unresolved references and projection completeness. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/store/migrations/, src/store/types.ts, src/store/sqlite/adapter.ts, spec/db/schema.sql, test/store/graph-reference-state.test.ts (new)
**Touches:** [src/store/migrations/, src/store/types.ts, src/store/sqlite/adapter.ts, spec/db/schema.sql, test/store/graph-reference-state.test.ts]

### Approach

- Reuse doc_links for parsed links; add minimal durable frontmatter-reference inventory including unresolved target identities, rather than persisting only resolved edges.
- Store projection-version/config fingerprint and dirty/completeness state. Missing/stale inventory selects existing full reconciliation, not an unsafe partial closure.
- Index old/new resolver keys while preserving current URI/path/wiki/title precedence; prepare one lookup index per projection pass. Coordinate migration numbering/adapter edits with fn-147.

### Investigation targets

**Required:**
- `src/ingestion/sync.ts:137`
- `src/store/sqlite/adapter.ts:3432`
- `src/store/sqlite/adapter.ts:3471`
- `src/store/migrations/runner.ts`
- `spec/db/schema.sql`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/store/graph-reference-state.test.ts test/ingestion/graph-reconciliation.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] An outside unresolved reference remains discoverable after its target is added.
- [ ] Migration/config/version changes invalidate completeness and can rebuild idempotently.
- [ ] Inventory writes and dirty marking survive interruption without claiming complete graph state.

## Done summary
# fn-150.2 storage handover

Status: in_progress. Host owns Flow, Git, final QA and commits; this worker performed no lifecycle mutations, commits, bridges, native probes or live-index access.

Implemented migration 029 and durable frontmatter reference inventory with prior document identities. Existing parsed references remain in doc_links. Deleted/renamed target snapshots survive until successful completion so the next task can discover outside incoming references using both old and new resolver keys. No production projection/closure integration yet.

### Files

- src/store/migrations/029-graph-reference-state.ts (new, migration 29)
- src/store/migrations/index.ts
- spec/db/schema.sql (same tables/indexes/triggers and internal recovery contract)
- src/store/types.ts
- src/store/sqlite/adapter.ts
- src/store/sqlite/graph-reference-state.ts (new, narrow helper)
- test/store/graph-reference-state.test.ts (new)

Additional host-authorized fn148 support, separate scoped commit ownership: src/store/sqlite/eligibility.ts plus DocumentEligibilityOptions and searchFts hunks in types.ts/adapter.ts. Fields chunkLanguage, excludeMetadata, semanticMetadata are internal and default off. Language owner EXISTS applies before FTS LIMIT; returned seq selects matching-language evidence. Semantic metadata uses JavaScript Unicode lowercasing/literal author includes and existing category/content-type membership semantics before budget; lexical default remains unchanged. Exclusion scan optionally includes author/content-type/categories and still scans all owner chunks. Malformed categories fail closed. Vector worker owns regression tests and pipeline wiring.

### API and transaction contract for fn150.3/4

Optional StorePort capability graphReferenceStore() returns a synchronous GraphReferenceStore; adapter always implements it. Operations throw on storage errors and compose with adapter transactions.

- state(version, configFingerprint): epoch, stored version/configFingerprint, dirty, inProgress, complete. Missing initial version/inventory and config/version mismatch require full recovery. complete only means current successful projection. Ordinary document/link mutation sets dirty but leaves inProgress false; an interrupted projection sets inProgress true and requires full recovery. Missing capability likewise requires existing full reconciliation.
- begin(version, configFingerprint): persist inProgress/dirty, advance epoch to fence older passes, return epoch. Identity changes clear old inventory so stale references cannot pass completion. Read prior snapshots before begin if needed. COMMIT begin before doing projection work; wrapping begin in an outer transaction that later rolls back would erase the crash marker.
- readInventory(): ordered document snapshots with raw ordered frontmatter references, including unresolved targets. Identity snapshot includes id, collection/path, docid, URI, title, mirror/source hash and content type. Deliberately no documents FK; deleted target keys remain available. URI/path/title indexes and raw target index exist. Ingestion task owns normalized lookup maps, resolver precedence and per-pass indexing; no alternate resolver is introduced.
- writeInventory({document, references}): atomic snapshot/reference replacement. References contain edgeType and raw target. Empty references mark successfully inventoried documents too. Mutations set dirty/inProgress. Failed replacement rolls back all inserted/deleted rows.
- complete(expectedEpoch): transactionally reject changed epoch or missing/stale active document identity coverage; remove inactive/deleted snapshots and clear dirty/inProgress. Caller must only invoke after successful projection, and can commit edge writes/inventory writes/completion in one outer transaction. This layer cannot prove that caller-derived edges match source text.

Document/link input triggers invalidate completeness; document timestamp/error-only updates do not. Inventory mutations invalidate completeness. Existing 028 vector tables and epoch triggers remain untouched and their tests pass. begin/complete must be used according to above contract; production sync wiring belongs to tasks 3/4.

### Verification

Pre-edit baseline: existing ./test/ingestion/graph-reconciliation.test.ts green (3 tests); deliverable storage path absent as expected.

Final: TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn150-inventory timeout 600 bun test ./test/store/graph-reference-state.test.ts ./test/ingestion/graph-reconciliation.test.ts ./test/store/migrations.test.ts ./test/store/vector/variants.test.ts — 24 passed, 194 assertions.

Focused typed Oxlint, Oxfmt --check and git diff --check passed. Logs under /home/gordon/.cache/agent-tmp/gno-fn150-inventory/{baseline,final,lint,format}.log.

Three focused tests cover outside unresolved identities after target addition/deletion; missing coverage, config/version rebuild, competing pass epochs, stale identity and idempotence; atomic injected failure plus file-backed reopen/recovery. Existing frozen mutation oracle and migration/vector tests remain green. Vector worker separately reported 66 focused hybrid/vector tests green after FTS language evidence fix; semanticMetadata follow-up tests are owned there.

No public graph behavior or QA verdict claimed. Full host gates, running surfaces, incremental resolver and crash orchestration remain downstream.

stage: impl-review - skipped(config: user disabled formal reviews; host owns acceptance)
## Evidence
- Commits: 29b9ffbd7cdba8cd38c3d5236017728afb7ca498
- Tests: baseline: green — bun test ./test/ingestion/graph-reconciliation.test.ts, TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn150-inventory timeout 600 bun test ./test/store/graph-reference-state.test.ts ./test/ingestion/graph-reconciliation.test.ts ./test/store/migrations.test.ts ./test/store/vector/variants.test.ts — 24 pass, 194 assertions, bunx oxlint --type-aware --type-check src/store/types.ts src/store/sqlite/adapter.ts src/store/sqlite/eligibility.ts src/store/sqlite/graph-reference-state.ts src/store/migrations/029-graph-reference-state.ts src/store/migrations/index.ts test/store/graph-reference-state.test.ts, bunx oxfmt --check src/store/types.ts src/store/sqlite/adapter.ts src/store/sqlite/eligibility.ts src/store/sqlite/graph-reference-state.ts src/store/migrations/029-graph-reference-state.ts src/store/migrations/index.ts test/store/graph-reference-state.test.ts, git diff --check
- PRs: