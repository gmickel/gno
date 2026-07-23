---
satisfies: [R4, R5, R6]
---
# fn-100-private-retrieval-learning-loop.4 Export qrels and replay candidate retrieval pipelines

## Description
Deliver export qrels and replay candidate retrieval pipelines as one implementation-sized increment.

**Size:** M
**Files:** `src/core/retrieval-replay.ts`, `src/cli/commands/replay.ts`, `evals/agentic/trace-import.ts`, `test/replay/retrieval-replay.test.ts`

### Approach
- Export deterministic fn-97-compatible task/qrel/receipt fixtures keyed to immutable source hashes without raw-document duplication.
- Materialize each export from the aggregate manifest plus its immutable trace links; reject incomplete, conflicting, or redaction-mode-incompatible trace sets before writing artifacts.
- Import task-2 evidence without flattening provenance: final rank is distinct from planner retrieval rank, and each exact span retains canonical `gno://` URI, docid, source/mirror/passage hashes, sequence, source list, graph-expansion flag, and complete line range. The non-enumerable `SEARCH_RESULT_PLANNER_METADATA` and `CITATION_TRACE_METADATA` seams are runtime inputs, never serialized fixture fields themselves.
- Preserve pipeline truth from `SEARCH_RESULTS_TRACE_METADATA`: vector-only runs never acquire a lexical capability; hybrid degradation exports explicit capability outcome/reason and sorted fallback codes. Preserve replay-complete filters, including canonical sorted `collections`, query modes, temporal/tag/category/author scope, graph intent, candidate limits, and URI prefix.
- Replay only persisted receipts. Disabled tracing, record caps below the four-record minimum lifecycle, or retention-evicted sessions produce no synthetic baseline/candidate case. Keep `completed`, `partial`, `failed`, `cancelled`, and still-open/continuable receipts distinct; never convert missing citations or setup failure into irrelevance.
- Replay baseline and candidate pipeline configurations against unchanged sources, reporting rank, coverage, evidence outcomes, stale/missing state, and fingerprints.
- Require a human promotion decision; replay can recommend but never mutate boosts, prompts, models, config, or files.

### Investigation targets
**Required** (read before coding):
- `src/bench/metrics.ts`
- `src/pipeline/diagnose.ts`
- `src/pipeline/explain.ts`

**Optional** (reference as needed):
- `research/finetune`
- `src/config/saver.ts`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `evals/agentic/types.ts`

## Acceptance
- [ ] Export is canonical, references source hashes, and is directly consumable by fn-97 fixtures.
- [ ] Aggregate export identity and membership are deterministic; missing/conflicting trace links fail closed.
- [ ] Replay compares baseline/candidate outcomes and discloses stale/missing/unreplayable traces.
- [ ] No ranking/config/user-file mutation occurs even when a candidate wins.
- [ ] Export/replay fixtures retain final-rank versus planner-rank semantics, exact cited/opened spans, normalized filters, capability outcomes, fallback codes, terminal outcome, and pipeline/model/config/index fingerprints.
- [ ] Missing or retention-evicted receipts fail closed rather than being reported as successfully persisted empty runs.

<!-- Updated by plan-sync: fn-100-private-retrieval-learning-loop.2 froze evidence, filter, capability, terminal, and retention semantics for replay -->


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
