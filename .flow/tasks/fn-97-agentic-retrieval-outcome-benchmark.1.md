---
satisfies: [R1, R3, R4, R5, R6]
---
# fn-97-agentic-retrieval-outcome-benchmark.1 Define fixtures schemas receipts hidden oracles and deterministic scorers

## Description
Define the leak-resistant fixture, oracle, receipt, final-envelope, report, and scoring contracts before any adapter work.

**Size:** M
**Files:** `evals/agentic/types.ts`, `evals/agentic/schemas/*.schema.json`, `evals/agentic/scoring.ts`, `evals/fixtures/agentic-retrieval/{manifest.json,tasks,oracles,corpus}`, `test/evals/agentic/contracts.test.ts`, `test/evals/agentic/scoring.test.ts`, `spec/evals-agentic.md`, `spec/evals.md`

### Approach
- Create 20–30 opaque-ID task fixtures across all R1 categories. Keep agent-visible briefs/corpus separate from hidden required/optional/forbidden/expected-missing evidence and completion predicates.
- Define exact 1-based inclusive line coordinates, source/span SHA-256 semantics, newline canonicalization, stable fixture manifest hashes, and answer-leak validation.
- Define `FinalEnvelope`, canonical-versus-observation `TrajectoryReceipt`, failure taxonomy, and schemas. Canonical JSON excludes volatile timing/process data but includes every decision-affecting input/output.
- Implement deterministic scorers for completion, structured claims/citations, evidence classes, collection/filter choice, stop quality, and R6 cohort inputs. Encode the precise paired formulas and denominator failure rules as tested helpers.

### Investigation targets
**Required** (read before coding):
- `evals/helpers/setup-db.ts`
- `src/bench/types.ts:51-94`
- `evals/fixtures/hybrid-adversarial.json`
- `spec/evals.md`

**Optional** (reference as needed):
- `evals/ask.eval.ts`
- `evals/query.eval.ts`

## Acceptance
- [ ] At least 20 schema-valid opaque tasks cover every R1 category; hidden oracles cannot leak through agent-visible filenames, metadata, corpus, or briefs.
- [ ] Schemas/types pin exact UTF-8 source/span hashes, 1-based inclusive lines, structured claims/citations, canonical/observation separation, failure taxonomy, and reproducibility fingerprints.
- [ ] Deterministic tests distinguish completed, supported, unsupported, missing-required, forbidden, correct-abstention, premature-stop, and unnecessary-read outcomes without an LLM judge.
- [ ] R6 formula helpers test paired-cohort equality, non-zero denominators, no accuracy loss, call/context reductions, claim linkage, and unchanged-input canonical-payload equality.
- [ ] `spec/evals-agentic.md` documents fixture layout, schemas, evidence semantics, accounting, and formulas; `spec/evals.md` links it.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
