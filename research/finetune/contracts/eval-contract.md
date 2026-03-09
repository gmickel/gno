# Eval Contract

Sandbox evals measure `gno` retrieval outcomes, not generic chat quality.

## Required Gates

Every candidate run must report:

- expansion schema success rate
- clean JSON rate
- entity preservation
- negation/exclusion preservation
- retrieval metrics on:
  - baseline cases
  - adversarial cases
  - multilingual cases
  - ask-style cases
- p50/p95 latency
- RSS/load deltas

## Split Usage

- `train`: prompt/reward prototyping allowed
- `validation`: model-selection feedback allowed
- `heldout`: promotion only

Do not tune prompts, reward weights, or training hyperparameters against `heldout`.

## Promotion Minimum

A candidate is promotable only if it:

- beats current shipped expansion base on heldout retrieval quality
- does not regress entity/negation preservation
- stays practical for local `gno` usage on developer hardware

Current baseline command:

```bash
bun run eval:retrieval-candidates:write
```

Current baseline artifact:

- `evals/fixtures/retrieval-candidate-benchmark/latest.json`
