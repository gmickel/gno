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

Implemented a tracked research/finetune sandbox for expansion-model work. Added schemas, reward/eval/export contracts, baseline config, bootstrap/validation scripts, generated promotion cases, split manifests, and baseline run notes tied to the fn-34 recommendation.

Extended the sandbox into a real local training path:

- qmd example import into the sandbox schema
- MLX chat-dataset builder for local LoRA runs on Mac
- MLX LoRA train/fuse wrappers
- separate export env for portable GGUF conversion
- `gno` smoke script for exported GGUF artifacts

Key decisions:

- expansion only
- primary base: Qwen3-1.7B-Q4_K_M
- heldout split reserved for ask, multilingual, and high-risk entity/negation cases
- export target is local GGUF loaded via file: URI in gno
- local proofs completed:
  - qmd import: 2050 examples
  - MLX dataset build: 1984 examples (1785 train / 199 valid)
  - 1-step MLX LoRA smoke run
  - dequantized fused model exported to F16 GGUF
  - exported GGUF loads through `gno`

## Evidence

- Commits:
- Tests: bun run research:finetune:bootstrap, bun run research:finetune:validate, bun run research:finetune:qmd-import, bun run research:finetune:mlx:build-dataset, python3 -m mlx_lm lora --train --model mlx-community/Qwen3-1.7B-4bit --data research/finetune/data/mlx --fine-tune-type lora --optimizer adamw --batch-size 1 --iters 1 --val-batches 1 --learning-rate 1e-5 --steps-per-report 1 --steps-per-eval 1 --grad-accumulation-steps 1 --adapter-path research/finetune/outputs/mlx-smoke --save-every 1 --max-seq-length 1024 --num-layers 4 --seed 42, python3 -m mlx_lm fuse --model mlx-community/Qwen3-1.7B-4bit --adapter-path research/finetune/outputs/mlx-smoke --save-path research/finetune/outputs/mlx-smoke-fused-deq --dequantize, research/finetune/.venv-export/bin/python /tmp/llama.cpp/convert_hf_to_gguf.py research/finetune/outputs/mlx-smoke-fused-deq --outfile research/finetune/outputs/mlx-smoke-fused-deq/gno-expansion-qwen3-1.7b-smoke-f16.gguf --outtype f16, bun run research:finetune:smoke-gno-export, bun test test/research/finetune-sandbox.test.ts test/research/mlx-training.test.ts, bun run lint:check
- PRs:
