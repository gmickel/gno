---
library_name: llama.cpp
base_model: mlx-community/Qwen3-1.7B-4bit
tags:
  - gguf
  - gno
  - retrieval
  - query-expansion
  - qwen3
---

# GNO Slim Retrieval v1

Fine-tuned query expansion model for GNO hybrid retrieval.

Canonical promoted run: `auto-entity-lock-default-mix-lr95`
HF repo: `guiltylemon/gno-expansion-slim-retrieval-v1`
GGUF file: `gno-expansion-auto-entity-lock-default-mix-lr95-f16.gguf`

## What This Model Is For

- retrieval-centric query expansion
- entity / negation preservation
- multilingual retrieval support
- JSON-structured expansion output for GNO

It is not optimized for standalone answer synthesis.

## Promotion Decision

- confirmed incumbent artifact: [confirmed-incumbent.json](https://github.com/gmickel/gno/blob/main/research/finetune/autonomous/runs/confirmed-incumbent.json)
- promotion target gate: [promotion-target-check.json](https://github.com/gmickel/gno/blob/main/research/finetune/autonomous/runs/promotion-target-check-auto-entity-lock-default-mix-lr95.json)
- result: passed

## Repeated Benchmark

- promoted median nDCG@10: 0.9250
- previous incumbent median nDCG@10: 0.9190
- promoted median ask Recall@5: 0.8750
- promoted median schema success: 100.0%
- promoted median p95: 4775.99ms

## Shipped Slim Baseline Delta

- shipped slim nDCG@10: 0.8983
- promoted median delta vs shipped slim: 0.0267

## Install In GNO

```yaml
models:
  activePreset: slim-tuned
  presets:
    - id: slim-tuned
      name: GNO Slim Retrieval v1
      embed: "hf:gpustack/bge-m3-GGUF/bge-m3-Q4_K_M.gguf"
      rerank: "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf"
      gen: "hf:guiltylemon/gno-expansion-slim-retrieval-v1/gno-expansion-auto-entity-lock-default-mix-lr95-f16.gguf"
```

## Published Artifact

- HF model URI: `hf:guiltylemon/gno-expansion-slim-retrieval-v1/gno-expansion-auto-entity-lock-default-mix-lr95-f16.gguf`
- best checkpoint: `0000500_adapters.safetensors`

## Source Artifacts

- benchmark summary: `benchmark-summary.json`
- repeat benchmark: `repeat-benchmark.json`
- promotion summary: `promotion-summary.json`
- release manifest: `release-manifest.json`
