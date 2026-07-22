---
satisfies: [R1, R5]
---
# fn-96-cjk-lexical-degradation-benchmark.1 Build licensed CJK corpora qrels and validation

## Description
Deliver build licensed cjk corpora qrels and validation as one implementation-sized increment.

**Size:** M
**Files:** `evals/fixtures/cjk-lexical-benchmark`, `test/bench/cjk-fixtures.test.ts`, `spec/evals.md`

### Approach
- Create redistributable Chinese, Japanese, and Korean cases with same-language queries, exact identifiers, mixed scripts, punctuation, Unicode normalization, and per-language qrels.
- Document source/license/provenance review and use opaque fixture names so filenames/query text cannot leak answers.
- Validate normalization variants, coverage categories, and minimum case counts in the standard test suite.

### Investigation targets
**Required** (read before coding):
- `evals/fixtures/corpus`
- `evals/fixtures/queries.json`
- `src/ingestion/language.ts:255-330`
- `spec/evals.md`

**Optional** (reference as needed):
- `evals/CLAUDE.md`
- `evals/README.md`

## Acceptance
- [ ] Each CJK language has meaningful independently reported cases and explicit qrels/provenance.
- [ ] Fixtures cover simplified/traditional Chinese, kana/kanji, hangul, ASCII identifiers, mixed scripts, punctuation, and normalization.
- [ ] Leakage/license/shape validation runs offline in bun test.


## Done summary
Added a versioned, redistributable CJK lexical benchmark fixture contract with 21 opaque MIT-licensed synthetic documents and 24 same-language Chinese, Japanese, and Korean queries. Separate graded qrels, source provenance and SHA-256 digests, explicit Unicode/category metadata, and offline validation cover license, shape, per-language minimums, required scripts/categories, normalization variants, dangling judgments, and filename/query leakage. Documented the fixture lane in `spec/evals.md` without changing production retrieval behavior.
## Evidence
- Commits: 3c20e05
- Tests: bun test test/bench/cjk-fixtures.test.ts (6 pass, 965 assertions), bun run lint:check, .flow/bin/flowctl validate --spec fn-96-cjk-lexical-degradation-benchmark --json
- PRs: