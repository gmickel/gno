# fn-109 lexical representation decision

Decision: **no ship**. No representation in the committed fn-96 comparison
clears every frozen promotion gate. No production lexical analyzer, schema,
migration, config, explain metadata, or multilingual support claim is selected.

Machine-readable receipt:
[`candidates/2026-07-22-no-ship.json`](candidates/2026-07-22-no-ship.json).

## Immutable evidence

- Baseline: [`2026-07-22.json`](2026-07-22.json), SHA-256
  `b68b7f447d3fcf22d3731d5abdd0e6dba184758763f497ab39188f20134995b9`,
  stable result fingerprint
  `11d865ebc56e5319587427473c668725ff7d1ec97e05234ec66bc63291858cea`.
- Baseline config fingerprint:
  `fa077cfe5ce65773ff646492e0590432cad3dc80f1e355ba528abfce34518c5a`.
- Baseline tokenizer fingerprint:
  `7c079447fed5ba49dcbe3c1934d41be3a99bd430852dc48ff80d990f46daba96`.
- Frozen gates: [`promotion-gates.json`](promotion-gates.json), SHA-256
  `513a9560382d192da9e9b0fe62aef7e261cc9edd176c5eae71f7857d492c79b2`.
- All positive qrels use relevance `3`. nDCG therefore measures placement of
  relevant documents, not distinctions among positive gain grades.

The committed comparison contains production BM25/model-free baselines and two
benchmark-only substring diagnostics. It contains no production-ready
segmentation, n-gram, or additive FTS candidate. The diagnostics can disprove a
promotion; they cannot establish production non-regression, index cost,
cross-platform behavior, or rollback feasibility.

## Per-language quality gates

Each metric and language is independent. No aggregate result compensates for a
failure.

### `substring-raw`

| Language | R@5 actual / floor | R@10 actual / floor | MRR actual / floor | nDCG@10 actual / floor | zero actual / ceiling | added R@10 hits / minimum | Result |
| -------- | -----------------: | ------------------: | -----------------: | ---------------------: | --------------------: | ------------------------: | ------ |
| Chinese  |    0.4444 / 0.3611 | **0.4444 / 0.4722** |    0.4444 / 0.3770 |        0.4444 / 0.3981 |   **0.5556 / 0.5278** |                 **2 / 3** | Fail   |
| Japanese |    0.8750 / 0.3750 |     0.8750 / 0.3750 |    0.8750 / 0.3750 |        0.8750 / 0.3750 |       0.1250 / 0.6250 |                     6 / 2 | Pass   |
| Korean   |    0.8750 / 0.7500 |     0.8750 / 0.7500 |    0.8750 / 0.7500 |        0.8750 / 0.7500 |       0.1250 / 0.2500 |                     3 / 2 | Pass   |

### `substring-nfc`

| Language | R@5 actual / floor | R@10 actual / floor | MRR actual / floor | nDCG@10 actual / floor | zero actual / ceiling | added R@10 hits / minimum | Result |
| -------- | -----------------: | ------------------: | -----------------: | ---------------------: | --------------------: | ------------------------: | ------ |
| Chinese  |    0.4444 / 0.3611 | **0.4444 / 0.4722** |    0.4444 / 0.3770 |        0.4444 / 0.3981 |   **0.5556 / 0.5278** |                 **2 / 3** | Fail   |
| Japanese |    0.8750 / 0.3750 |     0.8750 / 0.3750 |    0.8750 / 0.3750 |        0.8750 / 0.3750 |       0.1250 / 0.6250 |                     6 / 2 | Pass   |
| Korean   |    1.0000 / 0.7500 |     1.0000 / 0.7500 |    1.0000 / 0.7500 |        1.0000 / 0.7500 |       0.0000 / 0.2500 |                     4 / 2 | Pass   |

Both diagnostics fail the Chinese Recall@10 floor by `0.0278`, exceed the
Chinese zero-result ceiling by `0.0278`, and recover only two of the three
additional Chinese hits required by the discrete gate.

## Failure-category coverage

The gate requires the committed baseline examples to remain visible rather than
being averaged into a language score.

| Candidate       | Token boundary (`zh-q004`) | Normalization (`zh-q005`, `ja-q004`, `ko-q004`) | Mixed script (`zh-q003`, `ja-q003`, `ko-q003`) | Identifier (`zh-q002`, `ja-q001`, `ko-q001`) | Ranking (`zh-q009`) |
| --------------- | -------------------------- | ----------------------------------------------- | ---------------------------------------------- | -------------------------------------------- | ------------------- |
| `substring-raw` | Fail: 0/1                  | Fail: 0/3                                       | Fail: 2/3                                      | Fail: 2/3                                    | Pass: 1/1           |
| `substring-nfc` | Fail: 0/1                  | Fail: 1/3                                       | Fail: 2/3                                      | Fail: 2/3                                    | Pass: 1/1           |

NFC resolves the committed Korean decomposition case. It does not resolve the
Japanese normalization case or any of the four named Chinese boundary,
normalization, mixed-script, and identifier examples.

## Non-regression, cost, portability, and rollback gates

| Gate                    | Frozen requirement                                         | `substring-raw`                                          | `substring-nfc`                                          |
| ----------------------- | ---------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| Latin/code              | Recall@10 and nDCG@10 loss at most 0.02                    | Not measured; fail closed                                | Not measured; fail closed                                |
| Existing identifiers    | 0 passing queries lost; 0 new zero results                 | Not measured; fail closed                                | Not measured; fail closed                                |
| Required lexical suites | Both named suites green for candidate vs co-run production | Not run for a production candidate; fail closed          | Not run for a production candidate; fail closed          |
| Index bytes             | At most 1.75x co-run baseline; dated ceiling 566,272 bytes | No candidate index; fail closed                          | No candidate index; fail closed                          |
| Build time              | At most 2x co-run baseline; dated ceiling 1,015.68 ms      | No candidate build; fail closed                          | No candidate build; fail closed                          |
| Warm query p95          | At most 3x and at most +2 ms                               | Diagnostic 0.03 ms vs 0.71 ms; passes this sub-gate only | Diagnostic 0.02 ms vs 0.71 ms; passes this sub-gate only |
| Cross-platform variance | Recorded before selection                                  | Not measured; fail closed                                | Not measured; fail closed                                |
| Rollback feasibility    | Production representation can migrate/backfill/rollback    | Diagnostic only; not established                         | Diagnostic only; not established                         |

## Consequence

`selectedRepresentation` remains `null`; thresholds remain unchanged.
The fn-109 early proof point failed. Tasks
`fn-109-cjk-lexical-normalization.2`,
`fn-109-cjk-lexical-normalization.3`, and
`fn-109-cjk-lexical-normalization.4` must not execute: there is no justified
schema, analyzer, migration, packaging, or public support claim to implement.
A future attempt requires a new committed candidate comparison against these
same gates, not a weaker threshold or an aggregate score.
