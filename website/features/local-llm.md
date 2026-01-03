---
layout: feature
title: Local LLM Answers
headline: AI Answers Without the Cloud
description: Get cited, grounded answers from your own documents using local language models. GNO runs everything on your machine - no API keys, no data sharing, no subscriptions.
keywords: local llm, ai answers, local ai, private ai, grounded answers, cited responses
icon: local-llm
slug: local-llm
permalink: /features/local-llm/
benefits:
  - 100% local processing
  - No API keys required
  - Cited answers from your docs
  - Multiple model presets (slim, balanced, quality)
commands:
  - "gno ask 'your question' --answer"
  - "gno models use balanced"
  - "gno models pull"
---

## How It Works

GNO uses local language models via node-llama-cpp to generate answers grounded in your documents.

### Ask Questions, Get Cited Answers

```bash
gno ask "What was decided about the API design?" --answer
```

GNO will:

1. Search your documents using hybrid search
2. Retrieve relevant chunks
3. Generate an answer citing specific documents
4. Return the answer with source references

### Model Presets

Choose the right balance of speed and quality:

| Preset   | Speed  | Quality | Use Case               |
| -------- | ------ | ------- | ---------------------- |
| slim     | Fast   | Good    | Default, quick lookups |
| balanced | Medium | Good    | Slightly larger model  |
| quality  | Slower | Best    | Complex questions      |

```bash
gno models use slim
gno models pull
```

### No Cloud Required

Everything runs on your machine:

- Models downloaded once, run locally
- No API keys or subscriptions
- Works completely offline
- Your data never leaves your computer
