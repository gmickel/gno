---
layout: feature
title: Fine-Tuned Models
headline: Train Local, Ship Portable
description: Fine-tune retrieval models locally, publish portable GGUF artifacts, benchmark them against the shipped baseline, and use them in GNO with HF-backed custom presets.
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
  - "gno models use slim-tuned"
  - "gno models pull --gen"
  - "gno query 'ECONNREFUSED 127.0.0.1:5432' --thorough"
---

## Why This Matters

Fine-tuning is only useful if the resulting model can be exported, benchmarked, and installed cleanly. GNO's fine-tuning workflow is built around that full loop:

1. train locally
2. select the best checkpoint
3. export a portable GGUF
4. benchmark the exported artifact
5. publish the promoted artifact
6. install it in GNO with an `hf:` preset

## Current Promoted Model

The current promoted slim retrieval model is `slim-retrieval-v1`, produced from `auto-entity-lock-default-mix-lr95`.

- repeated benchmark median `nDCG@10`: `0.925`
- repeated benchmark median schema success: `1.0`
- repeated benchmark median p95: `4775.99ms`
- HF repo: [guiltylemon/gno-expansion-slim-retrieval-v1](https://huggingface.co/guiltylemon/gno-expansion-slim-retrieval-v1)

## Local Training, Portable Artifact

The current local training backend is MLX LoRA on Apple Silicon. That is a training implementation detail, not a deployment requirement.

The deployable artifact is a GGUF file that GNO can load via `hf:` or `file:` URI.

```yaml
models:
  activePreset: slim-tuned
  presets:
    - id: slim-tuned
      name: GNO Slim Retrieval v1
      embed: hf:gpustack/bge-m3-GGUF/bge-m3-Q4_K_M.gguf
      rerank: hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf
      gen: hf:guiltylemon/gno-expansion-slim-retrieval-v1/gno-expansion-auto-entity-lock-default-mix-lr95-f16.gguf
```

Use `file:` only for private or unpublished models.

## Promotion Flow

One command drives the full promotion path:

```bash
bun run research:finetune:finalize slim-retrieval-v1 auto-entity-lock-default-mix-lr95
```

That command:

- materializes the canonical release bundle
- writes a public model card and install snippet
- stages the HF upload bundle

For the full training-to-promotion flow:

```bash
bun run research:finetune:promote <run>
```

## Why Benchmark The Exported Model

Training loss is not enough.

The model that looks best during training can still perform worse after export on real retrieval tasks. GNO promotes based on exported-model benchmark results, not loss alone.

## Learn More

- [Fine-Tuned Models Guide](/docs/FINE-TUNED-MODELS/)
- [Configuration](/docs/CONFIGURATION/)
- [CLI Reference](/docs/CLI/)
