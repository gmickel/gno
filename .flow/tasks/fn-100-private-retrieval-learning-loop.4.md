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
- [ ] Replay compares baseline/candidate outcomes and discloses stale/missing/unreplayable traces.
- [ ] No ranking/config/user-file mutation occurs even when a candidate wins.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
