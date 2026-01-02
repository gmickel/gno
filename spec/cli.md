# GNO CLI Specification

**Version:** 0.1.0
**Last Updated:** 2025-12-30

This document specifies the command-line interface for GNO, a local knowledge indexing and retrieval system.

## Global Conventions

### Exit Codes

| Code | Name       | Description                                                   |
| ---- | ---------- | ------------------------------------------------------------- |
| 0    | SUCCESS    | Command completed successfully                                |
| 1    | VALIDATION | Validation or usage error (bad args, missing required params) |
| 2    | RUNTIME    | Runtime failure (IO, DB, conversion, model, network)          |

### Global Flags

All commands accept these flags:

| Flag              | Type    | Description                                              |
| ----------------- | ------- | -------------------------------------------------------- |
| `--index <name>`  | string  | Use alternate index DB name (default: "default")         |
| `--config <path>` | string  | Override config file path                                |
| `--no-color`      | boolean | Disable colored output                                   |
| `--verbose`       | boolean | Enable verbose logging to stderr                         |
| `--yes`           | boolean | Non-interactive mode: accept safe defaults, never prompt |

### Output Format Flags

Commands that produce structured output support these format flags:

| Flag      | Description                                           |
| --------- | ----------------------------------------------------- |
| `--json`  | JSON output (array or object depending on command)    |
| `--files` | Line protocol: `#docid,<score>,gno://collection/path` |
| `--csv`   | Comma-separated values with header row                |
| `--md`    | Markdown formatted output                             |
| `--xml`   | XML formatted output                                  |

Default output is human-readable terminal format.

### Output Format Support Matrix

| Command           | --json | --files | --csv | --md | --xml | Default  |
| ----------------- | ------ | ------- | ----- | ---- | ----- | -------- |
| status            | yes    | no      | no    | yes  | no    | terminal |
| init              | no     | no      | no    | no   | no    | terminal |
| collection add    | no     | no      | no    | no   | no    | terminal |
| collection list   | yes    | no      | no    | yes  | no    | terminal |
| collection remove | no     | no      | no    | no   | no    | terminal |
| collection rename | no     | no      | no    | no   | no    | terminal |
| update            | no     | no      | no    | no   | no    | terminal |
| index             | no     | no      | no    | no   | no    | terminal |
| embed             | no     | no      | no    | no   | no    | terminal |
| search            | yes    | yes     | yes   | yes  | yes   | terminal |
| vsearch           | yes    | yes     | yes   | yes  | yes   | terminal |
| query             | yes    | yes     | yes   | yes  | yes   | terminal |
| ask               | yes    | no      | no    | yes  | no    | terminal |
| get               | yes    | no      | no    | yes  | no    | terminal |
| multi-get         | yes    | yes     | no    | yes  | no    | terminal |
| ls                | yes    | yes     | no    | yes  | no    | terminal |
| context add       | no     | no      | no    | no   | no    | terminal |
| context list      | yes    | no      | no    | yes  | no    | terminal |
| context check     | yes    | no      | no    | yes  | no    | terminal |
| context rm        | no     | no      | no    | no   | no    | terminal |
| models list       | yes    | no      | no    | yes  | no    | terminal |
| models pull       | no     | no      | no    | no   | no    | terminal |
| models clear      | no     | no      | no    | no   | no    | terminal |
| models path       | yes    | no      | no    | no   | no    | terminal |
| cleanup           | no     | no      | no    | no   | no    | terminal |
| doctor            | yes    | no      | no    | yes  | no    | terminal |
| mcp               | no     | no      | no    | no   | no    | stdio    |
| mcp install       | yes    | no      | no    | no   | no    | terminal |
| mcp uninstall     | yes    | no      | no    | no   | no    | terminal |
| mcp status        | yes    | no      | no    | no   | no    | terminal |
| skill install     | yes    | no      | no    | no   | no    | terminal |
| skill uninstall   | yes    | no      | no    | no   | no    | terminal |
| skill show        | no     | no      | no    | no   | no    | terminal |
| skill paths       | yes    | no      | no    | no   | no    | terminal |
| serve             | no     | no      | no    | no   | no    | terminal |

---

## Commands

### gno status

Display index status and health information.

**Synopsis:**

```bash
gno status [--json|--md]
```

**Output (JSON):**

```json
{
  "indexName": "default",
  "configPath": "/path/to/config",
  "dbPath": "/path/to/index.sqlite",
  "collections": [
    { "name": "work", "path": "/path", "documentCount": 100, "chunkCount": 500, "embeddedCount": 500 }
  ],
  "totalDocuments": 100,
  "totalChunks": 500,
  "embeddingBacklog": 0,
  "lastUpdated": "2025-12-23T10:00:00Z",
  "healthy": true
}
```

**Exit Codes:**

- 0: Success
- 2: DB not initialized or inaccessible

---

### gno init

Initialize GNO configuration and index database. Safe to run repeatedly (idempotent).

**Synopsis:**

```bash
gno init [<path>] [--name <name>] [--pattern <glob>] [--include <csv-ext>] [--exclude <csv>] [--update <cmd>] [--tokenizer <type>] [--language <code>] [--yes]
```

**Arguments:**
| Arg | Type | Description |
|-----|------|-------------|
| `<path>` | string | Optional root directory to add as a collection |

**Options:**

| Option        | Type    | Default             | Description                                               |
| ------------- | ------- | ------------------- | --------------------------------------------------------- |
| `--name`      | string  | dirname             | Collection name (required if path given)                  |
| `--pattern`   | glob    | `**/*`              | File matching pattern                                     |
| `--include`   | csv     | -                   | Extension allowlist (e.g., `.md,.pdf`)                    |
| `--exclude`   | csv     | `.git,node_modules` | Exclude patterns                                          |
| `--update`    | string  | -                   | Shell command to run before indexing                      |
| `--tokenizer` | string  | unicode61           | FTS tokenizer: unicode61, porter, trigram                 |
| `--language`  | string  | -                   | BCP-47 language hint for collection (e.g., en, de, zh-CN) |
| `--yes`       | boolean | false               | Skip prompts, accept defaults                             |

**Behavior:**

1. Creates config directory and `index.yml` if missing
2. Creates data directory and `index-<name>.sqlite` if missing
3. Runs migrations on DB
4. If `<path>` provided, adds collection (like `collection add`)
5. Prints resolved paths and next steps

**Exit Codes:**

- 0: Success (or already initialized)
- 1: Invalid arguments
- 2: Cannot create directories or DB

**Examples:**

```bash
# Initialize with defaults
gno init

# Initialize with a collection
gno init ~/notes --name notes --pattern "**/*.md"

# Non-interactive initialization
gno init ~/work/docs --name work --yes

# Initialize with porter stemmer (English-optimized)
gno init --tokenizer porter

# Initialize with language hint for German docs
gno init ~/docs/german --name german --language de
```

---

### gno collection add

Add a new collection to the index.

**Synopsis:**

```bash
gno collection add <path> --name <name> [--pattern <glob>] [--include <csv-ext>] [--exclude <csv>] [--update <cmd>] [--language <code>]
```

**Arguments:**
| Arg | Type | Description |
|-----|------|-------------|
| `<path>` | string | Absolute path to collection root directory |

**Options:**

| Option       | Type   | Default                                    | Description                                |
| ------------ | ------ | ------------------------------------------ | ------------------------------------------ |
| `--name`     | string | required                                   | Unique collection identifier               |
| `--pattern`  | glob   | `**/*`                                     | File matching glob pattern                 |
| `--include`  | csv    | -                                          | Extension allowlist                        |
| `--exclude`  | csv    | `.git,node_modules,.venv,.idea,dist,build` | Exclude patterns                           |
| `--update`   | string | -                                          | Shell command to run before indexing       |
| `--language` | string | -                                          | BCP-47 language hint (e.g., en, de, zh-CN) |

**Exit Codes:**

- 0: Success
- 1: Missing required args, invalid path, duplicate name, or invalid language hint
- 2: Config write failure

**Examples:**

```bash
gno collection add ~/notes --name notes --pattern "**/*.md"
gno collection add ~/work/docs --name work --pattern "**/*.{md,pdf,docx}"
```

---

### gno collection list

List all configured collections.

**Synopsis:**

```bash
gno collection list [--json|--md]
```

**Output (JSON):**

```json
[
  {
    "name": "notes",
    "path": "/home/user/notes",
    "pattern": "**/*.md",
    "include": null,
    "exclude": [".git", "node_modules"],
    "updateCmd": null
  }
]
```

**Exit Codes:**

- 0: Success

---

### gno collection remove

Remove a collection from the index.

**Synopsis:**

```bash
gno collection remove <name>
```

**Arguments:**
| Arg | Type | Description |
|-----|------|-------------|
| `<name>` | string | Collection name to remove |

**Behavior:**

- Removes collection from config
- Marks documents as inactive (does not delete DB rows until `cleanup`)

**Exit Codes:**

- 0: Success
- 1: Collection not found

---

### gno collection rename

Rename a collection.

**Synopsis:**

```bash
gno collection rename <old> <new>
```

**Arguments:**
| Arg | Type | Description |
|-----|------|-------------|
| `<old>` | string | Current collection name |
| `<new>` | string | New collection name |

**Exit Codes:**

- 0: Success
- 1: Old name not found or new name already exists

---

### gno update

Sync files from disk into the index (ingestion without embedding).

**Synopsis:**

```bash
gno update [--git-pull]
```

**Options:**
| Option | Type | Description |
|--------|------|-------------|
| `--git-pull` | boolean | Run `git pull` in git repositories before scanning |

**Behavior:**

1. For each collection, enumerate files matching patterns
2. Hash files, detect MIME types
3. Convert to Markdown mirror
4. Chunk content for indexing
5. Update FTS index
6. Mark missing files as inactive

**Exit Codes:**

- 0: Success (conversion warnings do not affect exit code)
- 2: DB failure or critical IO error

---

### gno index

Build or update the index end-to-end (update + embed).

**Synopsis:**

```bash
gno index [--collection <name>] [--no-embed] [--models-pull] [--git-pull] [--yes]
```

**Options:**
| Option | Type | Description |
|--------|------|-------------|
| `--collection` | string | Scope to single collection |
| `--no-embed` | boolean | Run ingestion only, skip embedding |
| `--models-pull` | boolean | Download models if missing (prompts unless `--yes`) |
| `--git-pull` | boolean | Run `git pull` in git repositories |
| `--yes` | boolean | Accept defaults, no prompts |

**Behavior:**

- Runs `update` then `embed` by default
- With `--no-embed`, runs `update` only

**Exit Codes:**

- 0: Success
- 1: Invalid collection name
- 2: DB or model failure

**Examples:**

```bash
# Full index build
gno index

# Update single collection without embedding
gno index --collection notes --no-embed

# CI/scripted usage
gno index --models-pull --yes
```

---

### gno embed

Generate embeddings for chunks without vectors.

**Synopsis:**

```bash
gno embed [--force] [--model <uri>] [--batch-size <n>] [--dry-run] [--yes] [--json]
```

**Options:**

| Option         | Type    | Default | Description                                   |
| -------------- | ------- | ------- | --------------------------------------------- |
| `--force`      | boolean | false   | Re-embed all chunks (ignore existing vectors) |
| `--model`      | string  | config  | Override embedding model URI                  |
| `--batch-size` | integer | 32      | Chunks per batch                              |
| `--dry-run`    | boolean | false   | Show what would be embedded without doing it  |
| `--yes`, `-y`  | boolean | false   | Skip confirmation prompts                     |
| `--json`       | boolean | false   | Output result as JSON                         |

**Exit Codes:**

- 0: Success
- 1: User cancelled
- 2: Model not available or embedding failure

**JSON Output:**

```json
{
  "embedded": 1234,
  "errors": 0,
  "duration": 45.2,
  "model": "hf:BAAI/bge-m3-gguf/bge-m3-q8_0.gguf",
  "searchAvailable": true
}
```

---

### gno search

BM25 keyword search over indexed documents.

**Synopsis:**

```bash
gno search <query> [-n <num>] [--min-score <num>] [-c <collection>] [--full] [--line-numbers] [--lang <bcp47>] [--json|--files|--csv|--md|--xml]
```

**Arguments:**
| Arg | Type | Description |
|-----|------|-------------|
| `<query>` | string | Search query |

**Options:**

| Option             | Type    | Default                   | Description                                    |
| ------------------ | ------- | ------------------------- | ---------------------------------------------- |
| `-n`               | integer | 5 (20 for --json/--files) | Max results                                    |
| `--min-score`      | number  | 0                         | Minimum score threshold                        |
| `-c, --collection` | string  | all                       | Filter to collection                           |
| `--full`           | boolean | false                     | Include full mirror content instead of snippet |
| `--line-numbers`   | boolean | false                     | Include line numbers in output                 |
| `--lang`           | string  | auto                      | Language filter/hint (BCP-47)                  |

**Scoring:**

Scores are normalized per query to a 0-1 range using min-max scaling:

- `1.0` = best match among returned results
- `0.0` = worst match among returned results

Important notes:

- Scores are **relative within a single query's result set**, not comparable across different queries
- `--min-score` filters based on this normalized score (e.g., `--min-score 0.5` keeps top half)
- Raw SQLite FTS5 BM25 scores vary with corpus size; normalization ensures consistent UX
- When all results have equal raw scores, they all receive `1.0`

**Output (JSON):**
See [Output Schemas](./output-schemas/search-result.schema.json)

**Exit Codes:**

- 0: Success (including zero results)
- 1: Invalid query or options
- 2: DB failure

**Examples:**

```bash
gno search "termination clause"
gno search "deploy staging" -n 10 --collection work
gno search "contract" --json | jq '.[] | .uri'
```

---

### gno vsearch

Vector semantic search over indexed documents.

**Synopsis:**

```bash
gno vsearch <query> [-n <num>] [--min-score <num>] [-c <collection>] [--full] [--line-numbers] [--lang <bcp47>] [--json|--files|--csv|--md|--xml]
```

**Options:** Same as `gno search`

**Scoring:**

Vector similarity scores are normalized to a 0-1 range:

- `1.0` = identical/most similar
- `0.0` = least similar (within result set)

Cosine distance (0=identical, 2=opposite) is converted: `score = 1 - (distance / 2)`

**Exit Codes:**

- 0: Success
- 1: Invalid options
- 2: Vectors not available (suggests `gno index` or `gno embed`)

---

### gno query

Hybrid search combining BM25 and vector retrieval with optional expansion and reranking.

**Synopsis:**

```bash
gno query <query> [-n <num>] [--min-score <num>] [-c <collection>] [--full] [--line-numbers] [--lang <bcp47>] [--no-expand] [--no-rerank] [--explain] [--json|--files|--csv|--md|--xml]
```

**Additional Options:**
| Option | Type | Description |
|--------|------|-------------|
| `--no-expand` | boolean | Disable query expansion |
| `--no-rerank` | boolean | Disable cross-encoder reranking |
| `--explain` | boolean | Print retrieval explanation to stderr |

**Explain Output (stderr):**

```
[explain] expansion: enabled (3 lexical, 2 semantic variants)
[explain] bm25: 45 candidates
[explain] vector: 38 candidates
[explain] fusion: RRF k=60, 52 unique candidates
[explain] rerank: top 20 reranked
[explain] result 1: score=0.92 (bm25=0.85, vec=0.78, rerank=0.95)
```

**Exit Codes:**

- 0: Success (degrades gracefully if vectors unavailable)
- 1: Invalid options
- 2: DB or model failure

---

### gno ask

Human-friendly query with citations-first output and optional grounded answer.

**Synopsis:**

```bash
gno ask <query> [-n <num>] [-c <collection>] [--lang <bcp47>] [--answer] [--no-answer] [--max-answer-tokens <n>] [--no-expand] [--no-rerank] [--show-sources] [--json|--md]
```

**Options:**

| Option                | Type    | Default | Description                                 |
| --------------------- | ------- | ------- | ------------------------------------------- |
| `--answer`            | boolean | false   | Generate short grounded answer              |
| `--no-answer`         | boolean | false   | Force retrieval-only output                 |
| `--max-answer-tokens` | integer | config  | Cap answer generation tokens                |
| `--no-expand`         | boolean | false   | Disable query expansion                     |
| `--no-rerank`         | boolean | false   | Disable cross-encoder reranking             |
| `--show-sources`      | boolean | false   | Show all retrieved sources (not just cited) |

**Output (JSON):**
See [Output Schemas](./output-schemas/ask.schema.json)

**Exit Codes:**

- 0: Success
- 1: Invalid options
- 2: DB or model failure

**Examples:**

```bash
gno ask "how do we deploy to staging"
gno ask "termination clause" --collection work --answer
```

---

### gno get

Retrieve a single document by reference.

**Synopsis:**

```bash
gno get <ref> [--from <line>] [-l <lines>] [--line-numbers] [--source] [--json|--md]
```

**Arguments:**
| Arg | Type | Description |
|-----|------|-------------|
| `<ref>` | string | Document reference: `gno://...`, `collection/path`, `#docid`, or `:line` suffix |

**Options:**
| Option | Type | Description |
|--------|------|-------------|
| `--from` | integer | Start at line number |
| `-l` | integer | Limit to N lines |
| `--line-numbers` | boolean | Prefix lines with numbers |
| `--source` | boolean | Include source metadata in output |

**Ref Formats:**

- `gno://work/contracts/nda.docx` - Full URI
- `work/contracts/nda.docx` - Collection-relative path
- `#a1b2c3d4` - Document ID
- `gno://work/doc.md:120` - URI with line number suffix

**Output (JSON):**
See [Output Schemas](./output-schemas/get.schema.json)

**Exit Codes:**

- 0: Success
- 1: Invalid ref format
- 2: Document not found

**Examples:**

```bash
gno get gno://work/contracts/nda.docx
gno get "#a1b2c3d4" --line-numbers
gno get work/doc.md:120 -l 50
```

---

### gno multi-get

Retrieve multiple documents by pattern or list.

**Synopsis:**

```bash
gno multi-get <pattern-or-list> [--max-bytes <n>] [--line-numbers] [--json|--files|--md]
```

**Arguments:**
| Arg | Type | Description |
|-----|------|-------------|
| `<pattern-or-list>` | string | Glob pattern, comma-separated refs, or docid list |

**Options:**

| Option           | Type    | Default | Description                                    |
| ---------------- | ------- | ------- | ---------------------------------------------- |
| `--max-bytes`    | integer | 10240   | Max bytes per document (truncate with warning) |
| `--line-numbers` | boolean | false   | Include line numbers                           |

**Output (JSON):**
See [Output Schemas](./output-schemas/multi-get.schema.json)

**Exit Codes:**

- 0: Success (partial results if some docs missing)
- 1: Invalid pattern
- 2: DB failure

---

### gno ls

List documents in a collection or prefix.

**Synopsis:**

```bash
gno ls [<scope>] [--json|--files|--md]
```

**Arguments:**
| Arg | Type | Description |
|-----|------|-------------|
| `<scope>` | string | Collection name or `gno://collection/prefix` (default: all) |

**Output (JSON):**

```json
[
  {
    "docid": "#a1b2c3d4",
    "uri": "gno://work/doc.md",
    "title": "Document Title",
    "source": { "relPath": "doc.md", "mime": "text/markdown", "ext": ".md" }
  }
]
```

**Exit Codes:**

- 0: Success
- 1: Invalid scope
- 2: DB failure

---

### gno context add

Add context metadata for a scope.

**Synopsis:**

```bash
gno context add <scope> "<text>"
```

**Arguments:**
| Arg | Type | Description |
|-----|------|-------------|
| `<scope>` | string | `/` (global), `collection:` prefix, or `gno://collection/prefix` |
| `<text>` | string | Context description text |

**Exit Codes:**

- 0: Success
- 1: Invalid scope format

**Examples:**

```bash
gno context add / "Corporate knowledge base"
gno context add work: "Work documents and contracts"
gno context add gno://work/contracts "Legal contracts and NDAs"
```

---

### gno context list

List all configured contexts.

**Synopsis:**

```bash
gno context list [--json|--md]
```

**Output (JSON):**

```json
[
  { "scope": "/", "text": "Corporate knowledge base" },
  { "scope": "work:", "text": "Work documents" }
]
```

---

### gno context check

Validate context configuration.

**Synopsis:**

```bash
gno context check [--json|--md]
```

**Output (JSON):**

```json
{
  "valid": true,
  "warnings": [],
  "errors": []
}
```

---

### gno context rm

Remove a context.

**Synopsis:**

```bash
gno context rm <scope>
```

**Exit Codes:**

- 0: Success
- 1: Scope not found

---

### gno models list

List configured and available models.

**Synopsis:**

```bash
gno models list [--json|--md]
```

**Output (JSON):**

```json
{
  "activePreset": "balanced",
  "presets": [
    { "id": "slim", "name": "Slim (Fast, ~1GB)", "active": false },
    { "id": "balanced", "name": "Balanced (Default, ~2GB)", "active": true },
    { "id": "quality", "name": "Quality (Best Answers, ~2.5GB)", "active": false }
  ],
  "embed": { "uri": "hf:gpustack/bge-m3-GGUF/bge-m3-Q4_K_M.gguf", "cached": true },
  "rerank": { "uri": "hf:gpustack/bge-reranker-v2-m3-GGUF/bge-reranker-v2-m3-Q4_K_M.gguf", "cached": false },
  "gen": { "uri": "hf:ggml-org/SmolLM3-3B-GGUF/SmolLM3-Q4_K_M.gguf", "cached": true }
}
```

---

### gno models use

Switch active model preset.

**Synopsis:**

```bash
gno models use <preset>
```

**Arguments:**
| Arg | Type | Description |
|-----|------|-------------|
| `<preset>` | string | Preset ID: `slim`, `balanced`, or `quality` |

**Presets:**
| ID | Gen Model | RAM | Use Case |
|----|-----------|-----|----------|
| `slim` | Qwen3-1.7B | ~1GB | Fast queries, limited RAM |
| `balanced` | SmolLM3-3B | ~2GB | Default, good quality |
| `quality` | Qwen3-4B-Instruct-2507 | ~2.5GB | Best grounded answers |

**Exit Codes:**

- 0: Success
- 1: Unknown preset

---

### gno models pull

Download models to local cache.

**Synopsis:**

```bash
gno models pull [--all|--embed|--rerank|--gen] [--force]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--all` | Pull all configured models |
| `--embed` | Pull embedding model only |
| `--rerank` | Pull reranker model only |
| `--gen` | Pull generation model only |
| `--force` | Re-download even if already cached |

**Behavior:**

- Skips models that are already cached (checksum match) unless `--force` is used
- Default (no flags): pulls all models

**Exit Codes:**

- 0: Success
- 2: Download failure

---

### gno models clear

Remove cached models.

**Synopsis:**

```bash
gno models clear [--all|--embed|--rerank|--gen]
```

---

### gno models path

Print model cache directory.

**Synopsis:**

```bash
gno models path [--json]
```

**Output:**

```
/Users/user/Library/Caches/gno/models
```

---

### gno cleanup

Remove orphaned content, chunks, and vectors not referenced by active documents.

**Synopsis:**

```bash
gno cleanup
```

**Exit Codes:**

- 0: Success
- 2: DB failure

---

### gno doctor

Diagnose configuration and dependencies.

**Synopsis:**

```bash
gno doctor [--json|--md]
```

**Output (JSON):**

```json
{
  "healthy": true,
  "checks": [
    { "name": "config", "status": "ok", "message": "Config loaded: ~/.config/gno/config.yaml" },
    { "name": "database", "status": "ok", "message": "Database found: ~/.local/share/gno/index.db" },
    { "name": "embed-model", "status": "ok", "message": "embed model cached" },
    { "name": "rerank-model", "status": "warn", "message": "rerank model not cached. Run: gno models pull --rerank" },
    { "name": "gen-model", "status": "ok", "message": "gen model cached" },
    { "name": "node-llama-cpp", "status": "ok", "message": "node-llama-cpp loaded successfully" }
  ]
}
```

**Exit Codes:**

- 0: All checks pass or only warnings
- 2: Critical checks failed

---

### gno mcp

Start MCP server over stdio.

**Synopsis:**

```bash
gno mcp
```

**Behavior:**

- Starts JSON-RPC 2.0 MCP server on stdin/stdout
- Keeps DB open for server lifetime
- See [MCP Specification](./mcp.md) for protocol details

**Exit Codes:**

- 0: Clean shutdown
- 2: Initialization failure

---

### gno mcp install

Install gno as an MCP server in client configurations.

**Synopsis:**

```bash
gno mcp install [--target <target>] [--scope <scope>] [--force] [--dry-run] [--json]
```

**Options:**

| Option      | Type    | Default        | Description                                                |
| ----------- | ------- | -------------- | ---------------------------------------------------------- |
| `--target`  | string  | claude-desktop | Target client (see table below)                            |
| `--scope`   | string  | user           | Scope: `user` or `project` (project only for some targets) |
| `--force`   | boolean | false          | Overwrite existing gno configuration                       |
| `--dry-run` | boolean | false          | Show what would be done without changes                    |

**Targets:**

| Value            | Description                  | Project Scope      |
| ---------------- | ---------------------------- | ------------------ |
| `claude-desktop` | Claude Desktop app (default) | No                 |
| `claude-code`    | Claude Code CLI              | Yes                |
| `codex`          | OpenAI Codex CLI             | Yes                |
| `cursor`         | Cursor editor                | Yes                |
| `zed`            | Zed editor                   | No                 |
| `windsurf`       | Windsurf IDE                 | No                 |
| `opencode`       | OpenCode CLI                 | Yes                |
| `amp`            | Amp (Sourcegraph)            | No                 |
| `lmstudio`       | LM Studio                    | No                 |
| `librechat`      | LibreChat                    | Yes (project only) |

**Config Locations:**

| Target         | Scope   | macOS                                                             | Windows                                       | Linux                                         |
| -------------- | ------- | ----------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------- |
| claude-desktop | user    | `~/Library/Application Support/Claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json` | `~/.config/Claude/claude_desktop_config.json` |
| claude-code    | user    | `~/.claude.json`                                                  | `~/.claude.json`                              | `~/.claude.json`                              |
| claude-code    | project | `./.mcp.json`                                                     | `./.mcp.json`                                 | `./.mcp.json`                                 |
| codex          | user    | `~/.codex.json`                                                   | `~/.codex.json`                               | `~/.codex.json`                               |
| codex          | project | `./.codex/.mcp.json`                                              | `./.codex/.mcp.json`                          | `./.codex/.mcp.json`                          |
| cursor         | user    | `~/.cursor/mcp.json`                                              | `~/.cursor/mcp.json`                          | `~/.cursor/mcp.json`                          |
| cursor         | project | `./.cursor/mcp.json`                                              | `./.cursor/mcp.json`                          | `./.cursor/mcp.json`                          |
| zed            | user    | `~/.config/zed/settings.json`                                     | N/A                                           | `~/.config/zed/settings.json`                 |
| windsurf       | user    | `~/.codeium/windsurf/mcp_config.json`                             | `%APPDATA%\Codeium\windsurf\mcp_config.json`  | `~/.codeium/windsurf/mcp_config.json`         |
| opencode       | user    | `~/.config/opencode/config.json`                                  | `~/.config/opencode/config.json`              | `~/.config/opencode/config.json`              |
| opencode       | project | `./opencode.json`                                                 | `./opencode.json`                             | `./opencode.json`                             |
| amp            | user    | `~/.config/amp/settings.json`                                     | `~/.config/amp/settings.json`                 | `~/.config/amp/settings.json`                 |
| lmstudio       | user    | `~/.lmstudio/mcp.json`                                            | `~/.lmstudio/mcp.json`                        | `~/.lmstudio/mcp.json`                        |
| librechat      | project | `./librechat.yaml`                                                | `./librechat.yaml`                            | `./librechat.yaml`                            |

**Config Formats:**

- Standard JSON (`mcpServers` key): Claude Desktop, Claude Code, Codex, Cursor, Windsurf, LM Studio
- Standard YAML (`mcpServers` key): LibreChat
- Zed: `context_servers` key
- OpenCode: `mcp` key with array command format
- Amp: `amp.mcpServers` key

**Behavior:**

1. Detects bun and gno paths (absolute paths for sandboxed environments)
2. Reads existing config (creates if missing)
3. Adds `mcpServers.gno` entry
4. Creates backup before modifying
5. Writes atomically via temp file + rename

**Output (JSON):**

```json
{
  "installed": {
    "target": "claude-desktop",
    "scope": "user",
    "configPath": "~/Library/Application Support/Claude/claude_desktop_config.json",
    "action": "created",
    "serverEntry": { "command": "/path/to/bun", "args": ["/path/to/gno", "mcp"] }
  }
}
```

**Exit Codes:**

- 0: Success
- 1: Already configured (without --force), invalid scope for target
- 2: Bun not found, gno not found, IO failure

**Examples:**

```bash
# Install for Claude Desktop (default)
gno mcp install

# Install for Cursor
gno mcp install --target cursor

# Install for Zed
gno mcp install --target zed

# Install for Claude Code (project scope)
gno mcp install --target claude-code --scope project

# Force overwrite
gno mcp install --force

# Preview changes
gno mcp install --dry-run
```

---

### gno mcp uninstall

Remove gno MCP server from client configurations.

**Synopsis:**

```bash
gno mcp uninstall [--target <target>] [--scope <scope>] [--json]
```

**Options:**

| Option     | Type   | Default        | Description   |
| ---------- | ------ | -------------- | ------------- |
| `--target` | string | claude-desktop | Target client |
| `--scope`  | string | user           | Scope         |

**Behavior:**

1. Reads existing config
2. Removes `mcpServers.gno` entry if present
3. Creates backup before modifying
4. Removes empty `mcpServers` object
5. Preserves other entries

**Output (JSON):**

```json
{
  "uninstalled": {
    "target": "claude-desktop",
    "scope": "user",
    "configPath": "~/Library/Application Support/Claude/claude_desktop_config.json",
    "action": "removed"
  }
}
```

**Exit Codes:**

- 0: Success (including if not configured)
- 1: Invalid scope for target
- 2: IO failure

---

### gno mcp status

Show MCP server installation status across all targets.

**Synopsis:**

```bash
gno mcp status [--target <target>] [--scope <scope>] [--json]
```

**Options:**

| Option     | Type   | Default | Description                 |
| ---------- | ------ | ------- | --------------------------- |
| `--target` | string | all     | Filter by target (or `all`) |
| `--scope`  | string | all     | Filter by scope (or `all`)  |

**Output (Terminal):**

```text
MCP Server Status
──────────────────────────────────────────────────

✓ Claude Desktop: configured
    Command: /path/to/bun
    Args: /path/to/gno mcp
    Config: ~/Library/Application Support/Claude/claude_desktop_config.json

✗ Claude Code: not configured
    Config: ~/.claude.json

✗ Claude Code (project): not configured
    Config: ./.mcp.json

2/5 targets configured
```

**Output (JSON):**

```json
{
  "targets": [
    {
      "target": "claude-desktop",
      "scope": "user",
      "configPath": "~/Library/Application Support/Claude/claude_desktop_config.json",
      "configured": true,
      "serverEntry": { "command": "/path/to/bun", "args": ["/path/to/gno", "mcp"] }
    },
    {
      "target": "claude-code",
      "scope": "user",
      "configPath": "~/.claude.json",
      "configured": false
    }
  ],
  "summary": { "configured": 1, "total": 5 }
}
```

**Exit Codes:**

- 0: Success
- 1: Invalid target or scope
- 2: IO failure

---

### gno skill install

Install GNO agent skill for Claude Code or Codex.

**Synopsis:**

```bash
gno skill install [--scope <project|user>] [--target <claude|codex|all>] [--force] [--json]
```

**Options:**

| Option     | Type    | Default | Description                                               |
| ---------- | ------- | ------- | --------------------------------------------------------- |
| `--scope`  | string  | project | `project` (.claude/skills/) or `user` (~/.claude/skills/) |
| `--target` | string  | claude  | `claude`, `codex`, or `all`                               |
| `--force`  | boolean | false   | Overwrite existing skill without prompting                |

**Behavior:**

1. Resolves target path based on scope and target
2. If skill exists and not `--force`/`--yes`: error
3. Atomically installs skill directory (temp + rename)
4. Copies SKILL.md and reference files

**Output (JSON):**

```json
{
  "installed": [
    { "target": "claude", "scope": "project", "path": ".claude/skills/gno" }
  ]
}
```

**Exit Codes:**

- 0: Success
- 1: Skill already exists (without --force)
- 2: IO failure

**Examples:**

```bash
# Install to current project for Claude Code
gno skill install

# Install globally for all agents
gno skill install --scope user --target all

# Force reinstall
gno skill install --force
```

---

### gno skill uninstall

Remove GNO agent skill.

**Synopsis:**

```bash
gno skill uninstall [--scope <project|user>] [--target <claude|codex|all>] [--json]
```

**Options:** Same as `skill install` (except `--force`)

**Safety Checks:**

- Validates path ends with `/skills/gno` before removal
- Rejects paths that don't match expected structure
- Uses atomic removal with retry for Windows compatibility

**Output (JSON):**

```json
{
  "uninstalled": [
    { "target": "claude", "scope": "project", "path": ".claude/skills/gno" }
  ]
}
```

**Exit Codes:**

- 0: Success
- 1: Skill not found
- 2: IO failure or safety check failed

---

### gno skill show

Preview skill files without installing.

**Synopsis:**

```bash
gno skill show [--file <name>] [--all]
```

**Options:**

| Option   | Type    | Default  | Description                                                             |
| -------- | ------- | -------- | ----------------------------------------------------------------------- |
| `--file` | string  | SKILL.md | File to show: SKILL.md, cli-reference.md, mcp-reference.md, examples.md |
| `--all`  | boolean | false    | Show all files with separators                                          |

**Behavior:**

- Outputs file content to stdout
- Lists available files at end

**Exit Codes:**

- 0: Success
- 1: Invalid file name

**Examples:**

```bash
gno skill show
gno skill show --file cli-reference.md
gno skill show --all
```

---

### gno skill paths

Show resolved skill installation paths.

**Synopsis:**

```bash
gno skill paths [--scope <project|user>] [--target <claude|codex|all>] [--json]
```

**Options:** Same as `skill install`

**Output (JSON):**

```json
{
  "paths": [
    { "target": "claude", "scope": "project", "path": "/path/to/.claude/skills/gno", "exists": false },
    { "target": "claude", "scope": "user", "path": "/home/user/.claude/skills/gno", "exists": true }
  ]
}
```

**Exit Codes:**

- 0: Success

---

### gno serve

Start web UI server for visual search and browse.

**Synopsis:**

```bash
gno serve [--port <num>]
```

**Options:**

| Option       | Type   | Default | Description       |
| ------------ | ------ | ------- | ----------------- |
| `-p, --port` | number | 3000    | Port to listen on |

**Behavior:**

- Opens database once at startup (not per-request)
- Closes database on SIGINT/SIGTERM
- Sets CSP header: `default-src 'self'; script-src 'self'`
- Health check at `/api/health` returns `{ok:true}`

**Exit Codes:**

- 0: Server stopped gracefully
- 2: Server failed to start (DB error, port in use)

**Examples:**

```bash
gno serve
gno serve --port 8080
```

---

## Error Output

Errors are written to stderr. With `--json` flag, errors are also returned as:

```json
{
  "error": {
    "code": "VALIDATION",
    "message": "Missing required argument: query",
    "details": {}
  }
}
```

Error codes match exit codes: `VALIDATION` (exit 1), `RUNTIME` (exit 2).

---

## Environment Variables

| Variable                   | Description                                      |
| -------------------------- | ------------------------------------------------ |
| `GNO_CONFIG_DIR`           | Override config directory                        |
| `GNO_DATA_DIR`             | Override data directory (DB location)            |
| `GNO_CACHE_DIR`            | Override cache directory (models)                |
| `NO_COLOR`                 | Disable colored output (standard)                |
| `GNO_SKILLS_HOME_OVERRIDE` | Override home dir for skill user scope (testing) |
| `CLAUDE_SKILLS_DIR`        | Override Claude skills directory                 |
| `CODEX_SKILLS_DIR`         | Override Codex skills directory                  |

---

## See Also

- [MCP Specification](./mcp.md)
- [Output Schemas](./output-schemas/)
- [PRD](../docs/prd.md)
