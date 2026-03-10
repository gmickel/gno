---
layout: feature
title: Fine-Tuned Models
headline: Train Local, Ship Portable
description: Fine-tune retrieval models locally, export them to portable GGUF artifacts, benchmark them against the shipped baseline, and use them in GNO with custom presets.
keywords: fine-tuned models, gguf, mlx lora, local finetuning, retrieval model, qwen3
icon: brain
slug: fine-tuned-models
permalink: /features/fine-tuned-models/
benefits:
  - Local MLX LoRA training on Apple Silicon
  - Automatic checkpoint selection
  - Portable GGUF export
  - Real benchmark-based promotion
  - Custom preset install snippets
commands:
  - "bun run research:finetune:promote mlx-run1"
  - "gno models use tuned"
  - "gno query 'ECONNREFUSED 127.0.0.1:5432' --thorough"
---

## Why This Matters

Fine-tuning is only useful if the resulting model can be exported, benchmarked, and installed cleanly. GNO's fine-tuning workflow is built around that full loop:

1. train locally
2. select the best checkpoint
3. export a portable GGUF
4. benchmark the exported artifact
5. install it in GNO with a custom preset

## Current Promoted Model

The current promoted slim retrieval model is `slim-retrieval-v1`, produced from `auto-entity-lock-default-mix-lr95`.

- repeated benchmark median `nDCG@10`: `0.925`
- repeated benchmark median schema success: `1.0`
- repeated benchmark median p95: `4775.99ms`

## Local Training, Portable Artifact

The current local training backend is MLX LoRA on Apple Silicon. That is a training implementation detail, not a deployment requirement.

The deployable artifact is a GGUF file that GNO can load via `file:` URI.

```yaml
models:
  activePreset: tuned
  presets:
    - id: tuned
      name: Fine-tuned Expansion
      embed: hf:gpustack/bge-m3-GGUF/bge-m3-Q4_K_M.gguf
      rerank: hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf
      gen: file:/absolute/path/to/gno-expansion-run-f16.gguf
```

## Promotion Flow

One command drives the full promotion path:

```bash
bun run research:finetune:promote mlx-run1
```

That command:

- picks the best checkpoint from the training log
- fuses and dequantizes the adapter
- exports GGUF
- smokes the model through GNO
- benchmarks the exported artifact
- emits a promotion summary and model card

## Why Benchmark The Exported Model

Training loss is not enough.

The model that looks best during training can still perform worse after export on real retrieval tasks. GNO promotes based on exported-model benchmark results, not loss alone.

## Learn More

- [Fine-Tuned Models Guide](/docs/FINE-TUNED-MODELS/)
- [Configuration](/docs/CONFIGURATION/)
- [CLI Reference](/docs/CLI/)
