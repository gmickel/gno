# Fine-Tuned Models

Guide for using fine-tuned local generation models with `gno`.

## What Is Portable

The training backend can be machine-specific.

Example:

- training on Apple Silicon via MLX LoRA

What must be portable is the exported artifact:

- fused weights
- GGUF runtime file
- benchmark summary
- install snippet / model card

## Recommended Workflow

1. train a run in `research/finetune/`
2. promote the run:

```bash
bun run research:finetune:promote mlx-run1
```

3. inspect the generated bundle:

- `research/finetune/outputs/<run>/promotion/promotion-summary.json`
- `research/finetune/outputs/<run>/promotion/MODEL_CARD.md`
- `research/finetune/outputs/<run>/promotion/install-snippet.yaml`

4. point a custom preset at the exported GGUF
5. benchmark before replacing any defaults

## Install In GNO

Example custom preset:

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

Then:

```bash
gno models use tuned
gno query "ECONNREFUSED 127.0.0.1:5432" --thorough
```

## When To Keep It Custom

Keep the fine-tuned model in a custom preset when:

- it only has one strong benchmark run
- ask-style retrieval is flat or noisy
- you have not repeated the benchmark on fresh runs

Only consider changing defaults after repeated measured wins.

## Troubleshooting

### `mlx_lm fuse --export-gguf` fails for `qwen3`

Current workaround:

1. `bun run research:finetune:fuse-best <run>`
2. `bun run research:finetune:export-env`
3. `bun run research:finetune:export-gguf <run>`

This works because the export path uses:

- MLX fuse with `--dequantize`
- `llama.cpp` conversion on the dequantized fused model

### Exported GGUF loads but does not follow the JSON contract

This usually means the model is not trained enough yet, not that export failed.

Check:

- selected checkpoint vs final checkpoint
- schema success rate in benchmark summary
- raw output from `bun run research:finetune:smoke-gno-export <run>`

### Fine-tuned model is better on loss but not on retrieval

Do not promote on loss alone.

Use:

```bash
bun run research:finetune:benchmark-export <run>
```

Promotion should follow retrieval metrics, not training loss.

### Mac-only training concern

Training can stay Mac-only.

The exported GGUF is the portable artifact and can be used anywhere `llama.cpp` /
`node-llama-cpp` can load it.
