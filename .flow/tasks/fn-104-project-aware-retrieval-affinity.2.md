---
satisfies: [R1, R2, R4, R5]
---
# fn-104-project-aware-retrieval-affinity.2 Apply one bounded explainable affinity score

## Description
Deliver apply one bounded explainable affinity score as one implementation-sized increment.

**Size:** M
**Files:** `src/config/types.ts`, `src/config/defaults.ts`, `src/pipeline/project-affinity.ts`, `src/pipeline/types.ts`, `src/pipeline/search.ts`, `src/pipeline/vsearch.ts`, `src/pipeline/hybrid.ts`, `src/pipeline/rerank.ts`, `src/pipeline/explain.ts`, `src/pipeline/diagnose.ts`, `spec/output-schemas/query-diagnose.schema.json`, `test/config/project-affinity.test.ts`, `test/pipeline/project-affinity.test.ts`, `test/pipeline/hybrid-doc-lookup.test.ts`, `test/pipeline/vsearch-n1.test.ts`, `test/pipeline/explain.test.ts`, `test/pipeline/diagnose.test.ts`, `test/spec/schemas/query-diagnose.test.ts`

### Approach
- Apply affinity after each pipeline's final normalized base relevance score and before document-level cutoff/order through one shared scorer.
- Preserve candidate/filter generation and raw base scores; cap affinity so stronger non-project evidence wins.
- Define a combined auxiliary-ranking cap shared with future fn-108 content-type boost so bounded signals cannot stack past relevance.

### Frozen scoring contract

- Default project-affinity contribution: `0.03`.
- Maximum configurable project-affinity contribution: `0.03`.
- Maximum combined auxiliary-ranking contribution: `0.08`, shared with fn-108 content-type ranking. Compose deterministically and order-independently as `combinedAuxiliary = clamp(sum(contributions), -0.08, 0.08)`. The project maximum (`0.03`) plus fn-108's content-type maximum (`0.05`) exactly exhausts the shared budget.
- Preserve the public `0..1` score range with `final = clamp(base + combinedAuxiliary, 0, 1)`. The effective affinity contribution equals the requested contribution except when the final score saturates at `1`.
- A collection receives at most one affinity weight regardless of overlapping roots or repeated matches; affinity never stacks with itself.
- BM25 and vector apply the shared scorer after normalization. Hybrid applies it to each assembled document after the rerank/relevance blend, because one fused mirror-hash candidate may map to both project and non-project documents. Affinity is never attached to a mirror-hash candidate or applied twice.
- When affinity is active, BM25 and vector use the existing bounded `3 × output limit` oversampling pattern so comparable project evidence at the top-k boundary can be scored; inactive requests retain the exact legacy limit.
- Full-content shared-source copies remain independent through document-level scoring, then deduplicate by docid to the highest final score with stable retrieval order breaking exact ties.
- Hidden and explain/diagnose metadata preserve a typed pipeline-native raw score (`bm25`, `vector_distance`, or `hybrid_blended`), the normalized/final blended base score before affinity, and the final score after affinity.
- Explain metadata also reports requested/applied affinity weight, effective affinity contribution, requested/applied combined auxiliary total, combined cap, affinity-adjusted score, and final blended score. It exposes only redacted aliases/source metadata from task 1.
- Missing, disabled, unknown, deleted, untrusted, or unmatched roots yield bit-for-bit zero contribution. Affinity never creates candidates or changes collection/tag/date/exclude/egress admission.

### Investigation targets
**Required** (read before coding):
- `src/pipeline/search.ts:39-153`
- `src/pipeline/hybrid.ts:659-760`
- `src/pipeline/explain.ts`
- `src/pipeline/filters.ts`

**Optional** (reference as needed):
- `src/pipeline/rerank.ts`
- `src/pipeline/diagnose.ts`

### Key context
- Affinity is additive metadata/ranking only: it cannot create candidates or bypass collection/tag/date/exclude/egress filters.

## Acceptance
- [ ] BM25/vector/hybrid apply the same bounded contribution and preserve raw/base/final scores.
- [ ] Adversarial weak project matches cannot overtake clearly stronger non-project evidence.
- [ ] Explain/diagnose reports matched alias, source, cap, contribution, and combined auxiliary total deterministically.
- [ ] A non-project result whose base score leads by more than `0.03` cannot be overtaken, equal-base project results receive the soft preference, shared-mirror collection copies stay independent, and overlaps never stack.
- [ ] Boundary and `--full` regressions prove project copies are not truncated or deduplicated before their document-level score is applied.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
