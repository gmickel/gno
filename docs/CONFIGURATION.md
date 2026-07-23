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

# Optional schema-lite content type rules
contentTypes:
  - id: person
    prefixes:
      - people/
      - contacts/
    preset: person
    graphHints:
      - mentions
      - works_at
    searchBoost: 1.15
  - id: meeting
    prefixes:
      - meetings/
    preset: meeting
    temporal: true

# Optional terminal hyperlink target template for CLI search output
editorUriTemplate: "vscode://file/{path}:{line}:{col}"

# Optional resident Streamable HTTP MCP gateway
gateway:
  host: 127.0.0.1
  enableWrite: false
```

## Resident HTTP MCP Gateway

`gno serve` and `gno daemon` expose `/mcp`. The default configuration binds
literal `127.0.0.1`, derives exact `127.0.0.1:<port>` and `localhost:<port>`
Host/Origin allowlists, and leaves mutation tools disabled.

```yaml
gateway:
  host: 0.0.0.0
  tokenFile: ~/.config/gno/mcp-token
  allowedHosts:
    - workstation.local:3000
  allowedOrigins:
    - https://trusted-client.example
  enableWrite: false
  limits:
    maxBodyBytes: 1048576
    maxRequestsPerMinute: 120
    maxConcurrentRequests: 64
    maxQueuedRequests: 16
    maxSessions: 32
    sessionIdleTimeoutMs: 300000
```

Wildcard or non-loopback binding requires `tokenFile`, `allowedHosts`, and
`allowedOrigins`; every allowlist value is exact and wildcards are rejected.
`gno serve` remains loopback-only because its Web and REST surfaces share the
listener; use `gno daemon` for authenticated non-loopback MCP access.
An explicitly configured missing token file is generated with a random 256-bit
token and mode `0600` on POSIX. Authentication and mutation authorization are
separate: `enableWrite` must be true before HTTP write tools are registered or
dispatched. CLI gateway flags override config values for one invocation.

Upgrading from a stdio-only setup requires no client-config migration:
`gno mcp` remains supported. Start `gno serve` or `gno daemon` only for clients
that can use the resident URL `http://127.0.0.1:3000/mcp`. Stop any resident
owner for the same data directory before switching between serve and daemon.

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

Contexts are operational retrieval guidance, not labels stored and forgotten.
Structured CLI, REST, MCP, and SDK search results include an optional `context`
field whenever a scope matches. GNO composes matching text deterministically:
global first, collection second, then path prefixes from broadest to most
specific. Duplicate text is included once, and prefix matching respects path
segments (`projects/a` does not match `projects/ab`).

Context does not affect matching or ranking. Grounded Ask uses it as trusted
user configuration, delimited separately from retrieved document content. A
result with no matching context keeps the historical shape and omits the field.

## Models

Model configuration for embeddings and AI answers.

### Presets

| Preset       | Best For                                     |
| ------------ | -------------------------------------------- |
| `slim-tuned` | Current default; tuned query expansion       |
| `slim`       | Untuned slim query expansion                 |
| `balanced`   | Qwen2.5 3B expansion and answers             |
| `quality`    | Qwen3 4B expansion and standalone AI answers |

Actual download and cache use depends on the selected artifacts, quantization,
and files already present. Treat UI size labels as orientation, not measured
clean-install footprints.

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

<!-- public-truth:general-embedding-benchmark -->

The immutable April 2026 FastAPI-docs run used 15 documents in five corpus
languages (`en`, `de`, `fr`, `es`, `zh`) and 13 queries:

- [bge-m3 incumbent](../evals/fixtures/general-embedding-benchmark/2026-04-06-bge-m3-incumbent.md): vector nDCG@10 `0.3503`, hybrid nDCG@10 `0.642`
- [Qwen3 Embedding 0.6B](../evals/fixtures/general-embedding-benchmark/2026-04-06-qwen3-embedding-0-6b.md): vector nDCG@10 `0.8594`, hybrid nDCG@10 `0.947`
<!-- /public-truth -->

A separate [July 2026 Nemotron screen](../research/embeddings/2026-07-21-nemotron-3-embed-1b.md)
measured Qwen at `0.9891` vector / `0.9891` hybrid nDCG@10 and Nemotron at
`0.9023` / `0.9461` on the same 13-query lane after runtime/profile changes.
Nemotron used a temporary PyTorch HTTP adapter, so timings are not comparable;
the screen did not validate an official production GGUF for Nemotron.

<!-- public-truth:default-embed-model -->

`Qwen3-Embedding-0.6B-GGUF` is the embedding model in all four built-in presets.

<!-- /public-truth -->

Operational consequences:

- existing users who upgrade may need a fresh `gno embed` pass because their old vectors were created with `bge-m3`
- GNO now counts readiness/backlog against the active embed model, so the need to re-embed is visible immediately after a preset/default change
- if a future release changes the formatting profile for an active embedding model, re-embed is also required because the stored document vectors were produced differently

Scope matters: query-language classification is distinct from indexed-document
language detection (`en`, `de`, `fr`, `it`, `zh`, `ja`, `ko`), and this small
semantic fixture covers only five languages.

<!-- public-truth:cjk-lexical-benchmark -->

Model-free lexical fallback has a separate immutable
[July 22, 2026 CJK benchmark](../evals/fixtures/cjk-lexical-benchmark/2026-07-22.md).
Production BM25 lexical results and frozen floors:

- Chinese: baseline Recall@10 `0.2222`, nDCG@10 `0.1481`, zero-result `0.7778`; promotion Recall@10 `0.4722`, nDCG@10 `0.3981`, maximum zero-result `0.5278`
- Japanese: baseline Recall@10 `0.125`, nDCG@10 `0.125`, zero-result `0.875`; promotion Recall@10 `0.375`, nDCG@10 `0.375`, maximum zero-result `0.625`
- Korean: baseline Recall@10 `0.5`, nDCG@10 `0.5`, zero-result `0.5`; promotion Recall@10 `0.75`, nDCG@10 `0.75`, maximum zero-result `0.25`

The
[promotion-gates.md](../evals/fixtures/cjk-lexical-benchmark/promotion-gates.md)
also binds MRR, non-regression, and cost requirements. The Chinese fixture
includes a genuine rank-7 retrieval failure. These lexical results do not
describe semantic retrieval or select an implementation, and no production
analyzer/configuration changed. All positive qrels use relevance `3`, so nDCG
measures placement but not distinctions among positive gain grades.

<!-- /public-truth -->

The legacy multilingual Evalite lane is a four-case BM25-only sanity check, not
a release gate.

### Model Details

All presets use:

- **Qwen3-Embedding-0.6B** for embeddings (multilingual)
- **Qwen3-Reranker-0.6B** for reranking (scores best chunk per document)

| Preset     | Embed                   | Rerank                 | Expand                  | Gen           |
| ---------- | ----------------------- | ---------------------- | ----------------------- | ------------- |
| slim-tuned | Qwen3-Embedding-0.6B-Q8 | Qwen3-Reranker-0.6B-Q8 | GNO slim retrieval tune | Qwen3-1.7B-Q4 |
| slim       | Qwen3-Embedding-0.6B-Q8 | Qwen3-Reranker-0.6B-Q8 | Qwen3-1.7B-Q4           | Qwen3-1.7B-Q4 |
| balanced   | Qwen3-Embedding-0.6B-Q8 | Qwen3-Reranker-0.6B-Q8 | Qwen2.5-3B-Q4           | Qwen2.5-3B-Q4 |
| quality    | Qwen3-Embedding-0.6B-Q8 | Qwen3-Reranker-0.6B-Q8 | Qwen3-4B-Q4             | Qwen3-4B-Q4   |

Reranking scores the best retrieved chunk per document, capped at 4K
characters. The model's larger advertised context window does not mean GNO
sends complete documents to the reranker.

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

## Content Types

`contentTypes` is an opt-in, schema-lite typing layer for second-brain pages. It is not a mutable ontology. Empty or absent `contentTypes` keeps legacy behavior.

```yaml
contentTypes:
  - id: person
    prefixes: [people/, contacts/]
    preset: person
  - id: meeting
    prefixes: [meetings/]
    preset: meeting
    temporal: true
```

Fields:

| Field         | Type     | Description                                                           |
| ------------- | -------- | --------------------------------------------------------------------- |
| `id`          | string   | Stable content type ID, such as `person` or `meeting`                 |
| `prefixes`    | string[] | Relative path prefixes that map documents to this type                |
| `preset`      | string   | Note preset used by future type-aware creation and ingestion behavior |
| `temporal`    | boolean  | Accepted metadata flag for time-oriented pages                        |
| `searchBoost` | number   | Reserved for future ranking; accepted but currently no-op             |
| `graphHints`  | string[] | Ordered typed-edge hints for link projection, traversal, and diagnose |

Validation is warning-based after YAML parsing:

- unknown `preset` references warn and the content type entry is dropped
- exact duplicate prefixes are deduped
- overlapping prefixes are retained, for example `people/` and `people/team/`
- rules are normalized longest-prefix-first for matching and edge derivation

`graphHints` vocabulary is centralized in the config API. Supported hints are
`mentions`, `works_at`, `attended`, `decided`, and `related_to`. Hints do not
create standalone edges because they have no target. Instead, the first hint
types projected wiki/markdown links for matching documents, and remaining hints
surface in `gno graph query` and `gno query diagnose` metadata. Editing
`graphHints` changes the content-type fingerprint, so unchanged documents are
reprocessed on the next sync and typed edges are re-derived.

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

Remote endpoints receive the text sent to their configured role: queries and
document chunks for embedding/reranking, generated expansion input for
`expand`, or retrieved answer context for `gen`. Use HTTPS and server-side
access controls outside a trusted network; remote inference is not part of the
local privacy boundary.

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
| `expand`   | `/v1/chat/completions` | Chat Completions API        |
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

| Tokenizer          | Description                        |
| ------------------ | ---------------------------------- |
| `snowball english` | English Snowball stemmer (default) |
| `unicode61`        | Unicode-aware, no stemming         |
| `porter`           | English-only stemming (legacy)     |
| `trigram`          | Substring matching                 |

The exposed Snowball tokenizer is specifically `snowball english`; it enables
English word-form matching such as "running" → "run" and "scored" → "score".
Use `unicode61` for language-neutral Unicode tokenization without stemming.

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

| Variable                    | Description                                                        |
| --------------------------- | ------------------------------------------------------------------ |
| `GNO_LLAMA_GPU`             | Local llama backend: `auto`, `metal`, `vulkan`, `cuda`, or CPU off |
| `NODE_LLAMA_CPP_GPU`        | Compatibility alias used when `GNO_LLAMA_GPU` is unset             |
| `GNO_LLAMA_BUILD`           | Backend build mode: default `never`; set `autoAttempt` to opt in   |
| `GNO_LLAMA_INIT_TIMEOUT_MS` | Backend initialization timeout; default `30000` ms                 |
| `GNO_EMBED_CONTEXTS`        | Override CPU embedding context count, clamped to `1`-`4`           |
| `GNO_EMBED_CONTEXT_SIZE`    | Override native embedding context size; minimum `128`              |
| `GNO_EMBED_THREADS`         | Override CPU threads per embedding context                         |
| `GNO_NO_AUTO_DOWNLOAD`      | Disable automatic model downloads; explicit `models pull` allowed  |

On Windows CPU-only runs, GNO defaults to one embedding context below 16GB RAM,
and at most two contexts from 16GB upward. Increase `GNO_EMBED_CONTEXTS` only
when memory headroom is clear and a real benchmark shows a gain.

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
