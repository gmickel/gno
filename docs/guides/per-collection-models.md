---
title: Per-Collection Models
description: Override embedding, rerank, expansion, and answer models for one collection without replacing the active global preset.
keywords: gno per collection model, collection model override, models.embed, models.rerank, custom collection models, collection-level model settings
---

# Per-Collection Models

GNO has two layers of model configuration:

1. global presets
2. optional collection overrides

This lets you keep one opinionated workspace default while tuning a few collections independently.

## Resolution Order

For each role:

1. collection override
2. active preset
3. built-in default fallback

Supported per-collection roles:

- `embed`
- `rerank`
- `expand`
- `gen`

Overrides are partial. You only set the roles you want to change.

## Example

```yaml
collections:
  - name: work
    path: /Users/you/work/docs
    models:
      rerank: "file:/models/work-reranker.gguf"
      expand: "http://gpu-box:8083/v1/chat/completions#gno-expand"

  - name: code
    path: /Users/you/work/project/src
    models:
      embed: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
```

Everything not overridden still inherits from the active preset.

## Best Use Cases

Use per-collection models when:

- one code collection should use a different embed model
- one collection needs a larger reranker
- one high-value collection needs a custom answer model
- you want to experiment without replacing the workspace default

Do not use per-collection overrides when the whole workspace should change. In that case, make or switch a preset instead.

## Web UI

Collections page:

1. open a collection card menu
2. click **Model settings**
3. edit one or more roles
4. save

The dialog shows:

- the current effective model per role
- whether it is inherited or overridden
- reset-to-inherit actions

## CLI

At collection creation time:

```bash
gno collection add ~/work/project/src \
  --name code \
  --embed-model "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
```

After changing an embed model on an existing populated collection:

```bash
gno embed code
```

Optional stale cleanup:

```bash
gno collection clear-embeddings code
```

## API

Update collection overrides:

```bash
curl -X PATCH http://localhost:3000/api/collections/code \
  -H "Content-Type: application/json" \
  -d '{
    "models": {
      "embed": "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
      "rerank": null
    }
  }'
```

`null` clears an override and returns that role to preset inheritance.

## Current Limit

GNO does not yet support:

- per-path model overrides
- per-file-type model overrides
- multiple embed models inside one collection

If you need different model behavior for code and markdown, split them into separate collections.

See also:

- [Code Embeddings](code-embeddings.md)
- [Bring Your Own Models](bring-your-own-models.md)
- [Configuration](../CONFIGURATION.md)
