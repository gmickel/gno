---
layout: feature
title: Local LLM Answers
headline: Grounded Answers on Your Own Corpus
description: Get cited, grounded answers from your own documents using local language models or a local network GPU server. Keep the shipped presets, override them globally, or bring your own GGUF and HTTP-backed models when needed.
keywords: local llm, ai answers, grounded answers, private ai, bring your own model, custom gguf, remote model server
icon: local-llm
slug: local-llm
permalink: /features/local-llm/
og_image: /assets/images/og/og-local-llm.png
benefits:
  - 100% local processing
  - No API keys required
  - Cited answers from your docs
  - Multiple model presets (slim-tuned, slim, balanced, quality)
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

| Preset     | Speed  | Quality | Use Case                               |
| ---------- | ------ | ------- | -------------------------------------- |
| slim-tuned | Fast   | Good    | Default, tuned retrieval with slim gen |
| slim       | Fast   | Good    | Quick lookups                          |
| balanced   | Medium | Good    | Slightly larger model                  |
| quality    | Slower | Best    | Complex questions                      |

```bash
gno models use slim-tuned
gno models pull
```

### Remote GPU Server Support

Run on lightweight machines by offloading inference to a GPU server on your network:

```yaml
# ~/.config/gno/config/index.yml
models:
  activePreset: remote-gpu
  presets:
    - id: remote-gpu
      name: Remote GPU Server
      embed: "http://192.168.1.100:8081/v1/embeddings#qwen3-embedding-0.6b"
      rerank: "http://192.168.1.100:8082/v1/completions#reranker"
      gen: "http://192.168.1.100:8083/v1/chat/completions#qwen3-4b"
```

Works with any OpenAI-compatible server (llama-server, Ollama, LocalAI, vLLM). No CORS configuration needed—just point to your server.

[Configuration guide →](/docs/CONFIGURATION/#http-endpoints)

### No Cloud Required

Everything runs on your machine (or your network):

- Models downloaded once, run locally
- Optional: offload to GPU server on LAN
- No API keys or subscriptions
- Works completely offline
- Your data never leaves your network

## Learn More

- [Bring Your Own Models](/docs/guides/bring-your-own-models/)
- [Per-Collection Models](/docs/guides/per-collection-models/)
- [Configuration](/docs/CONFIGURATION/)
