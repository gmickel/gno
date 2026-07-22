# CJK lexical promotion gates

Frozen: 2026-07-22

These gates bind `fn-109` to the immutable
[`2026-07-22.json`](2026-07-22.json) result with stable fingerprint
`5a3e4018bffaf1e640909d562aa596747d49c88cd9fbd781a06a72cf7d8b87ca`.
They do not select a tokenizer, segmenter, normalizer, n-gram scheme, or storage
layout in advance.

## Baseline and quality floor

The production BM25 and model-free hybrid lanes produced the same quality.
Chinese has nine queries because it includes the dedicated rank-6 audit case;
Japanese and Korean have eight each. Every candidate metric must improve by at
least `0.25`, and every language must add at least two relevant hits. Because
Recall is discrete, Chinese must add three hits to clear the absolute lift.
Every metric and language passes independently; an aggregate cannot hide a
failure.

| Language | Queries | Baseline R@5 | Baseline R@10 | Baseline MRR | Baseline nDCG@10 | Baseline zero | Minimum R@5 | Minimum R@10 | Minimum MRR | Minimum nDCG@10 | Maximum zero |
| -------- | ------: | -----------: | ------------: | -----------: | ---------------: | ------------: | ----------: | -----------: | ----------: | --------------: | -----------: |
| Chinese  |       9 |       0.1111 |        0.2222 |       0.1296 |           0.1507 |        0.7778 |      0.3611 |       0.4722 |      0.3796 |          0.4007 |       0.5278 |
| Japanese |       8 |       0.1250 |        0.1250 |       0.1250 |           0.1250 |        0.8750 |      0.3750 |       0.3750 |      0.3750 |          0.3750 |       0.6250 |
| Korean   |       8 |       0.5000 |        0.5000 |       0.5000 |           0.5000 |        0.5000 |      0.7500 |       0.7500 |      0.7500 |          0.7500 |       0.2500 |

All positive qrels currently use relevance `3`. Consequently, nDCG measures
where relevant documents appear, but cannot distinguish among multiple positive
gain grades. `fn-109` must preserve this caveat or add genuinely graded qrels
before making a graded-relevance claim.

## Concrete failure coverage

The baseline is dominated by zero-result failures, with one deliberately
constructed misordering. A candidate must report these categories and examples
explicitly:

| Category       | Baseline examples               | What the example exposes                                                                                                                       |
| -------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Token boundary | `zh-q004`                       | Contiguous Chinese terms disappear under the current token representation.                                                                     |
| Normalization  | `zh-q005`, `ja-q004`, `ko-q004` | Compatibility-width or decomposed query text does not match canonical corpus text.                                                             |
| Mixed script   | `zh-q003`, `ja-q003`, `ko-q003` | Latin identifiers plus CJK context fail as one lexical request.                                                                                |
| Identifier     | `zh-q002`, `ja-q001`, `ko-q001` | Exact ASCII identifiers do not rescue the surrounding CJK query.                                                                               |
| Ranking        | `zh-q009`                       | A Chinese phrase plus shared audit token retrieves six documents while the relevant source ranks sixth, proving genuine below-rank-5 behavior. |

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
  465.13 ms, or 930.26 ms at the cap.
- Warm query p95: at most `3x` the co-run baseline and no more than `2 ms`
  absolute increase. The dated ratio ceiling is 1.83 ms from a 0.61 ms baseline.

Ratios, not the dated milliseconds, decide promotion across machines. A
candidate must also preserve deterministic fingerprints, source spans, and
canonical user-visible text.

## Decision rule

`fn-109` may choose any deterministic representation that passes every
per-language quality floor, failure-category check, non-regression gate, and
cost cap. If none passes, record a no-ship decision instead of weakening the
thresholds.
