---
satisfies: [R1, R3]
---
# fn-149-request-local-retrieval-hydration-reuse.3 Add targeted chunk batching for safe plain retrieval

## Description
Add targeted chunk batching for safe plain retrieval. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/store/types.ts, src/store/sqlite/adapter.ts, src/pipeline/search.ts, src/pipeline/vsearch.ts, test/store/chunks-batch-targeted.test.ts (new), test/pipeline/search-n1.test.ts, test/pipeline/vsearch-n1.test.ts
**Touches:** [src/store/types.ts, src/store/sqlite/adapter.ts, src/pipeline/search.ts, src/pipeline/vsearch.ts, test/store/chunks-batch-targeted.test.ts, test/pipeline/search-n1.test.ts, test/pipeline/vsearch-n1.test.ts]

### Approach

- Add batch-by-(mirrorHash,seq) chunk reads alongside existing whole-hash batching. Preserve exact selected sequence including plain BM25 sequence0 behavior.
- Use targeted reads only when intent/steering/document-wide exclusion or other selection semantics do not require all chunks; retain full hydration on those branches.
- Reuse request hydration keys and fn-147 ownership identity when applicable; do not conflate identical mirrors with different document titles.
- Document internal loading changes where architecture text changes, without adding a public cache knob.

### Investigation targets

**Required:**
- `src/store/types.ts:1997`
- `src/store/sqlite/adapter.ts:2586`
- `src/pipeline/search.ts:253`
- `src/pipeline/vsearch.ts:162`
- `test/pipeline/search-n1.test.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/store/chunks-batch-targeted.test.ts test/pipeline/search-n1.test.ts test/pipeline/vsearch-n1.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Plain one-result1000-chunk fixture loads only required rows/characters and has identical output.
- [ ] Full-context branches and missing-sequence behavior preserve prior error/selection semantics.
- [ ] New store batch operation handles duplicates/empty input with stable mapping and no N+1 calls.

## Done summary
# fn-149-request-local-retrieval-hydration-reuse.3

Implemented optional StorePort.getChunksBySequenceBatch and SQLite exact-pair batching (450 pairs/query). Plain BM25 retains exact FTS sequence, including real document-level seq0; vector retains exact hit sequence. Existing whole-hash fallback remains available to adapters without this capability. Intent and document-wide exclusion retain whole-hash hydration. Full output can use targeted chunks because canonical content is fetched separately; tested exact parity. No ranking, owner projection, request lifecycle, global cache, schema, fixture pins, hosted site, or native runtime changes.

R1/R3: frozen 1000-chunk fixture is SHA-256 verified against the existing manifest. Real SQLite + searchBm25 and searchVectorWithEmbedding paired captures pass fn-143 compareAcceptance and full object equality (including symbol metadata). One batch read before/after: 1000 rows / 2,063,895 text characters becomes 1 row / 2,062 characters BM25, or 1 row / 2,069 characters vector. Real vector search uses a deterministic fake neighbor port, not native inference. Model inputs are not modified by these plain paths. No allocation or native latency claim.

Full-context coverage: intent, exclusions matching a distant chunk, absent exclusions, and full document output. Prior fn148.2 lexical eligibility can correctly remove excluded documents before hydration (zero rows); vector still checks all chunks. Missing seq0 preserves lexical FTS snippet/no range, missing vector sequence is omitted. Returned batch errors preserve lexical fallback vs vector QUERY_FAILED. Duplicate/empty batches, missing hash/sequence, stable seq order across three SQL batches, and no per-row or whole-hash fallback queries are tested. Legacy store fake implementations remain unchanged and prove optional fallback compatibility.

Baseline green: 10 tests / 45 assertions across existing search-n1 and vsearch-n1 paths; new store test did not yet exist. Final focused + regression verification: 31 passed, 0 failed, 261 assertions. Typed lint/type-check and formatting passed on owned files. Architecture documents loading behavior. Full project gates and live QA remain host-owned.

stage: impl-review - skipped(config: user disabled formal reviews)

Task remains in_progress. No Git or Flow state mutation performed. Ownership of all assigned files released to conductor on handoff.
## Evidence
- Commits: fa4feda75555dfcfd0cbf8870d00f42b5c702fb6
- Tests: TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn149-targeted timeout 600 bun test ./test/store/chunks-batch-targeted.test.ts ./test/pipeline/search-n1.test.ts ./test/pipeline/vsearch-n1.test.ts ./test/store/eligible-top-k.test.ts ./test/pipeline/hydration.test.ts, bunx oxlint --type-aware --type-check /home/gordon/work/gno/src/store/types.ts /home/gordon/work/gno/src/store/sqlite/adapter.ts /home/gordon/work/gno/src/pipeline/search.ts /home/gordon/work/gno/src/pipeline/vsearch.ts /home/gordon/work/gno/test/store/chunks-batch-targeted.test.ts /home/gordon/work/gno/test/pipeline/search-n1.test.ts /home/gordon/work/gno/test/pipeline/vsearch-n1.test.ts, bunx oxfmt --check src/store/types.ts src/store/sqlite/adapter.ts src/pipeline/search.ts src/pipeline/vsearch.ts test/store/chunks-batch-targeted.test.ts test/pipeline/search-n1.test.ts test/pipeline/vsearch-n1.test.ts docs/ARCHITECTURE.md
- PRs: