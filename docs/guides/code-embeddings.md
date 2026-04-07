---
title: Code Embeddings
description: How to choose, override, benchmark, and safely switch embedding models for code collections in GNO.
keywords: gno code embeddings, code search embeddings, qwen code embeddings, per collection embed model, code collection model override
---

# Code Embeddings

GNO now ships with an opinionated default embed model:

- `Qwen3-Embedding-0.6B-GGUF`

That default is already strong on:

- mixed markdown + prose collections
- multilingual notes and docs
- code-heavy collections

So for many users, the right answer is: do nothing.

## When To Override

Use a collection-level embed override when:

- one collection is mostly source code
- you want to test a code-specialist challenger
- one collection should diverge from the global default without changing the rest of the workspace

Do not use a code-specific override for a mixed docs + notes + code collection unless you have benchmark evidence that it helps that mixed corpus.

## Recommended Pattern

Keep the global preset sane.

Override only the code collection:

```yaml
collections:
  - name: gno-code
    path: /Users/you/work/gno/src
    pattern: "**/*.{ts,tsx,js,jsx,go,rs,py,swift,c}"
    models:
      embed: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
```

If your code lives next to markdown docs, prefer splitting them into separate collections:

```yaml
collections:
  - name: project-code
    path: /Users/you/work/project/src
    pattern: "**/*.{ts,tsx,js,jsx,go,rs,py,swift,c}"
    models:
      embed: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"

  - name: project-docs
    path: /Users/you/work/project/docs
    pattern: "**/*.md"
```

## CLI

New collection:

```bash
gno collection add ~/work/gno/src \
  --name gno-code \
  --embed-model "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
```

Re-embed after changing the collection embed model:

```bash
gno embed gno-code
```

Optional stale cleanup after the new embeddings exist:

```bash
gno collection clear-embeddings gno-code
```

## Web UI

Collections page:

1. open the collection menu
2. choose **Model settings**
3. set `embed` for that collection
4. save
5. run the suggested re-embed flow

For code-shaped collections, the dialog can surface a benchmark-backed code recommendation directly.

## Why Qwen Is The Current Default

GNO benchmarked `Qwen3-Embedding-0.6B-GGUF` against `bge-m3` on:

- fixed code fixtures
- real GNO code
- pinned public OSS code slices
- multilingual markdown docs

Current result:

- Qwen won strongly enough to become the built-in default
- collection overrides still matter when one collection should diverge from that default

See:

- [Benchmarks](/features/benchmarks/)
- [Bring Your Own Models](bring-your-own-models.md)
- [Per-Collection Models](per-collection-models.md)
