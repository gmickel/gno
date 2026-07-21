# fn-96 CJK Lexical Degradation Benchmark

## Goal & Context
<!-- scope: business -->

Measure whether GNO's public multilingual promise holds when semantic models are unavailable and retrieval falls back to lexical search. Build a dedicated Chinese, Japanese, and Korean benchmark lane before selecting or implementing any normalization/tokenization strategy.

## Architecture & Data Models
<!-- scope: technical -->

Add committed, provenance-documented CJK corpora and qrels with same-language queries, exact entities/identifiers, multi-character terms, mixed Latin/CJK strings, filenames, and punctuation variants. Run BM25-only, production hybrid, and a simple exact/substring diagnostic baseline through the existing benchmark harness.

Emit versioned JSON plus readable Markdown: per-language Recall@5/10, MRR, nDCG@10, zero-result rate, token/index size, latency, and categorized failures. Define representation candidates only as benchmark adapters; production behavior remains unchanged.

## API Contracts
<!-- scope: technical -->

- New opt-in benchmark command/fixture lane under existing `scripts/` and `evals/` conventions.
- Stable result schema records tokenizer/config/runtime fingerprints and corpus provenance.
- No CLI search behavior or public output schema changes.

## Edge Cases & Constraints
<!-- scope: technical -->

- Fixtures must be redistributable and must document licenses/source.
- Include simplified/traditional Chinese, kana/kanji, hangul, numbers, ASCII identifiers, and Unicode normalization cases.
- Prevent answer leakage from filenames/query text.
- Report each language separately; no average may hide a failed lane.
- Benchmark both cold construction cost and warm query latency.
- Keep the lane deterministic and runnable without network/API keys.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** Committed fixtures contain meaningful Chinese, Japanese, and Korean retrieval cases with explicit qrels and provenance.
- **R2:** BM25-only and production hybrid baselines emit deterministic per-language Recall, MRR, nDCG, zero-result, size, and latency metrics.
- **R3:** Failure reports categorize token-boundary, normalization, mixed-script, identifier, and ranking failures with concrete examples.
- **R4:** The benchmark defines a quantitative promotion gate for `fn-109` without selecting an implementation in advance.
- **R5:** CI-safe fixture validation tests run in the standard suite; the heavier benchmark remains documented and opt-in.
- **R6:** Public multilingual docs link the result and distinguish semantic from degraded lexical behavior.

## Boundaries
<!-- scope: business -->

No production tokenizer/normalizer change, no model switch, no unlicensed web-scale corpus, no translation benchmark, and no claim that three fixtures cover all CJK usage.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

GNO detects CJK languages but lacks evidence for its lexical fallback. Measurement prevents importing qmd-style normalization merely because a competitor uses it.

### Implementation Tradeoffs
<!-- scope: technical -->

Small deterministic fixtures enable rapid regression work; per-language reporting avoids misleading aggregate scores. Production changes are deliberately deferred to `fn-109` and gated on measured lift.

## Implementation Plan

1. `fn-96-cjk-lexical-degradation-benchmark.1` — Build licensed CJK corpora qrels and validation (**M**)
2. `fn-96-cjk-lexical-degradation-benchmark.2` — Implement deterministic CJK benchmark lanes (**M**); depends on `fn-96-cjk-lexical-degradation-benchmark.1`
3. `fn-96-cjk-lexical-degradation-benchmark.3` — Freeze promotion gates baselines and public caveats (**M**); depends on `fn-96-cjk-lexical-degradation-benchmark.2`

## Quick commands

```bash
bun test test/bench/cjk*
bun run bench:cjk-lexical -- --write
.flow/bin/flowctl validate --spec fn-96-cjk-lexical-degradation-benchmark --json
```

## References

- [Unicode UAX #29](https://unicode.org/reports/tr29/) — word-boundary tailoring.
- [SQLite FTS5](https://www.sqlite.org/fts5.html) — tokenizer/trigram constraints.
- `src/bench/types.ts:17-94` and `src/bench/metrics.ts:102-138` — current benchmark contracts.

## Early proof point

Task `fn-96-cjk-lexical-degradation-benchmark.1` validates the core approach (licensed CJK fixtures and qrels expose deterministic lexical failure categories before any production analyzer changes).
If it fails, re-evaluate fixture composition, qrels, and leakage controls before continuing with `fn-96-cjk-lexical-degradation-benchmark.2`+.

## Requirement coverage

| Req | Description | Task(s) | Gap justification |
|-----|-------------|---------|-------------------|
| R1 | Committed fixtures contain meaningful Chinese, Japanese, and Korean retrieval cases with explicit qrels and provenance. | fn-96-cjk-lexical-degradation-benchmark.1 | — |
| R2 | BM25-only and production hybrid baselines emit deterministic per-language Recall, MRR, nDCG, zero-result, size, and latency metrics. | fn-96-cjk-lexical-degradation-benchmark.2 | — |
| R3 | Failure reports categorize token-boundary, normalization, mixed-script, identifier, and ranking failures with concrete examples. | fn-96-cjk-lexical-degradation-benchmark.2, fn-96-cjk-lexical-degradation-benchmark.3 | — |
| R4 | The benchmark defines a quantitative promotion gate for `fn-109` without selecting an implementation in advance. | fn-96-cjk-lexical-degradation-benchmark.3 | — |
| R5 | CI-safe fixture validation tests run in the standard suite; the heavier benchmark remains documented and opt-in. | fn-96-cjk-lexical-degradation-benchmark.1, fn-96-cjk-lexical-degradation-benchmark.2 | — |
| R6 | Public multilingual docs link the result and distinguish semantic from degraded lexical behavior. | fn-96-cjk-lexical-degradation-benchmark.3 | — |
