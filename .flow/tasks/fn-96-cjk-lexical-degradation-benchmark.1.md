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
TBD

## Evidence
- Commits:
- Tests:
- PRs:
