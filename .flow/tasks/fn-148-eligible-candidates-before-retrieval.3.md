---
satisfies: [R2, R3]
---
# fn-148-eligible-candidates-before-retrieval.3 Select vectors and hybrid candidates from eligible units

## Description
Select vectors and hybrid candidates from eligible units. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/store/vector/types.ts, src/store/vector/sqlite-vec.ts, src/pipeline/vsearch.ts, src/pipeline/hybrid.ts, test/pipeline/eligible-top-k.test.ts (new), spec/mcp.md, docs/MCP.md
**Touches:** [src/store/vector/types.ts, src/store/vector/sqlite-vec.ts, src/pipeline/vsearch.ts, src/pipeline/hybrid.ts, test/pipeline/eligible-top-k.test.ts, spec/mcp.md, docs/MCP.md]

### Approach

- Filter exact eligible owner/chunk units before vector top-K, reusing existing scoped-distance support but extending beyond mirror allowlists for language/title variants.
- Preserve document expansion/dedup/minScore and full owner egress lineage. Fewer thanK legitimate eligible results remains valid.
- Adapt to fn-147 variant ownership if already integrated; otherwise keep the contract keyed by canonical doc/chunk identity so later variant routing composes. Do not silently revert to global-K-then-filter on metadata errors.

### Investigation targets

**Required:**
- `src/store/vector/sqlite-vec.ts:274`
- `src/pipeline/vsearch.ts:122`
- `src/pipeline/vsearch.ts:597`
- `src/pipeline/hybrid.ts:592`
- `src/pipeline/hybrid.ts:822`
- `test/store/vector/sqlite-vec-works.test.ts:129`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/pipeline/eligible-top-k.test.ts test/store/vector/sqlite-vec-works.test.ts test/pipeline/vsearch-n1.test.ts test/pipeline/hybrid-doc-lookup.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Deterministic known-vector and actual native fixtures equal exhaustive eligible selection.
- [ ] Mixed-language chunks, duplicate title owners, empty allowlists and scope intersection do not leak or starve eligible matches.
- [ ] Unchanged baseline queries retain scores, ranking and selected evidence; intended corrections are individually declared.

## Done summary
# fn-148.3 handover

Status: in_progress. Host owns Flow, Git, aggregate gates and QA. No commits, Flow mutations, bridges, subagents, native GGUF inference, live service changes or hosted-site edits.

Vector and hybrid candidate selection now applies active document ownership, tags/date/category/author/path/collection, caller allowlist intersection, managed-memory scope/supersession and exact chunk language before vector distance top-K. Empty allowlists deny all; metadata SQL errors return vector failure, without global-K fallback. Reuses the shared document eligibility builder with exact JavaScript semantic metadata matching, including Unicode case folding and literal author %/_. Whole-document exclusions still inspect opposite-language chunks. Hybrid FTS original/expanded queries and expansion strength probes now receive the same supported filters, internal chunkLanguage and extended metadata exclusions before their budgets. Intent steering stays within the requested chunk language. Targeted (mirror, seq) hydration remains intact.

Files owned: src/store/vector/types.ts, src/store/vector/sqlite-vec.ts, src/store/vector/eligibility.ts (new), src/pipeline/vsearch.ts, src/pipeline/hybrid.ts, test/pipeline/eligible-top-k.test.ts, test/helpers/eligible-vector-fixture.ts (new), spec/mcp.md, docs/MCP.md. Shared prerequisites implemented by graph_inventory: DocumentEligibilityOptions chunkLanguage/excludeMetadata/semanticMetadata, shared owner SQL and FTS matching-language sequence projection. Include those coordinated files when integrating; this worker did not edit them.

Verification: baseline green on the four existing task quick paths before edits. Final five-file suite passed 76 tests / 364 assertions, including real sqlite-vec 201-document rare eligible cases at K=1/10; public searchVectorWithEmbedding/searchHybrid calls with known embedding vectors; hybrid lexical-only exclusion/language correction; empty/intersecting scope; all-chunk exclusion; literal wildcard and Unicode author handling; missing metadata; duplicate title owners; exact exhaustive SQLite distance/order parity at K=1/10/201/300. Existing frozen fn-143 hydration comparator and auxiliary recency/affinity/minScore tests pass unchanged. Targeted typed lint, formatting and diff checks pass. New helper keeps the task test below 500 LOC.

Running SQL evidence: notes/fn148.3-sql-evidence.json records native sqlite-vec availability, full SQL/parameters, plans and observed one-shot enumeration timings. The 201-document fixture produces 1 selective, 199 English broad, 200 active-all ranked canonical chunks (shared mirrors and inactive owners explain counts). Plans use existing model, chunk identity, active owner and tag indices; no index added. Distance calculation is exact over eligible rows, not fixed overfetch. The query still scans the model vector domain to check chunk membership; task4 must measure broad/selective scaling and synchronous stalls. One-shot sub-millisecond fixture timings are not a large-corpus latency claim.

Declared intended differences: eligible matches no longer starve behind excluded vectors/owners or wrong-language chunks; hybrid lexical matching-language evidence uses the first matching sequence instead of wrong-language seq0. Tied exact results have explicit distance/mirror/seq ordering. Unsupported standalone lexical language remains reserved. Public limits, fusion scoring, minScore, affinity/recency candidate multipliers, result schemas, owner expansion and document dedup remain unchanged.

Remaining owner integration: fn1474 must apply the shared eligible owner query directly to variant owner document IDs and exact chunk language before variant top-K, never mirror-expand variant hits. Current helper is canonical legacy v.mirror_hash/v.seq only. Host owns full project lint/test/docs gates, full fn143 paired workload, live end-to-end/native model QA and fn148.4 scaling acceptance. Native sqlite-vec ran; GGUF embedding fixtures did not. Tests use temporary synthetic indexes outside the repository. No frozen fixture or fn143 oracle identities changed.

Evidence: notes/fn148.3-evidence.json; SQL: notes/fn148.3-sql-evidence.json; logs and reproducible synthetic SQL script: /home/gordon/.cache/agent-tmp/gno-fn148-vector/.

stage: impl-review - skipped(policy: user disabled formal reviews; host owns acceptance)
## Evidence
- Commits: 29b9ffbd, 8455b1f937f9a49de3f9283d472590b483f43043
- Tests: TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn148-vector bun test ./test/pipeline/eligible-top-k.test.ts ./test/store/vector/sqlite-vec-works.test.ts ./test/pipeline/vsearch-n1.test.ts ./test/pipeline/hybrid-doc-lookup.test.ts ./test/store/eligible-top-k.test.ts, bun x oxlint --type-aware --type-check src/store/vector/types.ts src/store/vector/sqlite-vec.ts src/store/vector/eligibility.ts src/pipeline/vsearch.ts src/pipeline/hybrid.ts test/pipeline/eligible-top-k.test.ts test/helpers/eligible-vector-fixture.ts, bun x oxfmt --check src/store/vector/types.ts src/store/vector/sqlite-vec.ts src/store/vector/eligibility.ts src/pipeline/vsearch.ts src/pipeline/hybrid.ts test/pipeline/eligible-top-k.test.ts test/helpers/eligible-vector-fixture.ts spec/mcp.md docs/MCP.md, git diff --check -- src/store/vector/types.ts src/store/vector/sqlite-vec.ts src/store/vector/eligibility.ts src/pipeline/vsearch.ts src/pipeline/hybrid.ts test/pipeline/eligible-top-k.test.ts test/helpers/eligible-vector-fixture.ts spec/mcp.md docs/MCP.md, TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn148-vector bun /home/gordon/.cache/agent-tmp/gno-fn148-vector/sql-evidence.ts
- PRs: