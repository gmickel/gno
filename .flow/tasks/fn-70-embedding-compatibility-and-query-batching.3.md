# fn-70-embedding-compatibility-and-query-batching.3 Batch-embed vector query variants in retrieval paths

## Description

Reduce repeated query-time embedding work in vector/hybrid retrieval.

Start here:

- `src/pipeline/hybrid.ts`
- `src/pipeline/vsearch.ts`
- `src/sdk/client.ts`

Requirements:

- when multiple vector-style query variants exist, batch-embed them
- reuse the resulting embeddings in the retrieval step
- keep existing result semantics unchanged
- preserve current behavior for simple single-query vector search where batching
  adds no value
- tests should cover:
  - batched vector-query embedding in hybrid path
  - unchanged single-query behavior
- include smoke checks that hybrid/vector retrieval on the current Qwen path
  keeps returning the same top relevant docs on representative fixtures

Important:

- this is a runtime-only optimization
- it should not require re-embedding

Tests / smoke:

- hybrid/vector pipeline tests for batched query embedding
- regression tests that single-query `vsearch` still behaves correctly
- smoke compare on a current benchmark fixture before/after the change

## Acceptance

- [ ] Hybrid/vector retrieval batch-embeds vector query variants.
- [ ] Single-query behavior remains correct.
- [ ] Result ranking semantics stay unchanged apart from intended runtime improvements.
- [ ] Tests cover the batching path.
- [ ] Smoke comparison shows no regression on the current Qwen path.

## Done summary

Implemented batched vector-query embedding in hybrid retrieval.

Delivered:

- hybrid retrieval now batch-embeds original/vector/HyDE query embeddings when variants are present
- single-query vector behavior remains unchanged
- batch recovery helper is reused so untrusted profiles degrade safely
- added regression coverage proving batch path on hybrid and unchanged single-query behavior

## Evidence

- Commits:
- Tests: bun test test/pipeline/hybrid-query-batching.test.ts, bun run lint:check
- PRs:
