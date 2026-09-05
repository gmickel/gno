---
satisfies: [R3, R4, R5]
---
# fn-147-restoration-and-unchanged-embedding.3 Generate and checkpoint vectors by actual input identity

## Description
Generate and checkpoint vectors by actual input identity. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/embed/backlog.ts, src/embed/retry.ts, src/embed/fingerprint.ts, src/store/vector/stats.ts, test/embed/backlog.test.ts, test/embed/retry.test.ts
**Touches:** [src/embed/backlog.ts, src/embed/retry.ts, src/embed/fingerprint.ts, src/store/vector/stats.ts, test/embed/backlog.test.ts, test/embed/retry.test.ts]

### Approach

- Enumerate pending document-chunk input variants instead of assuming one title per mirror; backlog cursor and retry keys include owner/variant identity so Alpha/Beta cannot collapse. Preserve exact current formatEmbeddingInput behavior and model fingerprint checks.
- Before writing a completed embedding, revalidate current document/chunk/title/model association; attach reusable existing variants without re-inference only for identical input identity.
- Checkpoint vector plus ownership atomically and retain unprocessed/ambiguous legacy entries in backlog. Coordinate fn-146 identity-before-checkpoint checks, avoiding competing definitions.

### Investigation targets

**Required:**
- `src/embed/retry.ts:160`
- `src/embed/fingerprint.ts:21`
- `src/embed/backlog.ts`
- `src/pipeline/contextual.ts:24`
- `src/store/vector/stats.ts:124`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/embed/backlog.test.ts test/embed/retry.test.ts test/ingestion/embedding-identity.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Unchanged input avoids model calls; either title ingestion order produces correct independent mappings.
- [ ] Concurrent title/content/delete/model change discards stale completion and leaves required new input pending.
- [ ] Partial batch failure preserves successful current variants and retries only incomplete work.

## Done summary
# fn-147.3 embedding handover

Status: in_progress; host owns Flow, Git, final acceptance and QA. No commits, bridges, native model runs, live indexes, worktrees or subagents.

### Implementation and APIs

`embedBacklog` now recognizes database-backed stats via `getVectorStatsDatabase` and automatically initializes the embedding port, reads verified `getIdentity()` metadata and constructs the exact-input `VectorVariantStore`. No effective context/truncation guesses. Metadata-less/HTTP providers retain legacy behavior while no partition for that model has activated; no variant provenance or promotion is claimed. If variant authority already exists, metadata loss returns structured INVALID_INPUT rather than falling back to potentially wrong legacy vectors. Legacy mock/custom stats without a backing DB retain existing behavior. The port metadata interface is supplied by native_ports.

Identity combines actual modelFingerprint, runtimeFingerprint and existing formatting/profile/chunking fingerprint; the partition separately incorporates effective contextSize, truncationPolicy and dimensions. Before checkpoint, the captured metadata, model URI and dimensions must still match. `identityStillCurrent` is also checked after every contention delay. Explicit `variantStore` + required `identityStillCurrent` dependencies support controlled callers/tests.

New `src/embed/variant-backlog.ts` performs an owner cursor pass (documentId, seq), bounded retry of incomplete current owners, and global epoch-fenced activation only after complete current coverage. Collection-scoped processing filters document owners; it cannot promote an incomplete global partition. Successful shadow work persists without touching content_vectors; durable variant authority survives later mutations through the store contract.

New `src/embed/variant-retry.ts` exports `embedVariantBatch({store, embedPort, owners, identityStillCurrent, delays?})`. Input snapshots carry document, mirror, sequence and exact existing formatter output/hash. Retry keys now retain document + input identity. Proven reusable vectors attach without inference. Distinct owners with identical input deduplicate model work within a batch; later batches reuse durable vectors. After inference, stale title/content/deleted owners are removed before a single atomic write of successful current variants and owners. Failed model inputs remain pending and are retried without repeating successful inputs. SQLite exceptions map to structured error counts; contention uses the existing bounded backoff. Store failures roll back the entire checkpoint. No title-format changes or legacy-origin inference.

### Verification

Baseline: green (pre-edit task command; broad Bun matching ran additional tests). Final exact focused command: `TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn147-backlog bun test ./test/embed/backlog.test.ts ./test/embed/retry.test.ts ./test/embed/variant-backlog.test.ts ./test/ingestion/embedding-identity.test.ts` — 31 passed, 0 failed, 162 assertions. Typed Oxlint and Oxfmt check passed for all nine task paths. Logs: `/home/gordon/.cache/agent-tmp/gno-fn147-backlog/{baseline,final-tests,lint,format}.log`.

New real-store tests in test/embed/variant-backlog.test.ts cover R3 title order/unchanged and same-input dedupe; R4 title/content/delete/model completion invalidation and actual context partition isolation; R5 partial failure/current-owner success, atomic checkpoint rollback, collection-limited incomplete activation, no legacy deletion, metadata-less provider compatibility and prevention of fallback after activation. test/embed/retry.test.ts verifies owner/input retry keys. Existing frozen ingestion identity oracle remains unchanged and still characterizes legacy consumer paths; no clean-rebuild/retrieval restoration claim yet.

### Required downstream integration

- CLI `src/cli/commands/embed.ts` still invokes legacy embedAndStoreBatch at lines 240/262 and uses legacy countBacklog near 610. SDK `src/sdk/embed.ts` direct forced processing calls legacy embedAndStoreBatch at 159/208; non-force countBacklog 323 and zero-backlog early return 337 can bypass the new automatic path. These must move to variant-aware enumeration/counting before full production repair; no legacy writes should remain after promotion.
- `createVectorStatsPort` legacy countBacklog/getBacklog cannot identify a runtime partition from the old model/fingerprint-only arguments. New owner enumeration is store.pending, selected after actual port initialization. Integrator must use it for progress/dry run/force semantics without inventing runtime metadata.
- Runtime metadata checks detect changed port identity. Host-level model selection/resource generation changes that replace the whole port need the existing lease/context generation guard; a stale detached port cannot observe a different object by itself.
- Task4 owns retrieval variant authority/search consumers; task5 owns sync restoration and direct CLI/SDK integration. Host/task6 owns public docs and hosted guidance reconciliation, full gates and live synthetic QA. This task does not claim these surfaces fixed.

stage: impl-review - skipped(policy: user disabled formal reviews; host owns acceptance)
## Evidence
- Commits: 5e66dd1e176869f94fd77f2e8b29bcc02a81e81a
- Tests: baseline: green, bun test ./test/embed/backlog.test.ts ./test/embed/retry.test.ts ./test/embed/variant-backlog.test.ts ./test/ingestion/embedding-identity.test.ts (31 pass, 162 assertions), targeted oxlint --type-aware --type-check: green, targeted oxfmt --check: green
- PRs: