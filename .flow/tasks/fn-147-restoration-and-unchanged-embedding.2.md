---
satisfies: [R3, R4, R5]
---
# fn-147-restoration-and-unchanged-embedding.2 Add additive input-variant storage and ownership mapping

## Description
Add additive input-variant storage and ownership mapping. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/store/migrations/, src/store/vector/types.ts, src/store/vector/stats.ts, src/store/vector/sqlite-vec.ts, spec/db/schema.sql, test/store/vector/
**Touches:** [src/store/migrations/, src/store/vector/types.ts, src/store/vector/stats.ts, src/store/vector/sqlite-vec.ts, spec/db/schema.sql, test/store/vector/]

### Approach

- Introduce vector variants keyed by model identity/fingerprint, dimensions and SHA256 of exact formatted embedding input. Bind documentId, current mirrorHash, chunk sequence and model to the variant; validate all fields against the current document and chunk. Fingerprint includes effective embedding context/truncation policy as well as model identity. Preserve canonical mirror/chunk identity and public hashes.
- Use additive migration and versioned completeness metadata; do not delete legacy rows until new mappings/consumers can serve them safely. Promote only independently proven exact legacy input; even a currently unique title owner does not prove historical vector origin. All unproven legacy input needs resumable shadow backfill.
- Use variantId as the vec0 row identity in versioned tables partitioned by model/fingerprint/dimensions. Make owner association and sqlite-vec materialization transactional with the authoritative vector row. Garbage-collect a variant only after its final valid owner disappears; test crash/rollback and shared owners.

### Investigation targets

**Required:**
- `src/store/vector/types.ts`
- `src/store/vector/stats.ts:124`
- `src/store/vector/sqlite-vec.ts`
- `src/store/migrations/runner.ts`
- `spec/db/schema.sql:215`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/store/vector/stats.test.ts test/store/vector/sqlite-vec.test.ts test/store/vector/sqlite-vec-works.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Two title-conditioned variants coexist and resolve to distinct correct owners; same exact input/model shares a variant.
- [ ] Migration records unverifiable variants pending in shadow state, resumes safely, and cannot switch authority while required active coverage is incomplete.
- [ ] Schema/port tests prove dimensions/model isolation, last-owner deletion, and sqlite-vec mirror consistency.

## Done summary
# fn-147.2 storage handover

Status: in_progress; host owns Flow, Git, review judgment and QA. No commits, native models, live indexes, bridges, worktrees or subagents.

Implemented additive v1 exact-input vector partitions and current document ownership. Alpha/Beta coexist; exact formatted input shares one vector within the full model/runtime/dimension identity. Canonical mirror/chunk hashes and all legacy vectors remain untouched. Existing consumers are deliberately unchanged for tasks 3/4.

### Files and migration

- `src/store/migrations/028-vector-variants.ts`: migration 28, additive tables and epoch triggers.
- `src/store/migrations/index.ts`: registers migration 28.
- `spec/db/schema.sql`: matching SQL contract, activation/provenance/transaction semantics and triggers.
- `src/store/vector/types.ts`: `VectorVariantIdentity`, `VectorOwnerInput`.
- `src/store/vector/variants.ts`: new narrowly scoped store, under 500 LOC.
- `test/store/vector/variants.test.ts`: six focused AC/error-case tests, including actual sqlite-vec and reopening a file-backed DB.
- `test/store/migrations.test.ts`: seven latest-schema expectations use registry latest version, with host-approved ownership. Historical expectations unchanged.

No edits to stats.ts, sqlite-vec.ts, StorePort, adapter, backlog, sync or pipeline.

### APIs for tasks 3 and 4

`createVectorVariantStore(db, identity)` asynchronously loads sqlite-vec and returns `VectorVariantStore`. Synchronous methods throw errors and compose with SQLite transactions. Identity requires model, modelFingerprint, contextSize, truncationPolicy, dimensions. Fingerprint hashes the explicit model/runtime/context/truncation identity; partition identity also hashes dimensions. Supply the actual effective embedding settings, never a guessed context or policy. `embeddingInputHash` is SHA256 of the exact existing formatter output; title policy is unchanged.

