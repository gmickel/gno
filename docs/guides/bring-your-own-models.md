---
title: Bring Your Own Models
description: Use your own GGUFs, Hugging Face artifacts, or remote OpenAI-compatible model servers in GNO with custom presets or per-collection overrides.
keywords: gno bring your own model, custom gguf, custom model uri, remote model server, openai compatible embeddings, local gguf config
---

# Bring Your Own Models

GNO ships with opinionated built-in presets.

That is the default path.

But GNO is also easy to override.

You can:

- replace models globally with a custom preset
- override one role for one collection
- point roles at local files, Hugging Face artifacts, or remote HTTP endpoints

## Supported URI Formats

### Hugging Face

```yaml
embed: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
```

### Local File

```yaml
rerank: "file:/Users/you/models/qwen3-reranker-0.6b-q8_0.gguf"
```

### Remote HTTP Endpoint

```yaml
gen: "http://gpu-box:8083/v1/chat/completions#qwen3-4b"
embed: "http://gpu-box:8081/v1/embeddings#qwen3-embedding-0.6b"
```

HTTP endpoints use:

`http://host:port/path#modelname`

They are intended for OpenAI-compatible servers on your machine or network.

GNO's current HTTP expectations are:

- `embed` -> `/v1/embeddings`
- `gen` / `expand` -> `/v1/chat/completions`
- `rerank` -> `/v1/completions`

## Popular Software Examples

### Ollama

Good fit for:

- `embed`
- `gen`
- `expand`

Example:

```yaml
models:
  activePreset: ollama-remote
  presets:
    - id: ollama-remote
      name: Ollama on another machine
      embed: "http://windows-box:11434/v1/embeddings#qwen3-embedding"
      gen: "http://windows-box:11434/v1/chat/completions#qwen3:4b"
      expand: "http://windows-box:11434/v1/chat/completions#qwen3:4b"
```

Notes:

- Ollama documents OpenAI-compatible `chat/completions`, `completions`, and `embeddings`
- that makes it a good remote answer/embedding server for GNO
- rerank is less clean because GNO's rerank path is prompt-on-completions, not a dedicated rerank API

### LM Studio

Good fit for:

- `embed`
- `gen`
- `expand`

Example:

```yaml
models:
  activePreset: lmstudio-remote
  presets:
    - id: lmstudio-remote
      name: LM Studio server
      embed: "http://gpu-box:1234/v1/embeddings#text-embedding-model"
      gen: "http://gpu-box:1234/v1/chat/completions#qwen3-4b-instruct"
      expand: "http://gpu-box:1234/v1/chat/completions#qwen3-4b-instruct"
```

Notes:

- LM Studio exposes OpenAI-compatible `embeddings`, `chat/completions`, and `completions`
- usually the cleanest desktop-style remote server choice if you want a GUI

### vLLM

Good fit for:

- `embed`
- `gen`
- `expand`

Example:

```yaml
models:
  activePreset: vllm-remote
  presets:
    - id: vllm-remote
      name: vLLM server
      embed: "http://gpu-box:8000/v1/embeddings#Qwen/Qwen3-Embedding-0.6B"
      gen: "http://gpu-box:8000/v1/chat/completions#Qwen/Qwen3-4B-Instruct"
      expand: "http://gpu-box:8000/v1/chat/completions#Qwen/Qwen3-4B-Instruct"
```

Notes:

- vLLM is strong for serving larger models on a real GPU box
- vLLM also has dedicated rerank APIs, but GNO does not speak those directly yet
- so today, vLLM is the cleanest fit for `embed` and `gen`-style roles

### llama.cpp `llama-server`

Good fit for:

- `gen`

Possible fit for:

- `embed`

Notes:

- `llama-server` is OpenAI-compatible for chat completions
- its embedding/reranking endpoints are documented separately as `/embedding` and `/reranking`
- GNO currently expects `/v1/embeddings` and `/v1/completions`
- so `llama-server` may need a small proxy/translation layer for full multi-role use

## Can I Run This On Another Machine?

Yes.

Common setup:

- run GNO on your laptop
- run Ollama / LM Studio / vLLM on a stronger box
- point a custom preset or collection override at that machine over your LAN

Example:

```yaml
models:
  activePreset: remote-gpu
  presets:
    - id: remote-gpu
      name: Windows GPU Box
      embed: "http://192.168.1.100:11434/v1/embeddings#qwen3-embedding"
      gen: "http://192.168.1.100:11434/v1/chat/completions#qwen3:4b"
      expand: "http://192.168.1.100:11434/v1/chat/completions#qwen3:4b"
```

That works fine regardless of whether the remote machine is Windows, Linux, or macOS, as long as the endpoint is reachable from the machine running GNO.

## Global Override With A Custom Preset

```yaml
models:
  activePreset: custom
  presets:
    - id: custom
      name: My Custom Setup
      embed: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
      rerank: "file:/Users/you/models/qwen3-reranker-0.6b-q8_0.gguf"
      expand: "http://gpu-box:8083/v1/chat/completions#gno-expand"
      gen: "http://gpu-box:8083/v1/chat/completions#qwen3-4b"
```

That replaces the global model stack for the active preset.

## Per-Collection Override

If only one collection should diverge:

```yaml
collections:
  - name: code
    path: /Users/you/work/project/src
    models:
      embed: "file:/Users/you/models/code-embed.gguf"
```

That leaves the rest of the workspace on the active preset.

## Auto-Download And Offline Behavior

For `hf:` URIs:

- default: auto-download on first use
- `GNO_NO_AUTO_DOWNLOAD=1`: do not auto-download
- `GNO_OFFLINE=1` or `HF_HUB_OFFLINE=1`: cached models only

Explicit download still works:

```bash
gno models pull --embed
gno models pull --rerank
gno models pull --gen
```

For `file:` URIs:

- GNO expects the file to already exist

For `http:` URIs:

- GNO does not download anything
- it calls the configured server directly

## Switching Safely

If you change the embed model after a collection is already indexed:

```bash
gno embed
```

Or one collection at a time:

```bash
gno embed code
```

Old vectors are not deleted automatically.

Optional cleanup after the new embeddings exist:

```bash
gno collection clear-embeddings code
```

## Opinionated Defaults, Easy Escape Hatches

The intended product story is:

- built-in presets for fast first-run success
- custom presets for global override
- per-collection overrides for surgical tuning

See also:

- [Per-Collection Models](per-collection-models.md)
- [Code Embeddings](code-embeddings.md)
- [Configuration](../CONFIGURATION.md)
