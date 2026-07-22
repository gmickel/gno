---
satisfies: [R1, R3, R4, R5, R6]
---
# fn-97-agentic-retrieval-outcome-benchmark.1 Define fixtures schemas receipts hidden oracles and deterministic scorers

## Description
Define the leak-resistant fixture, oracle, receipt, final-envelope, report, and scoring contracts before any adapter work.

**Size:** L
**Files:** `evals/agentic/types.ts`, `evals/agentic/schemas/*.schema.json`, `evals/agentic/scoring.ts`, `evals/agentic/fixture-db.ts`, `evals/fixtures/agentic-retrieval/{manifest.json,tasks,oracles,corpus}`, `test/eval/agentic/contracts.test.ts`, `test/eval/agentic/scoring.test.ts`, `test/eval/agentic/fixture-db.test.ts`, `spec/evals-agentic.md`, `spec/evals.md`

### Approach
- Create 20–30 opaque-ID task fixtures across all R1 categories. Public fixtures expose claim keys and typed value contracts; hidden oracles alone hold normalized expected values, normalizer ID/version, exact required/optional/forbidden spans, expected-missing evidence, and completion predicates.
- Define exact 1-based inclusive line coordinates, source/span SHA-256 semantics, newline canonicalization, stable fixture manifest hashes, and answer-leak validation.
- Define a prose-free `FinalEnvelope` of typed `{claimKey,value,citations}` claims, typed gaps, abstention, and stop reason. Unknown/duplicate keys, invalid values, extra claims, arbitrary prose, and uncited required claims fail unsupported/invalid.
- Define canonical-versus-observation `TrajectoryReceipt`, evidence-hash provenance, failure taxonomy, distinct `agentCalls`/`backendInvocations`, nullable separated timings, and schemas. Canonical JSON excludes volatile timing/process data but includes every decision-affecting input/output.
- Own `fixture-db.ts`: ingest/canonicalize via production paths once, emit one immutable fingerprinted index snapshot, and prove corpus/index preparation is separate from both lifecycle cohorts.
- Implement deterministic scorers for completion, typed claims/citations/gaps, evidence classes, collection/filter choice, stop quality, and R6 cohort inputs. Encode pairwise and aggregate success, agent-call/context formulas, claim-linkage, and denominator rules as tested helpers.

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
- [ ] At least 20 schema-valid opaque tasks cover every R1 category; only claim keys/types are public, while hidden normalized values/normalizers/evidence cannot leak through filenames, metadata, corpus, or briefs.
- [ ] Schemas/types pin exact UTF-8 source/span hashes and provenance, 1-based inclusive lines, prose-free typed claims/citations/gaps, canonical/observation separation, distinct agent/backend counts, failure taxonomy, and reproducibility fingerprints.
- [ ] Deterministic tests distinguish completed, supported, unsupported, missing-required, forbidden, correct-abstention, premature-stop, and unnecessary-read outcomes; unknown/invalid/extra/prose output fails.
- [ ] `fixture-db.ts` uses production ingestion/canonicalization and proves one immutable snapshot plus separate preparation accounting.
- [ ] R6 formula helpers test pairwise and aggregate success, paired-cohort equality, non-zero denominators, agent-call/context reductions, claim linkage, and unchanged-input canonical-payload equality.
- [ ] `spec/evals-agentic.md` documents fixture layout, schemas, evidence semantics, accounting, and formulas; `spec/evals.md` links it.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
