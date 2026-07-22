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
Implemented the deterministic local lexical activation proof and bounded receipt contract.

- Added SQLite schema v12 activation receipt storage with strict read/write validation and stale/corrupt row eviction.
- Fingerprinted schema, tokenizer, active source/mirror hashes, and collection-scoped FTS synchronization state.
- Derived tokenizer-compatible Unicode probes in deterministic order, with bounded fair selection across probe-bearing documents.
- Required collection-scoped BM25 to return an exact URI/source/mirror identity before readiness becomes green.
- Persisted only corpus-keyed probe digests, exact result identity, stage timings, and failure codes; no raw query, term, snippet, or passage.
- Corrected FTS collection scoping so filtering occurs before the candidate limit.
- Added empty, stopword-only, non-Latin, full-width Unicode, trigram, mismatch, ingestion-race, FTS-loss, shared-term, mixed-corpus, corrupt receipt, migration, and schema regressions.
## Evidence
- Commits: dc3af53, 3226f0c
- Tests: bun run lint:check, bun test test/core/activation-verifier.test.ts test/store/activation-receipts.test.ts test/store/migrations.test.ts test/store/adapter.test.ts test/store/fts.test.ts test/store/fts-lexical-regression.test.ts test/spec/schemas/activation-verification.test.ts (81 passed), bun test (full suite passed), bun run eval:hybrid (88%, threshold 70%), bun run docs:verify (12 passed, 2 model-dependent skipped), .flow/bin/flowctl validate --spec fn-94-retrieval-proven-setup-and-connector --json
- PRs: