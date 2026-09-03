## Goal & Context

`gno recall` runs its lexical leg through BM25 with all-terms (AND) semantics. On a memory collection without vectors, a question-shaped turn ("which branch does the QA canary deploy from?") matches nothing because the question words are required terms. Observed live during fn-135.1 on ivan: the first Hermes prefetch injected nothing until the collection was embedded; the Hermes provider now logs a one-time warning while recall reports `mode: lexical`, and README/MEMORY.md tell operators to embed the collection.

## What

- Switch recall's lexical leg to any-term matching (`anyTerm`, as search's keyword mode already offers) or a query-term pruning step so question-shaped turns retrieve on lexical-only collections.
- Keep the ranked result contract, the budget (8 facts / 512 tokens), and receipt hashing unchanged.
- Extend the fn-134 recall fixture (`evals/fixtures/memory/recall.json`) with question-shaped queries that must hit lexically; refresh the manifest pins.

## Acceptance Criteria

- R1: `gno recall` on a collection with no vectors returns the seeded fact for a natural-language question that shares one content term with it.
- R2: `bun run eval:memory` stays at 100% with the new question-shaped queries included.
- R3: The Hermes provider's lexical-mode warning and the embed advice in `integrations/hermes-gno-memory/README.md` and `docs/MEMORY.md` are updated to describe the new behavior.

## Boundaries

- Out: changing the hybrid path or reranking.
