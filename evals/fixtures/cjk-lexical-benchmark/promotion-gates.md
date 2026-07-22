# CJK lexical promotion gates

Frozen: 2026-07-22

These gates bind `fn-109` to the immutable
[`2026-07-22.json`](2026-07-22.json) result with stable fingerprint
`15fa566ae8f262fbf1108d1dc74df5f2adc2b1eac05b616eb8551f88e41edb60`.
They do not select a tokenizer, segmenter, normalizer, n-gram scheme, or storage
layout in advance.

## Baseline and quality floor

The production BM25 and model-free hybrid lanes produced the same quality. Each
language has eight queries, so the Recall and zero-result changes require two
additional relevant hits. The matching `0.25` MRR and nDCG floors additionally
require those hits to rank well; they are not implied by recall alone. Every
metric and language must pass independently; an aggregate cannot hide a
failure.

| Language | Baseline R@5/R@10/MRR/nDCG@10 | Baseline zero-result | Minimum candidate R@5/R@10/MRR/nDCG@10 | Maximum candidate zero-result |
| -------- | ----------------------------: | -------------------: | -------------------------------------: | ----------------------------: |
| Chinese  |                        0.1250 |               0.8750 |                                 0.3750 |                        0.6250 |
| Japanese |                        0.1250 |               0.8750 |                                 0.3750 |                        0.6250 |
| Korean   |                        0.5000 |               0.5000 |                                 0.7500 |                        0.2500 |

All positive qrels currently use relevance `3`. Consequently, nDCG measures
where relevant documents appear, but cannot distinguish among multiple positive
gain grades. `fn-109` must preserve this caveat or add genuinely graded qrels
before making a graded-relevance claim.

## Concrete failure coverage

The baseline is dominated by zero-result failures rather than merely poor
ordering. A candidate must report these categories and examples explicitly:

| Category       | Baseline examples               | What the example exposes                                                                                             |
| -------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Token boundary | `zh-q004`                       | Contiguous Chinese terms disappear under the current token representation.                                           |
| Normalization  | `zh-q005`, `ja-q004`, `ko-q004` | Compatibility-width or decomposed query text does not match canonical corpus text.                                   |
| Mixed script   | `zh-q003`, `ja-q003`, `ko-q003` | Latin identifiers plus CJK context fail as one lexical request.                                                      |
| Identifier     | `zh-q002`, `ja-q001`, `ko-q001` | Exact ASCII identifiers do not rescue the surrounding CJK query.                                                     |
| Ranking        | `zh-q001`, `ja-q002`, `ko-q007` | Catch-all for non-diagnostic categories; these baseline examples are zero-result failures, not observed misordering. |

The raw/NFC substring lanes are diagnostics only. Their results show that
representation changes can recover cases, but they are not a production design
recommendation and do not satisfy the full promotion contract.

## Non-regression and cost caps

Candidate and current production analyzers must run together against identical
fixtures and runtime state.

- Latin/code Recall@10 and nDCG@10: at most `0.02` absolute loss each.
- Existing exact identifiers: zero previously passing cases lost and zero new
  zero-result cases.
- Focused lexical suites: `test/store/fts-lexical-regression.test.ts` and
  `test/cli/search-fixtures.test.ts` remain fully green.
- Index size: at most `1.75x` the co-run production baseline. Relative to the
  dated 323,584-byte index, the reference ceiling is 566,272 bytes.
- Index build time: at most `2x` the co-run baseline. The dated reference is
  487.71 ms, or 975.42 ms at the cap.
- Warm query p95: at most `3x` the co-run baseline and no more than `2 ms`
  absolute increase. The dated ratio ceiling is 2.01 ms from a 0.67 ms baseline.

Ratios, not the dated milliseconds, decide promotion across machines. A
candidate must also preserve deterministic fingerprints, source spans, and
canonical user-visible text.

## Decision rule

`fn-109` may choose any deterministic representation that passes every
per-language quality floor, failure-category check, non-regression gate, and
cost cap. If none passes, record a no-ship decision instead of weakening the
thresholds.
