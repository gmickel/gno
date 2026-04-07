# fn-69-evaluate-gemma-4-e2b-it-for-compact Evaluate Gemma 4 E2B-it for compact local answer generation

## Overview

Determine whether `Gemma 4 E2B-it` is a good challenger for GNO's compact
`gen` / answer-model lane.

The question is not "is Gemma 4 good in general?" It is narrower:

- is `Gemma 4 E2B-it` better enough than the current compact answer model to be
  worth adopting in GNO?
- does it still fit the slim / slim-tuned product lane in practice?
- does it improve grounded answer quality on GNO-shaped docs enough to justify a
  change?

This epic should reuse the real GNO answer-generation path and produce a
measured recommendation, not a vibes-based model swap.

## Scope

Included:

- compact-lane answer benchmarking for `Gemma 4 E2B-it`
- comparison against the current compact shipped `gen` model
- reuse of GNO's real answer-generation pipeline
- quality, latency, and practical runtime-fit evaluation
- recommendation for:
  - no change
  - experimental/custom preset only
  - shipped preset candidate

Excluded:

- embedding model changes
- reranker changes
- multimodal/image/audio work
- large Gemma 4 variants (`E4B`, `26B`, `31B`) unless needed as context only
- changing defaults before benchmark evidence exists

## Approach

### Prior context

- Current compact preset family:
  - `src/config/types.ts`
- Existing answer eval lane:
  - `evals/ask.eval.ts`
  - `evals/fixtures/ask-cases.json`
- Existing retrieval-candidate benchmark helper:
  - `evals/helpers/retrieval-candidate-benchmark.ts`
- Docs currently say:
  - `quality` is still required for some markdown tables/structured-content
    answer cases
  - smaller presets are fine when an external agent handles final answer
    generation

### Product stance

- benchmark the answer model in the role GNO actually uses it for
- compact footprint matters, not just benchmark bragging rights
- if Gemma wins but only at a materially larger RAM/latency cost, say so plainly
- if Gemma is good for a custom/remote preset but not for shipped slim defaults,
  that is still a valid outcome

### Why this is worth testing

- Gemma 4 E2B-it looks promising on paper for:
  - reasoning
  - code
  - long context
  - instruction following
- but GGUF size and runtime fit may make it a poor slim-lane default
- GNO needs product-shaped evidence, not only upstream benchmark numbers

### Deliverables

#### 1. Compact answer benchmark lane

- extend or add a benchmark harness for compact `gen` challengers
- evaluate grounded answers on GNO-shaped docs/tasks
- include:
  - citation quality
  - topical correctness/helpfulness
  - markdown/table/structured-doc handling
  - latency

#### 2. Gemma 4 E2B-it comparison

- compare `Gemma 4 E2B-it` against the current compact answer model
- use real GNO answer-generation flow, not a detached chat benchmark
- produce durable result artifacts

#### 3. Runtime-fit recommendation

- determine whether Gemma 4 E2B-it fits:
  - `slim-tuned`
  - `slim`
  - balanced/quality only
  - custom/remote-only recommendation
- explicitly account for:
  - GGUF size
  - load time
  - answer latency
  - whether it improves the table/structured-doc story enough to matter

#### 4. Outcome publication

- publish the recommendation clearly
- if Gemma is only a good optional/custom model, say that
- if Gemma is a real preset/default candidate, say what follow-up epic should
  own that implementation

### Risks / traps

- treating upstream general benchmarks as product evidence
- comparing chat quality outside the actual GNO answer path
- ignoring model size/RAM and calling a "compact" win that no longer fits the
  slim lane
- overfitting to a tiny answer fixture set
- hiding a latency regression behind slightly nicer prose

### Task breakdown

#### Task 1

`fn-69-evaluate-gemma-4-e2b-it-for-compact.1`

Extend the answer benchmark lane for compact local `gen` model challengers.

#### Task 2

`fn-69-evaluate-gemma-4-e2b-it-for-compact.2`

Run `Gemma 4 E2B-it` vs the current compact answer model through GNO's real
answer path.

#### Task 3

`fn-69-evaluate-gemma-4-e2b-it-for-compact.3`

Assess runtime fit and preset-lane viability for Gemma 4 E2B-it.

#### Task 4

`fn-69-evaluate-gemma-4-e2b-it-for-compact.4`

Publish the recommendation and any required follow-up path.

## Quick commands

- `bun run lint:check`
- `bun test`
- `bun run docs:verify`
- `bun run eval`
- `bun run eval:hybrid`

## Acceptance

- [ ] A compact-lane answer benchmark path exists for `gen` model challengers.
- [ ] `Gemma 4 E2B-it` is compared against the current compact shipped answer model through GNO's real answer-generation flow.
- [ ] The outcome covers quality plus practical runtime fit, not quality alone.
- [ ] The result says clearly whether Gemma is a no-go, optional/custom recommendation, or shipped-preset candidate.
- [ ] Docs/research pages identify the outcome without overstating it.

## References

- `src/config/types.ts`
- `evals/ask.eval.ts`
- `evals/fixtures/ask-cases.json`
- `evals/helpers/retrieval-candidate-benchmark.ts`
- `docs/CONFIGURATION.md`
- `docs/CLI.md`
- `research/embeddings/README.md`
- `website/features/benchmarks.md`
