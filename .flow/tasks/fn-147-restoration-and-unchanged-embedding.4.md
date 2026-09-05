---
satisfies: [R4, R5]
---
# fn-147-restoration-and-unchanged-embedding.4 Resolve vector candidates through eligible document owners

## Description
Resolve vector candidates through eligible document owners. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/store/types.ts, src/store/sqlite/adapter.ts, src/store/vector/sqlite-vec.ts, src/pipeline/vsearch.ts, src/pipeline/hybrid.ts, test/pipeline/vector-input-identity.test.ts (new)
**Touches:** [src/store/types.ts, src/store/sqlite/adapter.ts, src/store/vector/sqlite-vec.ts, src/pipeline/vsearch.ts, src/pipeline/hybrid.ts, test/pipeline/vector-input-identity.test.ts]

### Approach

- Resolve variant candidates to their current document/chunk owners before materialization; do not expand a title-specific vector to every document sharing its mirror.
- Preserve all owner egress restrictions, supported filters and public mirror/hash identifiers. Feed document/chunk eligibility into variant lookup; coordinate fn-148 contract rather than recreate global-overfetch filtering.
- Activate owner-aware retrieval atomically only after shadow backfill covers all required active bindings for the selected model/fingerprint and a final write-locked mutation-epoch check confirms freshness. Until then retain the pre-migration authoritative path without claiming new correctness; interruption resumes shadow work. After activation never fall back to unproven legacy vectors. This avoids introducing a semantic coverage drop merely to migrate schema.
- Include API/schema semantics and migration/freshness guidance in the same change without altering output shape unnecessarily.

### Investigation targets

