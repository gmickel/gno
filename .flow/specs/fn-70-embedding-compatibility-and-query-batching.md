# fn-70-embedding-compatibility-and-query-batching Embedding compatibility profiles, batch fallback, and query batching

## Overview

Improve GNO's embedding compatibility layer so strong challenger models can work
more reliably without rewriting the whole embedding runtime.

This epic intentionally covers the contained, additive improvements that should
 raise the quality bar for embedding model support:

1. model-specific embedding formatting
2. batch fallback to single-item embedding on batch failure
3. batch-embed vector query variants
4. explicit embedding compatibility profiles

It explicitly does **not** attempt a deep session/lifecycle refactor. That is a
separate, more invasive follow-up only if these changes are not enough.

## Scope

Included:

- model-specific query/doc embedding formatting
- indexing-time batch fallback to per-item embedding when a batch fails
- batched embedding of vector-query variants in retrieval paths
- compatibility metadata/profiles for embedding models
- clear operator/docs guidance about when re-embedding is required
- regression tests, smoke checks, and benchmark checks for the changed behavior

Excluded:

- session-aware embedding lifecycle redesign
- changing shipped default models directly
- arbitrary model support guarantees for every GGUF embedding model
- broad retrieval-pipeline changes unrelated to embeddings

## Approach

### Prior context

- current generic formatter:
  - `src/pipeline/contextual.ts`
- indexing/embed paths:
  - `src/embed/backlog.ts`
  - `src/sdk/embed.ts`
- query-time embedding paths:
  - `src/pipeline/hybrid.ts`
  - `src/pipeline/vsearch.ts`
  - `src/sdk/client.ts`
- current native embedding runtime:
  - `src/llm/nodeLlamaCpp/embedding.ts`
  - `src/llm/nodeLlamaCpp/lifecycle.ts`
- current findings:
  - Qwen works well in the real GNO path
  - Jina-like challengers hit embedding-id/runtime issues on real fixtures
  - Nomic looks strong on tiny fixtures but fails in the real native path
- relevant qmd reference implementation:
  - `/Users/gordon/repos/qmd/src/llm.ts`
  - `/Users/gordon/repos/qmd/src/store.ts`

### Product stance

- improve compatibility without destabilizing the current working Qwen path
- keep default behavior unchanged for models without explicit compatibility data
- be honest about re-embed requirements
- optimize for product-shaped behavior, not for making every benchmark model
  pass by special-casing everything

### What this epic should deliver

#### 1. Model-specific embedding formatting

Add an embedding compatibility layer so query/doc formatting can vary by model.

Minimum expected use:

- preserve current generic formatter as the default
- allow named compatibility profiles to override:
  - query formatting
  - document formatting
- first likely profile:
  - Qwen embedding style

This is the one change in this epic that may require re-embedding for affected
models, because it changes how vectors are produced.

#### 2. Batch fallback on indexing-time embedding failure

When `embedBatch()` fails during indexing:

- do not drop the whole batch immediately
- retry item-by-item
- store successful vectors
- count only true failed items as errors

This should improve resilience for partially compatible models and make failures
more diagnosable.

#### 3. Batch-embed vector query variants

When hybrid/vector retrieval needs multiple vector-style query embeddings:

- batch them instead of embedding one-by-one
- reuse that batch in the retrieval step

This should reduce repeated runtime setup and may avoid some model/runtime edge
cases.

#### 4. Embedding compatibility profiles

Add explicit compatibility metadata for embedding models, such as:

- formatting profile id
- whether batch embedding is trusted
- optional notes about pooling/runtime expectations
- optional safety knobs like max recommended chunk length

The goal is not to expose every knob in user config immediately, but to make
the runtime behavior intentional instead of one-size-fits-all.

### Re-embed semantics

This epic must explicitly distinguish:

- changes that require re-embedding:
  - doc/query formatting changes for a model
  - chunk-treatment changes that affect stored vectors
- changes that do not require re-embedding:
  - batch fallback behavior
  - query batching only
  - runtime-only metadata that does not change vector contents

Docs and status guidance must say this clearly.

### Testing posture

Treat this epic as high-risk to retrieval correctness.

The implementation is not done unless it proves two things at the same time:

- compatibility improves for challengers
- the current working Qwen path does not regress

Minimum testing expectations across the epic:

- unit tests for compatibility-profile lookup and formatting behavior
- unit tests for indexing-time batch fallback and partial recovery
- retrieval-path tests for batched vector-query embedding
- smoke runs on the current Qwen default path after each major behavior change
- at least one benchmark/smoke comparison before and after the epic on:
  - code fixture lane
  - general multilingual lane if formatting changes affect the shared embed path

Required smoke focus:

- Qwen still works on a real code fixture
- Qwen still works on the general multilingual fixture
- `bge-m3` baseline path still works
- no change silently implies re-embedding unless docs/tests say it does

### Risks / traps

- accidentally changing Qwen behavior without measuring the impact
- silently introducing formatting drift that invalidates old vectors
- overfitting compatibility profiles to one broken challenger
- building a huge model-matrix system when a few curated profiles are enough
- treating query batching as a storage change when it is only a runtime change

### Task breakdown

#### Task 1

`fn-70-embedding-compatibility-and-query-batching.1`

Implement model-specific embedding formatting and compatibility profiles.

#### Task 2

`fn-70-embedding-compatibility-and-query-batching.2`

Add indexing-time batch fallback to per-item embedding on failure.

#### Task 3

`fn-70-embedding-compatibility-and-query-batching.3`

Batch-embed vector query variants in hybrid/vector retrieval paths.

#### Task 4

`fn-70-embedding-compatibility-and-query-batching.4`

Document re-embed implications and benchmark/runtime outcomes.

## Quick commands

- `bun run lint:check`
- `bun test`
- `bun run docs:verify`
- `bun run bench:code-embeddings --candidate bge-m3-incumbent --fixture repo-serve --dry-run`

## Acceptance

- [ ] GNO has explicit embedding compatibility profiles instead of one generic formatter for every model.
- [ ] Indexing can fall back from batch embedding to per-item embedding without discarding a whole batch.
- [ ] Hybrid/vector retrieval batch-embeds vector query variants instead of embedding them one-by-one.
- [ ] Docs say clearly which changes require re-embedding and which do not.
- [ ] The current Qwen path remains stable while compatibility improves for challengers.
- [ ] The epic lands with targeted regression coverage and smoke verification on the current Qwen path.

## References

- `src/pipeline/contextual.ts`
- `src/embed/backlog.ts`
- `src/sdk/embed.ts`
- `src/pipeline/hybrid.ts`
- `src/pipeline/vsearch.ts`
- `src/sdk/client.ts`
- `src/llm/nodeLlamaCpp/embedding.ts`
- `src/llm/nodeLlamaCpp/lifecycle.ts`
- `/Users/gordon/repos/qmd/src/llm.ts`
- `/Users/gordon/repos/qmd/src/store.ts`