- `current(documentId, seq)` returns a current active `VectorOwnerInput` snapshot or null. Snapshot includes current mirrorHash, formattedInput and inputHash; carry it unchanged through embedding/retry.
- `pending({limit?, after?: {documentId, seq}})` enumerates missing/invalid current owner bindings in owner order. Default 1000; iterator finalized on early exit. Cursor resumes successful batches; after errors/mutations, restart a pass to catch earlier owners. Pending state is derived from durable bindings/current active chunks, not a stale queue.
- `reusable(owner)` revalidates current identity, returns an independently stored exact-input variant's ID/embedding or null. Legacy content_vectors are never eligible, even for a unique owner.
- `write([{owner, embedding?}])` returns variant IDs. Omit embedding only for an existing proven exact-input variant. Entire batch validates current owners and dimensions/finite values, stores immutable shared variant bytes, materializes vec0 and binds owners in one immediate transaction. Failure rolls back all rows, bindings, vec0 and epoch. Existing exact-input variants retain their bytes.
- `owners(variantId)` returns only bindings still matching current active document/mirror/chunk/formatted input. Never expands by shared mirror.
- `release(documentId)` removes this partition's bindings and atomically collects variants with no remaining valid owners. `collectGarbage()` additionally handles inactive/deleted/changed owners. Shared canonical chunk replacement has no cascading vector FK.
- `epoch()`, `activate(expectedEpoch)`, `hasActivated()`, `isActive()`: activation requires unchanged expected epoch, complete current active coverage and exact vec0 consistency under an immediate write transaction. Document/chunk/owner/vector inserts, updates and deletes advance the global epoch. `hasActivated()` is the durable authority marker and remains true after later mutations; retrieval must use it together with current owner validation. `isActive()` is only the current-epoch completeness receipt and becomes false after mutations; never use it as a blanket retrieval gate or legacy-fallback condition. Task 3 can renew the completeness receipt after a completed pass. Unavailable sqlite-vec cannot claim active coverage. Recreating a missing vec0 table resets the partition to shadow.
- `syncIndex()` transactionally rematerializes the partition from authoritative variants after storage-only backfill or repair; activate separately. Storage-only writes allowed before any vec0 exists; mutating an existing index without sqlite-vec is rejected.
- Readonly `identity`, `fingerprint`, `partitionId`, `tableName`, `searchAvailable` expose the partition contract. vec0 table uses integer variant_id primary key. Retrieval task 4 owns search integration.

### Verification

Baseline green: exact three existing task quick paths, 27 tests. Expanded verification: 54 tests passed, 312 assertions, including vector tests, migration upgrades and frozen ingestion identity/restoration oracle. Final focused verification after authority/completeness separation: 6 tests passed, 65 assertions. Tests additionally prove unrelated new-owner mutation retains variant authority and unaffected owners, stale owners are filtered, and missing vec0 recreation returns to shadow. Targeted typed Oxlint and Oxfmt passed. Logs: `/home/gordon/.cache/agent-tmp/gno-fn147-variants/`.

Tests cover R3 same-input/shared-owner retention and last-owner GC; R4 title/input/model/fingerprint/context/policy/dimension isolation and stale snapshots; R5 atomic multi-owner batch/vec0 failure rollback, unchanged epoch on abort, durable reopen/resume, incomplete/changed-epoch/inconsistent-index activation rejection. Old migration tests initially failed only their hardcoded 27 expectation; corrected to latest registry version. An early-exit Bun cached iterator error was fixed with a dedicated prepared statement and finally-finalize; repeated pending/activation calls exercise it.

Frozen oracle remains unchanged and still characterizes the old consumer defects. This storage task makes no end-to-end repaired retrieval/restoration claim. Host still owns full project gates, native/running-surface QA, integration, commits and Flow completion. Global epoch is intentionally conservative; unrelated document or partition writes invalidate the completeness receipt, not durable variant authority or unaffected owners. Availability is separate from authority; extension unavailability never licenses legacy fallback after promotion.

stage: impl-review - skipped(policy: user disabled formal reviews; host owns acceptance)
## Evidence
- Commits: e4b3b5ea7ae8cf5a40a9415a31c1a28aed3e4a5e
- Tests: TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn147-variants bun test ./test/store/vector/stats.test.ts ./test/store/vector/sqlite-vec.test.ts ./test/store/vector/sqlite-vec-works.test.ts (baseline pass), TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn147-variants bun test ./test/store/vector/stats.test.ts ./test/store/vector/sqlite-vec.test.ts ./test/store/vector/sqlite-vec-works.test.ts ./test/store/vector/variants.test.ts ./test/store/migrations.test.ts ./test/ingestion/embedding-identity.test.ts ./test/changes/restoration.test.ts (54 pass, 312 assertions), TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn147-variants bun test ./test/store/vector/variants.test.ts (final: 6 pass, 65 assertions), bunx --no-install oxlint --type-aware --type-check src/store/vector/variants.ts src/store/vector/types.ts src/store/migrations/028-vector-variants.ts src/store/migrations/index.ts test/store/vector/variants.test.ts test/store/migrations.test.ts (pass), bunx --no-install oxfmt --check src/store/vector/variants.ts src/store/vector/types.ts src/store/migrations/028-vector-variants.ts src/store/migrations/index.ts test/store/vector/variants.test.ts test/store/migrations.test.ts (pass)
- PRs: