---
title: Configuration
description: Configure collections, models, exclusions, remote inference endpoints, and runtime behavior for GNO's local knowledge workspace.
keywords: gno config, local search configuration, collections config, model presets, remote inference config
---

# Configuration

GNO configuration reference.

## Config File

Location varies by platform (see [File Locations](#file-locations) below).
Run `gno doctor` to see your resolved config path.

```yaml
version: "1.0"

# FTS tokenizer (set at init, cannot change)
ftsTokenizer: snowball english

# Collections
collections:
  - name: notes
    path: /Users/you/notes
    pattern: "**/*.md"
    include: []
    exclude:
      - .git
      - node_modules
    languageHint: en

  - name: work
    path: /Users/you/work/docs
    pattern: "**/*"
    exclude:
      - dist
      - build

# Contexts (semantic hints)
contexts:
  - scopeType: global
    scopeKey: /
    text: Personal knowledge base and project documentation

  - scopeType: collection
    scopeKey: notes:
    text: Personal notes and journal entries

  - scopeType: prefix
    scopeKey: gno://work/api
    text: API documentation and specifications

# Model configuration
models:
  activePreset: slim-tuned

# Optional terminal hyperlink target template for CLI search output
editorUriTemplate: "vscode://file/{path}:{line}:{col}"
```

## Collections

Collections define what gets indexed.

### Collection Fields

| Field          | Type   | Default   | Description                    |
| -------------- | ------ | --------- | ------------------------------ |
| `name`         | string | required  | Unique identifier (lowercase)  |
| `path`         | string | required  | Absolute path to directory     |
| `pattern`      | glob   | `**/*`    | File matching pattern          |
| `include`      | array  | see below | Extension allowlist            |
| `exclude`      | array  | see below | Patterns to skip               |
| `updateCmd`    | string | -         | Shell command before indexing  |
| `languageHint` | string | -         | BCP-47 language code           |
| `models`       | object | -         | Per-collection model overrides |

### Default Include Extensions

When `include` is empty (default), only supported document types are indexed:

- `.md` - Markdown
- `.txt` - Plain text
- `.pdf` - PDF documents
- `.docx` - Word documents
- `.pptx` - PowerPoint
- `.xlsx` - Excel spreadsheets

To override the default and index only specific supported types:

```yaml
include:
  - .md
  - .txt
```

> **Note:** `include` controls which files are scanned, but files must still have converter support. Specifying unsupported extensions will result in conversion errors.
>
> Files larger than the conversion size limit (100MB default) are skipped via filesystem `stat` before GNO reads file bytes.

Files without extensions (e.g., `Makefile`, `LICENSE`) and dotfiles (e.g., `.env`, `.gitignore`) are always excluded.

### Default Excludes

```yaml
exclude:
  - .git
  - node_modules
  - .venv
  - .idea
  - dist
  - build
  - __pycache__
  - .DS_Store
  - Thumbs.db
```

### Examples

**Markdown notes:**

```yaml
- name: notes
  path: /Users/you/notes
  pattern: "**/*.md"
```

**Code docs with language hint:**

```yaml
- name: german-docs
  path: /Users/you/docs/german
  pattern: "**/*.md"
  languageHint: de
```

**Mixed documentation folder:**

```yaml
- name: project-docs
  path: /Users/you/project/docs
  pattern: "**/*"
  include:
    - .md
    - .txt
  exclude:
    - node_modules
    - dist
    - drafts
```

> **Note:** Exclude patterns match path components (directory or file names), not globs. Use `dist` to exclude a `dist/` directory, not `*.js`.

**With update command:**

```yaml
- name: wiki
  path: /Users/you/wiki
  updateCmd: "git pull"
```

## Contexts

Contexts add semantic hints to improve search relevance.

### Scope Types

| Type         | Key Format              | Example                  |
| ------------ | ----------------------- | ------------------------ |
| `global`     | `/`                     | Applies to all documents |
| `collection` | `name:`                 | Applies to collection    |
| `prefix`     | `gno://collection/path` | Applies to path prefix   |

### Examples

```yaml
contexts:
  # Global context
  - scopeType: global
    scopeKey: /
    text: Technical knowledge base for software development

  # Collection context
  - scopeType: collection
    scopeKey: notes:
    text: Personal notes and daily journal entries

  # Path prefix context
  - scopeType: prefix
    scopeKey: gno://work/api
    text: REST API documentation and OpenAPI specs
```

## Models

Model configuration for embeddings and AI answers.

### Presets

| Preset       | Disk   | Best For                                                |
| ------------ | ------ | ------------------------------------------------------- |
| `slim-tuned` | ~1GB   | Current default, tuned retrieval in a compact footprint |
| `slim`       | ~1GB   | Fast, good quality                                      |
| `balanced`   | ~2GB   | Slightly larger model                                   |
| `quality`    | ~2.5GB | Best answers, complex content                           |

The dashboard bootstrap panel uses these preset footprints as the plain-language disk estimate for first-run setup.

> **Note**: When using GNO standalone with `--answer`, the **quality** preset is required for documents containing Markdown tables or other structured content. The smaller models in slim/balanced presets cannot reliably parse tabular data. When GNO is used via MCP, skill, or CLI by AI agents (Claude Code, Codex, etc.), the agent handles answer generation, so any preset works for retrieval.

### Per-collection model overrides

Collections can override model roles without replacing the global preset system.

Guides:

- [Per-Collection Models](guides/per-collection-models.md)
- [Code Embeddings](guides/code-embeddings.md)
- [Bring Your Own Models](guides/bring-your-own-models.md)

Example:

```yaml
collections:
  - name: work
    path: /Users/you/work/docs
    models:
      rerank: "file:/models/work-rerank.gguf"
      expand: "file:/models/work-expand.gguf"
```

Resolution order:

1. collection role override
2. active preset role
3. built-in default fallback

Notes:

- overrides are partial; you only set the roles you need
- global preset remains the base layer for everything else
- collection-scoped overrides are only meaningful when an operation resolves a specific collection
- the Web UI Collections page can now edit these overrides directly and shows effective per-role model resolution
- use collection overrides when one collection should intentionally diverge from the workspace default
- if a future benchmark shows a different code-specific embedding model wins on source-code retrieval, prefer using `models.embed` on code collections instead of replacing the global default for every collection

This still uses normal GNO model provisioning rules:

- it auto-downloads on first use by default
- it respects `GNO_NO_AUTO_DOWNLOAD` / offline policy the same way preset models do
- it is most useful when one collection should diverge from the global default or when migrating older configs explicitly

### Current general multilingual benchmark signal

On the public multilingual markdown benchmark lane, `Qwen3-Embedding-0.6B-GGUF`
currently beats `bge-m3` by a large margin on both vector-only and hybrid
retrieval.

Current product stance:

- `Qwen3-Embedding-0.6B-GGUF` is now the built-in preset default
- existing users who upgrade may need a fresh `gno embed` pass because their old vectors were created with `bge-m3`
- GNO now counts readiness/backlog against the active embed model, so the need to re-embed is visible immediately after a preset/default change
- if a future release changes the formatting profile for an active embedding model, re-embed is also required because the stored document vectors were produced differently

### Model Details

All presets use:

- **Qwen3-Embedding-0.6B** for embeddings (multilingual)
- **Qwen3-Reranker-0.6B** for reranking (scores best chunk per document)

| Preset   | Embed                   | Rerank                 | Gen           |
| -------- | ----------------------- | ---------------------- | ------------- |
| slim     | Qwen3-Embedding-0.6B-Q8 | Qwen3-Reranker-0.6B-Q8 | Qwen3-1.7B-Q4 |
| balanced | Qwen3-Embedding-0.6B-Q8 | Qwen3-Reranker-0.6B-Q8 | Qwen2.5-3B-Q4 |
| quality  | Qwen3-Embedding-0.6B-Q8 | Qwen3-Reranker-0.6B-Q8 | Qwen3-4B-Q4   |

The reranker's 32K context window allows scoring complete documents (tables, code, all sections) rather than truncated snippets.

## Terminal Hyperlinks

CLI retrieval commands (`gno search`, `gno vsearch`, `gno query`) can emit OSC 8 hyperlinks in terminal output when stdout is a TTY.

Configure the target URI template in YAML:

```yaml
editorUriTemplate: "vscode://file/{path}:{line}:{col}"
```

Or override it via environment:

```bash
export GNO_EDITOR_URI_TEMPLATE="vscode://file/{path}:{line}:{col}"
```

Precedence:

1. `GNO_EDITOR_URI_TEMPLATE`
2. `editorUriTemplate` in `index.yml`
3. default fallback `file://{path}`

Supported placeholders:

- `{path}` absolute filesystem path
- `{line}` best-effort line number from the result snippet, when available
- `{col}` best-effort column placeholder (`1` when line is available)

If the chosen template requires `{line}` but a result has no line hint, GNO falls back to plain text for that result instead of inventing `:1`.

### Custom Models

Need a more example-driven guide?

- [Bring Your Own Models](guides/bring-your-own-models.md)

```yaml
models:
  activePreset: custom
  presets:
    - id: custom
      name: My Custom Setup
      embed: hf:user/model/embed.gguf
      rerank: hf:user/model/rerank.gguf
      expand: hf:user/model/expand.gguf
      gen: hf:user/model/gen.gguf
```

Model URIs support:

- `hf:org/repo/file.gguf` - Hugging Face download
- `file:/path/to/model.gguf` - Local file
- `http://host:port/path#modelname` - Remote HTTP endpoint (OpenAI-compatible)

### Download Policy

Model provisioning follows one of three modes:

- default: auto-download allowed on first use
- offline: cached models only (`HF_HUB_OFFLINE=1` or `GNO_OFFLINE=1`)
- manual: no auto-download, but explicit `gno models pull` still works (`GNO_NO_AUTO_DOWNLOAD=1`)

The dashboard bootstrap panel reflects the active mode in plain language.

### Using A Fine-Tuned Local Model

Fine-tuned expansion models can be paired with a separate answer model via a custom preset:

```yaml
models:
  activePreset: slim-tuned
  presets:
    - id: slim-tuned
      name: GNO Slim Tuned
      embed: hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf
      rerank: hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf
      expand: hf:guiltylemon/gno-expansion-slim-retrieval-v1/gno-expansion-auto-entity-lock-default-mix-lr95-f16.gguf
      gen: hf:unsloth/Qwen3-1.7B-GGUF/Qwen3-1.7B-Q4_K_M.gguf
```

Notes:

- training backend may be Mac-only (for example MLX LoRA on Apple Silicon)
- exported artifacts remain portable if you fuse and convert to GGUF
- keep embed/rerank unchanged unless you have benchmark evidence for changing them too
- `expand` drives retrieval-time query expansion
- `gen` drives standalone answer generation (`gno ask --answer`, Web Ask)

See [Fine-Tuned Models](FINE-TUNED-MODELS.md) for the full workflow and troubleshooting notes.

### HTTP Endpoints

GNO supports remote model servers using OpenAI-compatible APIs. This allows offloading inference to a more powerful machine (e.g., a GPU server on your network).

```yaml
models:
  activePreset: remote
  presets:
    - id: remote
      name: Remote GPU Server
      embed: "http://192.168.1.100:8081/v1/embeddings#qwen3-embedding-0.6b"
      rerank: "http://192.168.1.100:8082/v1/completions#qwen3-reranker"
      expand: "http://192.168.1.100:8083/v1/chat/completions#gno-expand"
      gen: "http://192.168.1.100:8083/v1/chat/completions#qwen3-4b"
```

**URI Format:** `http://host:port/path#modelname`

| Component    | Description                                 |
| ------------ | ------------------------------------------- |
| `http(s)://` | Protocol (HTTP or HTTPS)                    |
| `host:port`  | Server address                              |
| `/path`      | API endpoint (e.g., `/v1/chat/completions`) |
| `#modelname` | Optional model identifier sent in requests  |

**Supported Endpoints:**

| Model Type | API Path               | OpenAI-Compatible API       |
| ---------- | ---------------------- | --------------------------- |
| `embed`    | `/v1/embeddings`       | Embeddings API              |
| `rerank`   | `/v1/completions`      | Completions API (text only) |
| `gen`      | `/v1/chat/completions` | Chat Completions API        |

**Example with llama.cpp server:**

```bash
# Start llama-server for generation
llama-server -m model.gguf --host 0.0.0.0 --port 8083

# Configure GNO to use it
# gen: "http://192.168.1.100:8083/v1/chat/completions#my-model"
```

**Benefits:**

- Offload inference to a GPU server
- Share models across multiple machines
- Use larger models than local hardware supports
- Keep local machine responsive during inference

### Timeouts

```yaml
models:
  loadTimeout: 60000 # Model load timeout (ms)
  inferenceTimeout: 30000 # Inference timeout (ms)
  expandContextSize: 2048 # Context window used for query expansion generation
  warmModelTtl: 300000 # Keep-warm duration (ms)
```

## FTS Tokenizer

Set at `gno init`, cannot be changed without rebuilding.

| Tokenizer          | Description                               |
| ------------------ | ----------------------------------------- |
| `snowball english` | Snowball stemmer (default, 20+ languages) |
| `unicode61`        | Unicode-aware, no stemming                |
| `porter`           | English-only stemming (legacy)            |
| `trigram`          | Substring matching                        |

The Snowball stemmer enables matching across word forms: "running" matches "run", "scored" matches "score", plurals match singulars.

```bash
# Initialize with unicode61 (no stemming)
gno init --tokenizer unicode61
```

## Environment Variables

Override paths (applied before platform defaults):

| Variable         | Description                 |
| ---------------- | --------------------------- |
| `GNO_CONFIG_DIR` | Override config directory   |
| `GNO_DATA_DIR`   | Override database directory |
| `GNO_CACHE_DIR`  | Override model cache        |

Runtime/model env vars:

| Variable               | Description                                                        |
| ---------------------- | ------------------------------------------------------------------ |
| `GNO_LLAMA_GPU`        | Local llama backend: `auto`, `metal`, `vulkan`, `cuda`, or CPU off |
| `NODE_LLAMA_CPP_GPU`   | Compatibility alias used when `GNO_LLAMA_GPU` is unset             |
| `GNO_NO_AUTO_DOWNLOAD` | Disable automatic model downloads; explicit `models pull` allowed  |

## File Locations

**Linux** (XDG):

| Path                                      | Purpose     |
| ----------------------------------------- | ----------- |
| `~/.config/gno/index.yml`                 | Config      |
| `~/.local/share/gno/index-default.sqlite` | Database    |
| `~/.cache/gno/models/`                    | Model cache |

**macOS**:

| Path                                                          | Purpose     |
| ------------------------------------------------------------- | ----------- |
| `~/Library/Application Support/gno/config/index.yml`          | Config      |
| `~/Library/Application Support/gno/data/index-default.sqlite` | Database    |
| `~/Library/Caches/gno/models/`                                | Model cache |

Run `gno doctor` to see resolved paths for your system.

## Editing Config

Edit directly or use CLI:

```bash
# Add collection via CLI
gno collection add ~/notes --name notes

# View config (Linux)
cat ~/.config/gno/index.yml

# View config (macOS)
cat ~/Library/Application\ Support/gno/config/index.yml
```

After manual edits, run `gno update` to apply changes.
