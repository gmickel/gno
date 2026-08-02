---
satisfies: [R1, R2, R3, R4, R5]
---

# fn-76-future-code-symbol-retrieval-and.1 Run evidence gate and record symbol-retrieval go or no-go
## Description
Run a decision study only after real workflows clear the trigger. Baseline current BM25/chunk plus line-range retrieval, preregister the smallest optional symbol-metadata comparison, retain raw quality/performance/platform evidence, and issue a terminal go/no-go decision. Do not edit production code or add runtime dependencies.

**Size:** M
**Files:** `scripts/ast-chunking-benchmark.ts`, `evals/fixtures/`, `evals/fixtures/hybrid-baseline/`, `docs/adr/006-code-symbol-graph-foundation.md`, `notes/`

## Approach
- First collect/reproduce at least three material workflows current retrieval cannot solve reliably.
- Fix fixtures, judgments, metrics, and materiality/platform budgets before inspecting candidate outcomes.
- Compare the smallest optional derived-metadata candidate in the benchmark harness only.
- End with `GO`, `NO_GO`, or `INSUFFICIENT_EVIDENCE`; a GO creates a separate implementation spec.

## Investigation targets
**Required** (read before coding):
- `docs/adr/006-code-symbol-graph-foundation.md:18-74` — current decision and reopen gates
- `docs/adr/003-code-aware-chunking.md:118-135` — current no-gain evidence
- `scripts/ast-chunking-benchmark.ts:11-13` — experimental harness boundary
- `src/ingestion/chunker.ts` — production baseline
- `docs/HOW-SEARCH-WORKS.md:250` — public current-state claim

**Optional** (reference as needed):
- `evals/fixtures/hybrid-baseline/` — retained benchmark artifact pattern
- `src/mcp/tools/index.ts:109-113` — current exact retrieval workflow

## Key context
Benchmark/research artifacts may change; production source, package runtime dependencies, schemas, graph, and public surfaces may not. Tree-sitter parse recovery does not prove symbol correctness.

## Acceptance
- [ ] Three or more material current-workflow failures are reproduced before candidate evaluation, or the task stops with `NO_GO`.
- [ ] Fixtures, judgments, metrics, thresholds, platform/package budgets, and fallback rules are preregistered and retained.
- [ ] Raw baseline/candidate quality, latency, memory, package, parser-health, incremental, and platform results are reproducible.
- [ ] Decision record is `GO`, `NO_GO`, or `INSUFFICIENT_EVIDENCE`, distinguishes symbol evidence from text match, and records the next action/trigger.
- [ ] No production code/dependency/schema/API/graph change occurs; any GO points to a new reviewed implementation spec.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
