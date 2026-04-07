# fn-69-evaluate-gemma-4-e2b-it-for-compact.2 Run Gemma 4 E2B-it vs the current compact answer model

## Description

Run the actual benchmark comparison.

Start here:

- task `.1` output
- `src/config/types.ts`
- `evals/ask.eval.ts`
- `research/embeddings/README.md`

Core comparison:

- challenger: `Gemma 4 E2B-it`
- incumbent: current compact shipped `gen` model

Requirements:

- use the real GNO answer-generation flow
- record answer quality and latency
- document the exact runtime artifact used:
  - GGUF URI
  - quant
  - local vs remote path if relevant
- keep the comparison fair:
  - same prompt path
  - same retrieval inputs
  - same answer token budget

Required outputs:

- baseline artifact for incumbent
- challenger artifact for Gemma 4 E2B-it
- human-readable summary

## Acceptance

- [ ] Gemma 4 E2B-it is benchmarked against the current compact answer model.
- [ ] Comparison uses the real GNO answer path.
- [ ] Results include quality and latency, not quality alone.
- [ ] The exact tested Gemma runtime artifact is recorded.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
