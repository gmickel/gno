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

Recent compatibility work also made the current Qwen path more intentional:

- model-specific query/doc formatting is now explicit
- indexing can recover item-by-item if batch embedding fails
- batched vector-query embedding keeps the current Qwen path efficient

## When To Override

Use a collection-level embed override when:

- you want to test a code-specialist challenger
- one collection should diverge from the global default without changing the rest of the workspace

Do not use a code-specific override for a mixed docs + notes + code collection unless you have benchmark evidence that it helps that mixed corpus.

## Recommended Pattern

Today, the recommended pattern is simpler:

- keep the built-in default as-is
- do **not** add a collection override just to get Qwen on code collections, because Qwen is already the global default embed model
- only add a collection override when one collection should intentionally diverge from that default

If your code lives next to markdown docs, prefer splitting them into separate collections:

```yaml
collections:
  - name: project-code
    path: /Users/you/work/project/src
    pattern: "**/*.{ts,tsx,js,jsx,go,rs,py,swift,c}"
    models:
  - name: project-docs
    path: /Users/you/work/project/docs
    pattern: "**/*.md"
```

## CLI

New collection with an intentional override:

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

For code-shaped collections, the dialog can surface benchmark-backed guidance. Use it when you are intentionally diverging from the global default, not just to re-apply the current default.

## Why Qwen Is The Current Default

GNO benchmarked `Qwen3-Embedding-0.6B-GGUF` against `bge-m3` on:

- fixed code fixtures
- real GNO code
- pinned public OSS code slices
- multilingual markdown docs

Current result:

- Qwen won strongly enough to become the built-in default
- collection overrides still matter only when one collection should diverge from that default
- recent smoke runs on the current Qwen path remain healthy after the compatibility/profile work landed

See:

- [Benchmarks](/features/benchmarks/)
- [Bring Your Own Models](bring-your-own-models.md)
- [Per-Collection Models](per-collection-models.md)
