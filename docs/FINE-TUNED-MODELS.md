# Fine-Tuned Models

Guide for using fine-tuned local generation models with `gno`.

## Current Promoted Retrieval Model

Current promoted slim retrieval model:

- release id: `slim-retrieval-v1`
- canonical run: `auto-entity-lock-default-mix-lr95`
- repeated benchmark median:
  - `nDCG@10 0.925`
  - ask `Recall@5 0.875`
  - schema success `1.0`
  - p95 `4775.99ms`

Canonical bundle:

- [HF model repo](https://huggingface.co/guiltylemon/gno-expansion-slim-retrieval-v1)
- [release-manifest.json](https://github.com/gmickel/gno/blob/main/research/finetune/promoted/slim-retrieval-v1/release-manifest.json)
- [MODEL_CARD.md](https://github.com/gmickel/gno/blob/main/research/finetune/promoted/slim-retrieval-v1/MODEL_CARD.md)
- [install-snippet.yaml](https://github.com/gmickel/gno/blob/main/research/finetune/promoted/slim-retrieval-v1/install-snippet.yaml)

This model passed the promotion gate and is the one to use for final packaging and publishing.

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

Public/shared model:

1. use the published HF model directly
2. ship it as the built-in `slim-tuned` default
3. benchmark before replacing the other built-in presets too

Private/internal model:

1. train a run in `research/finetune/`
2. promote the run:

```bash
bun run research:finetune:promote <run>
```

3. if it is private or paid, keep the resulting GGUF on disk and use `file:`
4. if it is public, publish the GGUF and model card to HF and switch to `hf:`
5. benchmark before replacing any defaults

## Install In GNO

Built-in default preset:

```yaml
models:
  activePreset: slim-tuned
  presets:
    - id: slim-tuned
      name: GNO Slim Tuned
      embed: hf:gpustack/bge-m3-GGUF/bge-m3-Q4_K_M.gguf
      rerank: hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf
      expand: hf:guiltylemon/gno-expansion-slim-retrieval-v1/gno-expansion-auto-entity-lock-default-mix-lr95-f16.gguf
      gen: hf:unsloth/Qwen3-1.7B-GGUF/Qwen3-1.7B-Q4_K_M.gguf
```

Already selected by default on fresh installs. To switch back manually later:

```bash
gno models use slim-tuned
gno query "ECONNREFUSED 127.0.0.1:5432" --thorough
```

Once selected, the dashboard bootstrap section reports whether the tuned preset is fully cached, partially cached, or still downloading.

For a private expansion model that is not published to HF yet, replace `expand:` with:

```yaml
gen: file:/absolute/path/to/your-private-model.gguf
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