**Required:**
- `src/store/vector/sqlite-vec.ts:274`
- `src/pipeline/vsearch.ts:122`
- `src/pipeline/hybrid.ts:257`
- `src/pipeline/filters.ts:19`
- `src/store/types.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/pipeline/vector-input-identity.test.ts test/pipeline/vsearch-n1.test.ts test/pipeline/hybrid-doc-lookup.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Alpha/Beta, duplicate-owner removal and model variants retrieve only matching owners and pass clean-rebuild comparison.
- [ ] Legacy partial migration, unavailable variants and metadata errors fail/fallback truthfully without widening scope.
- [ ] Ordinary single-title corpus deterministic ranking/input outputs remain pinned.

## Done summary
# fn147.4 owner-aware retrieval handover

Status: in_progress; host owns Git/Flow and final acceptance. Implementation is ready for the host's final checkpoint. Initial joint hybrid changes landed in host commit 7274d5fe; dependency checkpoint 8330a58a. Final edits remain for the host to commit. No worker Git, Flow, bridge, subagents, native model runs, GPU workloads or hosted-site edits.

### Implementation

`src/store/vector/variant-search.ts` selects a partition from actual initialized EmbeddingPort metadata via the existing getVariantModelFingerprint contract. sqlite-vec routes search through this helper before the legacy path. A SQLite read transaction covers owner eligibility, bulk exact-current-formatter hashing and distance ranking. Filters and exact-input validation precede K. Results carry internal documentIds for the matching input's owners; canonical public hashes/IDs/URIs and JSON result shapes stay unchanged.

Incomplete first shadow migration retains legacy authority. A durable active marker, independent of ordinary mutation epoch, prevents legacy fallback after promotion. Missing effective metadata, changed/unactivated selected partition, missing vec0 table or inconsistent vec0 materialization returns VEC_SEARCH_FAILED; hybrid records semantic fallback. Constructor no longer clears durable authority on table loss: it invalidates epoch completeness while preserving authority. Corrected the earlier foundation test's conflicting expectation (its false-activation assertion failed after this fix; recorded iteration.log).

Vsearch filters materialization to exact document IDs and retains all eligible identical-input owners. Hybrid propagates IDs into owner-keyed RRF; legacy lexical/graph inputs resolve eligible current owners only when variant hits are present. Per-owner ranks survive blending and result assembly. Rerank chooses chunks independently per owner while retaining existing body-text formatting and identical-text inference deduplication. Explain lookup retains legacy keys without owners and resolves owner-specific ranks when present. No title-format policy changed. Owner metadata failures return structured QUERY_FAILED without changing unrelated hydration exception behavior.

### Owned final paths

- src/store/vector/variant-search.ts, variants.ts, types.ts, sqlite-vec.ts
- src/pipeline/vsearch.ts, hybrid.ts, types.ts, fusion.ts, owner-fusion.ts, rerank.ts, explain.ts
- test/pipeline/vector-input-identity.test.ts, test/store/vector/variants.test.ts
- spec/cli.md, docs/API.md, docs/ARCHITECTURE.md

No edits to reserved src/store/types.ts, sqlite/adapter.ts, freshness.ts, lazy.ts, or ingestion files. All task ownership is released to the host with this handover.

### Evidence

Baseline: green, existing task pipeline tests before editing. Final exact focused gate: `TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn147-retrieval bun test ./test/pipeline/vector-input-identity.test.ts ./test/pipeline/vsearch-n1.test.ts ./test/pipeline/hybrid-doc-lookup.test.ts ./test/store/vector/variants.test.ts ./test/pipeline/fusion.test.ts ./test/pipeline/rerank-normalization.test.ts ./test/pipeline/eligible-top-k.test.ts ./test/store/eligible-top-k.test.ts ./test/embed/variant-backlog.test.ts` — 113 passed, 0 failed, 653 assertions. Typed Oxlint passed on 13 code/test paths; Oxfmt check passed on all 16 owned code/test/docs paths. Logs in /home/gordon/.cache/agent-tmp/gno-fn147-retrieval/{baseline,iteration,final-tests,lint,format}.log.

Focused new tests cover R4 Alpha/Beta matching owners, identical-input duplicates, owner filters before K, owner-specific fusion ranks, vsearch and hybrid materialization; R5 deletion versus clean current rebuild, partial migration legacy authority, stale title invalidation after promotion, missing identity, changed context partition, missing/recreated index, and owner metadata failures. Existing frozen hydration/eligible-top-K fixtures and fusion/rerank baselines remain green; no baseline refreshed. Full aggregate gates and running CLI/API acceptance remain host work.

### Integration required by fn147.5

A lost variant table is recreated empty while durable storage bindings remain. Current embedVariantBacklog sees no pending owner bindings and calls activate without syncIndex, which correctly rejects incomplete materialization. Task5 must repair materialization from authoritative stored variants before activation, including the zero-backlog path. Direct CLI/SDK embed entrypoints also remain task5 work per prior handover. CLI/API docs describe gno embed as coverage repair; ensure that integration before claiming the full feature complete.

Cost: each variant query bulk-hashes eligible owner/chunk formatted inputs and performs exact distance ranking in that eligible domain. No global overfetch approximation; CPU/hash cost scales with eligible bindings. Native latency and frozen full retrieval comparator remain aggregate QA, not claimed here. gno.sh docs are queued only after aggregate PR as instructed.

stage: impl-review - skipped(policy: user disabled formal reviews; host owns acceptance)
## Evidence
- Commits: 7274d5fe, 8330a58a, 3adcb6bcdc60641365962bd655e796eeb1168abd
- Tests: baseline: green (existing task pipeline tests), TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn147-retrieval bun test ./test/pipeline/vector-input-identity.test.ts ./test/pipeline/vsearch-n1.test.ts ./test/pipeline/hybrid-doc-lookup.test.ts ./test/store/vector/variants.test.ts ./test/pipeline/fusion.test.ts ./test/pipeline/rerank-normalization.test.ts ./test/pipeline/eligible-top-k.test.ts ./test/store/eligible-top-k.test.ts ./test/embed/variant-backlog.test.ts — 113 pass, 0 fail, 653 assertions, bunx oxlint --type-aware --type-check (13 owned code/test paths) — green, bunx oxfmt --check (16 owned code/test/docs paths) — green
- PRs: