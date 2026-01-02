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
  activePreset: balanced
```

## Collections

Collections define what gets indexed.

### Collection Fields

| Field          | Type   | Default   | Description                   |
| -------------- | ------ | --------- | ----------------------------- |
| `name`         | string | required  | Unique identifier (lowercase) |
| `path`         | string | required  | Absolute path to directory    |
| `pattern`      | glob   | `**/*`    | File matching pattern         |
| `include`      | array  | `[]`      | Extension allowlist           |
| `exclude`      | array  | see below | Patterns to skip              |
| `updateCmd`    | string | -         | Shell command before indexing |
| `languageHint` | string | -         | BCP-47 language code          |

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

**TypeScript project:**

```yaml
- name: project
  path: /Users/you/project
  pattern: "**/*.ts"
  include:
    - .ts
    - .tsx
  exclude:
    - node_modules
    - dist
    - "*.test.ts"
```

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

| Preset     | Disk   | Best For                      |
| ---------- | ------ | ----------------------------- |
| `slim`     | ~1GB   | Fast responses, lower quality |
| `balanced` | ~2GB   | Good balance (default)        |
| `quality`  | ~2.5GB | Best answers, complex content |

> **Note**: When using GNO standalone with `--answer`, the **quality** preset is required for documents containing Markdown tables or other structured content. The smaller models in slim/balanced presets cannot reliably parse tabular data. When GNO is used via MCP, skill, or CLI by AI agents (Claude Code, Codex, etc.), the agent handles answer generation, so any preset works for retrieval.

### Model Details

All presets use:

- **bge-m3** for embeddings (1024 dimensions, multilingual)
- **Qwen3-Reranker-0.6B** for reranking (32K context, full documents)

| Preset   | Embed     | Rerank                 | Gen           |
| -------- | --------- | ---------------------- | ------------- |
| slim     | bge-m3-Q4 | Qwen3-Reranker-0.6B-Q8 | Qwen3-1.7B-Q4 |
| balanced | bge-m3-Q4 | Qwen3-Reranker-0.6B-Q8 | SmolLM3-3B-Q4 |
| quality  | bge-m3-Q4 | Qwen3-Reranker-0.6B-Q8 | Qwen3-4B-Q4   |

The reranker's 32K context window allows scoring complete documents (tables, code, all sections) rather than truncated snippets.

### Custom Models

```yaml
models:
  activePreset: custom
  presets:
    - id: custom
      name: My Custom Setup
      embed: hf:user/model/embed.gguf
      rerank: hf:user/model/rerank.gguf
      gen: hf:user/model/gen.gguf
```

Model URIs support:

- `hf:org/repo/file.gguf` - Hugging Face download
- `file:/path/to/model.gguf` - Local file

### Timeouts

```yaml
models:
  loadTimeout: 60000      # Model load timeout (ms)
  inferenceTimeout: 30000 # Inference timeout (ms)
  warmModelTtl: 300000    # Keep-warm duration (ms)
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

## File Locations

**Linux** (XDG):
| Path | Purpose |
|------|---------|
| `~/.config/gno/index.yml` | Config |
| `~/.local/share/gno/index-default.sqlite` | Database |
| `~/.cache/gno/models/` | Model cache |

**macOS**:
| Path | Purpose |
|------|---------|
| `~/Library/Application Support/gno/config/index.yml` | Config |
| `~/Library/Application Support/gno/data/index-default.sqlite` | Database |
| `~/Library/Caches/gno/models/` | Model cache |

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
