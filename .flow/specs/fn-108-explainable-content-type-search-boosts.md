# fn-108 Explainable Content-Type Search Boosts

## Goal & Context
<!-- scope: business -->

Activate the already accepted but currently no-op `contentTypes[].searchBoost` field as a bounded, explainable soft ranking signal. Users should be able to express that certain page types matter more without allowing metadata to overwhelm actual query relevance.

## Architecture & Data Models
<!-- scope: technical -->

Normalize `searchBoost` into a conservative supported range and include it in the content-type rules fingerprint so config changes invalidate affected derived state. Resolve one effective boost from the document's canonical configured content type; category text or unconfigured frontmatter cannot trigger it.

Apply a shared bounded contribution after base score normalization/fusion and before final cutoff/rerank blending. Preserve raw scores and expose `baseScore`, configured factor, capped contribution, and final score in explain/diagnose. The contribution must be monotonic, deterministic, and capped so a weak irrelevant document cannot leapfrog a clearly relevant hit.

## API Contracts
<!-- scope: technical -->

- Config schema documents allowed range/default and warns or rejects out-of-range/non-finite values consistently.
- BM25, vector, hybrid, query, Ask, CLI/REST/MCP/SDK all consume the same effective boost.
- Explain/diagnose structured output adds an optional content-type boost component; normal output remains backward compatible.
- Benchmark configuration records the boost rules fingerprint.

## Edge Cases & Constraints
<!-- scope: technical -->

- Missing/unknown content type equals neutral boost.
- Multiple matching prefixes still resolve canonical type by existing longest-prefix rules; boosts never stack.
- Boost cannot bypass collection/tag/date/exclude/egress filters or create candidates.
- Rerank behavior must retain/protect strong original evidence and expose the blend order.
- Config edits re-evaluate affected documents/ranking without unnecessary full content conversion.
- Adversarial fixtures include keyword stuffing, boosted irrelevant docs, ties, and conflicting metadata.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** Valid configured canonical content types produce one bounded neutral/default or non-neutral boost consistently across BM25, vector, and hybrid paths.
- **R2:** Explain/diagnose reports raw/base score, factor, capped contribution, and final score with deterministic ordering.
- **R3:** Adversarial tests prove boosted irrelevant documents cannot overtake clearly relevant evidence beyond the defined cap and filters are never bypassed.
- **R4:** Search-boost rules participate in config fingerprint/invalidation and config warnings/errors are documented.
- **R5:** Existing configs without `searchBoost` retain ranking/output compatibility.
- **R6:** `fn-97` relevant tasks show no accuracy/evidence-coverage regression; any promotion claim includes before/after receipts.

## Boundaries
<!-- scope: business -->

No query-specific learned weights, automatic personalization, category-as-type coercion, candidate generation, unbounded multipliers, or hidden ranking changes.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

The schema already promises this knob. Shipping it with strict caps and explain output turns a no-op into a useful transparent control instead of deleting or leaving misleading configuration.

### Implementation Tradeoffs
<!-- scope: technical -->

A small post-normalization contribution is less expressive than retraining/reranking but works across retrieval modes and is easy to reason about. Strict caps protect relevance.
