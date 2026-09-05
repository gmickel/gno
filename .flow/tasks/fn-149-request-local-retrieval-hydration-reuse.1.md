---
satisfies: [R1, R2]
---
# fn-149-request-local-retrieval-hydration-reuse.1 Introduce request-owned hydration and equality counters

## Description
Introduce request-owned hydration and equality counters. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/pipeline/hydration.ts (new), test/pipeline/hydration.test.ts (new), evals/fixtures/acceptance/hydration-long-doc/
**Touches:** [src/pipeline/hydration.ts, test/pipeline/hydration.test.ts, evals/fixtures/acceptance/hydration-long-doc/]

### Approach

- Create explicit request-owned immutable raw document/chunk/content caches and in-flight deduplication; no module-global map or cached failure across requests.
- Use content hash for immutable raw data and owner/doc identity where titles differ. Avoid prepared-input caching initially; if introduced it must include query/intent/model/preset identity.
- Instrument test-only hydrated row/byte/read counts and connect the1000-chunk fixture to fn-143 exact output/model-input comparator. Preserve existing consistency semantics without long read transactions around native inference.

### Investigation targets

**Required:**
- `src/store/content-batch.ts:9`
- `src/store/types.ts:1997`
- `src/pipeline/result-context.ts`
- `test/pipeline/search-n1.test.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/pipeline/hydration.test.ts test/pipeline/search-n1.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Repeated loads within one request deduplicate; next request after edit/missing result reads fresh state.
- [ ] Abort/completion releases ownership without clearing data still used by an active stage.
- [ ] Negative stale-input control fails parity; counters measure row volume as well as round trips.

## Done summary
# fn-149-request-local-retrieval-hydration-reuse.1

Implemented `RequestHydration` with request-owned detached/frozen raw chunk,
content and document snapshots, pending-read deduplication, retryable errors,
and idempotent release/abort. Existing consumers receive StorePort-compatible
results; result maps and document arrays are caller-owned. No integration,
global cache, prepared-input cache, transaction, native model, Git or Flow
lifecycle operation was performed by this worker.

Files:
- `src/pipeline/hydration.ts`
- `test/pipeline/hydration.test.ts`
- `evals/fixtures/acceptance/hydration-long-doc/fixture.ts`
- `evals/fixtures/acceptance/hydration-long-doc/manifest.json`
- `evals/fixtures/acceptance/hydration-long-doc/README.md`

Document lookup caches the exact ordered hash-list plus collection and
activeOnly settings. It retains all owners and their titles, preserving the
adapter's document ordering, including SQL batch boundaries. Regrouping these
rows by hash would change that order. Chunk/content caching uses mirror hash.
Missing values remain stable within a request; failures are evicted for retry.
Release clears ownership without mutating values or cancelling pending reads;
new reads fail with QUERY_FAILED. Caller mutations of original store rows do
not affect the detached snapshots.

Baseline: green, `bun test ./test/pipeline/search-n1.test.ts` (new hydration test
did not yet exist). Final focused suite: 10 passed, 0 failed, 62 assertions.
The paired 1,000-chunk fixture drives real searchBm25 and rerankCandidates with
duplicate candidates and two deterministic model identities. fn-143's exact
comparator checks complete public outputs and captured reranker-port arguments.
The deliberately stale/shortened input fails parity. Hydration work decreases
from 5 reads / 3,002 rows / 11,601,473 UTF-8 bytes to 2 reads / 1,001 rows /
4,640,789 UTF-8 bytes. This measures raw store hydration, not all JS allocation.

Fixture SHA-256: fd7fd4ba729385ffefcf59b423b9ca2b73891956f92cc97ac121e2fcae0d8c9e.
Existing fn-143 fixture pins remain unchanged.

Other focused coverage: completion and abort while a read is pending;
in-flight deduplication; immutable snapshots after source mutation; fresh next
request after missing content, returned errors and thrown errors; collection
and activeOnly isolation; multiple owners sharing a hash and title edits.

Validation commands and log paths are in `notes/fn149.1-evidence.json`.
Targeted type-aware/type-check lint and formatting passed. A relative-path
`oxlint --no-ignore` invocation hit an upstream tsgolint absolute-path panic;
the same check with absolute file paths passed. Evals fixture paths are excluded
by repo lint configuration; the imported fixture is exercised by the tests.

stage: impl-review - skipped(config: user disabled formal reviews)

Task remains in_progress for host-owned commit, gates and heavy live QA.
No native or live-surface acceptance claimed. Downstream task integration is
still required before any application-wide savings can be claimed.
## Evidence
- Commits: ad3047fee75aa54181902a0c954d8d3f15039caa
- Tests: baseline: green - bun test ./test/pipeline/search-n1.test.ts, TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn149-hydration timeout 600 bun test ./test/pipeline/hydration.test.ts ./test/pipeline/search-n1.test.ts (10 pass, 0 fail, 62 assertions), TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn149-hydration bunx oxlint --no-ignore --type-aware --type-check /home/gordon/work/gno/src/pipeline/hydration.ts /home/gordon/work/gno/test/pipeline/hydration.test.ts /home/gordon/work/gno/evals/fixtures/acceptance/hydration-long-doc/fixture.ts (0 warnings, 0 errors; fixture excluded by repo config), bunx oxfmt --check src/pipeline/hydration.ts test/pipeline/hydration.test.ts evals/fixtures/acceptance/hydration-long-doc (passed)
- PRs: