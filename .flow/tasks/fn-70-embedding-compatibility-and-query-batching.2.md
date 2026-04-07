# fn-70-embedding-compatibility-and-query-batching.2 Add indexing-time batch fallback to per-item embedding

## Description

Make indexing-time embedding more resilient.

Start here:

- `src/embed/backlog.ts`
- `src/sdk/embed.ts`
- `src/llm/nodeLlamaCpp/embedding.ts`

Requirements:

- when `embedBatch()` fails, retry the current batch item-by-item
- store successful vectors from the fallback path
- count only real failed items as errors
- do not change successful fast-path behavior
- add tests for:
  - full batch success
  - batch failure with partial per-item recovery
  - full per-item failure
- include at least one smoke case proving the Qwen indexing path still embeds
  and searches correctly after the fallback logic lands

Important:

- this is a runtime resilience change only
- it should not require re-embedding by itself

Tests / smoke:

- store/sdk/embed-path unit tests for partial recovery
- one real-fixture smoke on the current Qwen path
- one synthetic failure test that forces `embedBatch()` failure and proves
  per-item recovery stores usable vectors

## Acceptance

- [ ] Indexing falls back to per-item embedding on batch failure.
- [ ] Successful items from a failed batch are still stored.
- [ ] Error counts reflect only true failed items.
- [ ] Tests cover batch success, partial recovery, and full failure.
- [ ] Smoke verification proves Qwen indexing/retrieval still works after the fallback logic lands.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
