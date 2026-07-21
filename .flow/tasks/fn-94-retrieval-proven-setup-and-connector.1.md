---
satisfies: [R1, R2, R4, R6]
---
# fn-94-retrieval-proven-setup-and-connector.1 Define activation receipt and lexical proof core

## Description
Deliver define activation receipt and lexical proof core as one implementation-sized increment.

**Size:** M
**Files:** `src/core/activation-verifier.ts`, `src/pipeline/search.ts`, `spec/output-schemas/activation-verification.schema.json`, `test/core/activation-verifier.test.ts`

### Approach
- Define versioned stage/result/failure codes and a bounded fingerprinted receipt shared by every surface.
- Derive a safe deterministic probe from indexed non-stopword terms, execute collection-scoped BM25, and retain only redacted term/hash/URI evidence.
- Treat empty, unsupported, tiny, stopword-only, and non-Latin corpora as explicit states.

### Investigation targets
**Required** (read before coding):
- `src/pipeline/search.ts:115-153`
- `src/store/types.ts`
- `src/bench/fixture.ts`
- `spec/output-schemas/status.schema.json`

**Optional** (reference as needed):
- `src/ingestion/language.ts`
- `src/core/depth-policy.ts`

### Key context
- Exit success requires lexical proof; semantic and optional connector stages may be pending with stable remediation codes.
- Receipts never store passages or unrestricted query history.

## Acceptance
- [ ] Fresh corpus fixture passes lexical proof before models are present.
- [ ] Wrong collection/missing result makes readiness false with a stable failure code.
- [ ] Probe receipts are bounded, redacted, fingerprinted, and invalidated after collection/index changes.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
