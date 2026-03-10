# fn-37-productionize-fine-tuned-retrieval Productionize fine-tuned retrieval models

## Overview

Turn the new fine-tuning sandbox into a repeatable, documented, distributable model pipeline. The immediate goal is to move from "one good local run" to a trustworthy promotion flow with automatic run selection, benchmark comparison, model cards, install/use instructions, and support for multiple candidate bases when it is worth trying them.

## Scope

- productionize the current `Qwen3-1.7B` fine-tune path first
- automate run promotion artifacts:
  - best checkpoint selection
  - fused/dequantized export
  - GGUF export
  - benchmark summary
  - model card / release metadata
- document local use of exported models in `gno`
- create a candidate-sweep path for other bases (`Qwen2.5-3B`, `Qwen3.5-0.8B`, `Qwen3.5-4B`) after the current winner is stable
- tighten the autonomous loop so it can optimize the sandbox using the trusted metric

Out of scope for this epic:

- changing shipped default presets immediately
- reranker training
- cloud/distributed training infrastructure

## Approach

1. lock the current winning `Qwen3-1.7B` path into an explicit promotion pipeline
2. make outputs legible and distributable
3. only then broaden to alternate base-model sweeps
4. let autonomy mutate sandbox-only configs/prompts/reward weights after the promotion metric is fixed

Key principle:

- training backend may be Mac-specific
- promoted artifacts must be portable (`safetensors` + `GGUF`)

## Quick commands

<!-- Required: at least one smoke command for the repo -->

- `bun run research:finetune:select-best mlx-run1`
- `bun run research:finetune:fuse-best mlx-run1`
- `bun run research:finetune:export-env`
- `bun run research:finetune:export-gguf mlx-run1`
- `bun run research:finetune:smoke-gno-export mlx-run1`
- `bun run research:finetune:benchmark-export mlx-run1`
- `bun run lint:check`
- `bun test`

## Acceptance

- [ ] Promotion flow can take a completed run and emit a benchmarked portable artifact with no manual checkpoint picking
- [ ] Fine-tune docs explain training, selection, export, install, and benchmarking clearly
- [ ] User-facing docs explain how to use a custom fine-tuned model in `gno`
- [ ] At least one follow-up candidate sweep path is defined for other bases
- [ ] Autonomous loop has a concrete next mutation target tied to the promotion metric

## References

- `evals/fixtures/retrieval-candidate-benchmark/recommendation.md`
- `research/finetune/README.md`
- `research/finetune/autonomous/README.md`
- local upstream reference training stack already cloned under `~/repos`
