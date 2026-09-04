---
satisfies: [R3, R4]
---
# fn-143-paired-retrieval-quality-and-resource.4 Implement paired lifecycle timing and resource sampling

## Description
Implement paired lifecycle timing and resource sampling. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** evals/acceptance/runner.ts (new), evals/acceptance/resources.ts (new), evals/acceptance/report.ts (new), test/eval/acceptance/runner.test.ts (new)
**Touches:** [evals/acceptance/runner.ts, evals/acceptance/resources.ts, evals/acceptance/report.ts, test/eval/acceptance/runner.test.ts]

### Approach

- Run fresh-process, resident-model-cold, warm and post-idle cases as distinct strata. Use alternated/randomized paired blocks with run order and seed recorded; serialize GPU workloads per host.
- Time the complete request including model acquisition and transport, plus stage counters; sample owned PID memory and record unrelated-host-load caveats. Do not add Metal RSS and GPU-accounted unified memory.
- Retain raw samples, sample counts, p50/p95/p99, slower cases and uncertainty. Default screening uses at least 30 paired observations per selected stratum; any claimed p99 needs at least 100 observations and remains labeled empirical. Cold physical acceptance may be smaller but must not claim a stable p99.

### Investigation targets

**Required:**
- `evals/agentic/runner.ts:92`
- `evals/agentic/types.ts:266`
- `scripts/package-smoke-isolation.ts:158`
- `scripts/package-smoke-resident.ts:425`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/eval/acceptance/runner.test.ts test/eval/agentic/runner.test.ts test/eval/agentic/runner-boundaries.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Clock/resource sampling failures and insufficient samples yield explicit incomplete/inconclusive fields.
- [ ] Empty-answer or hidden-fallback speedups fail the comparator before performance summaries.
- [ ] Owned children stop on success/failure; no long native waits or telemetry collection touches production services.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
