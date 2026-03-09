# Reward Contract

Reward must optimize for retrieval-serving structure, not prose quality.

## Reward Dimensions

Minimum components:

- format correctness
  - valid JSON
  - required keys present
  - bounded list sizes
- preservation
  - quoted phrase preservation
  - entity retention
  - negation/exclusion retention
- usefulness
  - lexical queries short + BM25-friendly
  - vector queries semantically distinct
  - HyDE optional but grounded and non-drifting
- diversity without drift
- retrieval lift on validation cases
- latency cost penalty

## Hard Failures

Return minimum reward for:

- invalid JSON
- chat-template leakage
- `<think>` leakage
- dropped negations
- dropped critical entities in all variants

## Implementation Rule

One reward implementation per sandbox version.

If reward logic changes:

- bump the reward version
- record the change in the run notes
- re-run validation before comparing against prior results
