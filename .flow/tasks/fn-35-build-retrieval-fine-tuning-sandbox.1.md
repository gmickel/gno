# fn-35-build-retrieval-fine-tuning-sandbox.1 Design the retrieval fine-tuning sandbox

## Description

Design the tracked sandbox where `gno` can train and evaluate retrieval-specific models safely. The first version should focus on expansion-model work and define the data, eval, reward, and export path clearly enough that later agents can implement it without rediscovering the structure.

## Acceptance

- Define the sandbox directory layout.
- Define training-data schema and split strategy.
- Define reward and held-out eval contracts.
- Define export path to local runtime artifacts.
- Keep product code and sandbox code clearly separated.

## Notes For Implementer

- Start with expansion only.
- Do not broaden scope to reranker training until the benchmark epic says it is worth it.
- Prefer explicit reproducibility over cleverness.
- External references:
  - Andrej Karpathy `autoresearch`: <https://github.com/karpathy/autoresearch>
  - local reference training stack: `/Users/gordon/repos/qmd/finetune`

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
