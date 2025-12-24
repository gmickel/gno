# GNO CLI Specification

**Version:** 1.0.0
**Last Updated:** 2025-12-23

This document specifies the command-line interface for GNO, a local knowledge indexing and retrieval system.

## Global Conventions

### Exit Codes

| Code | Name | Description |
|------|------|-------------|
| 0 | SUCCESS | Command completed successfully |
| 1 | VALIDATION | Validation or usage error (bad args, missing required params) |
| 2 | RUNTIME | Runtime failure (IO, DB, conversion, model, network) |

### Global Flags

All commands accept these flags:

| Flag | Type | Description |
|------|------|-------------|
| `--index <name>` | string | Use alternate index DB name (default: "default") |
| `--config <path>` | string | Override config file path |
| `--no-color` | boolean | Disable colored output |
| `--verbose` | boolean | Enable verbose logging to stderr |
| `--yes` | boolean | Non-interactive mode: accept safe defaults, never prompt |

### Output Format Flags

Commands that produce structured output support these format flags:

| Flag | Description |
|------|-------------|
| `--json` | JSON output (array or object depending on command) |
| `--files` | Line protocol: `#docid,<score>,gno://collection/path` |
| `--csv` | Comma-separated values with header row |
| `--md` | Markdown formatted output |
| `--xml` | XML formatted output |

Default output is human-readable terminal format.

### Output Format Support Matrix

| Command | --json | --files | --csv | --md | --xml | Default |
|---------|--------|---------|-------|------|-------|---------|
| status | yes | no | no | yes | no | terminal |
| init | no | no | no | no | no | terminal |
| collection add | no | no | no | no | no | terminal |
| collection list | yes | no | no | yes | no | terminal |
| collection remove | no | no | no | no | no | terminal |
| collection rename | no | no | no | no | no | terminal |
| update | no | no | no | no | no | terminal |
| index | no | no | no | no | no | terminal |
| embed | no | no | no | no | no | terminal |
| search | yes | yes | yes | yes | yes | terminal |
| vsearch | yes | yes | yes | yes | yes | terminal |
| query | yes | yes | yes | yes | yes | terminal |
| ask | yes | no | no | yes | no | terminal |
| get | yes | no | no | yes | no | terminal |
| multi-get | yes | yes | no | yes | no | terminal |
| ls | yes | yes | no | yes | no | terminal |
| context add | no | no | no | no | no | terminal |
| context list | yes | no | no | yes | no | terminal |
| context check | yes | no | no | yes | no | terminal |
| context rm | no | no | no | no | no | terminal |
| models list | yes | no | no | yes | no | terminal |
| models pull | no | no | no | no | no | terminal |
| models clear | no | no | no | no | no | terminal |
| models path | yes | no | no | no | no | terminal |
| cleanup | no | no | no | no | no | terminal |
| doctor | yes | no | no | yes | no | terminal |
| mcp | no | no | no | no | no | stdio |

---

## Commands

### gno status

Display index status and health information.

**Synopsis:**
```
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
```
gno init [<path>] [--name <name>] [--pattern <glob>] [--include <csv-ext>] [--exclude <csv>] [--update <cmd>] [--tokenizer <type>] [--language <code>] [--yes]
```

**Arguments:**
| Arg | Type | Description |
|-----|------|-------------|
| `<path>` | string | Optional root directory to add as a collection |

**Options:**
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--name` | string | dirname | Collection name (required if path given) |
| `--pattern` | glob | `**/*` | File matching pattern |
| `--include` | csv | - | Extension allowlist (e.g., `.md,.pdf`) |
| `--exclude` | csv | `.git,node_modules` | Exclude patterns |
| `--update` | string | - | Shell command to run before indexing |
| `--tokenizer` | string | unicode61 | FTS tokenizer: unicode61, porter, trigram |
| `--language` | string | - | BCP-47 language hint for collection (e.g., en, de, zh-CN) |
| `--yes` | boolean | false | Skip prompts, accept defaults |

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
```
gno collection add <path> --name <name> [--pattern <glob>] [--include <csv-ext>] [--exclude <csv>] [--update <cmd>] [--language <code>]
```

**Arguments:**
| Arg | Type | Description |
|-----|------|-------------|
| `<path>` | string | Absolute path to collection root directory |

**Options:**
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--name` | string | required | Unique collection identifier |
| `--pattern` | glob | `**/*` | File matching glob pattern |
| `--include` | csv | - | Extension allowlist |
| `--exclude` | csv | `.git,node_modules,.venv,.idea,dist,build` | Exclude patterns |
| `--update` | string | - | Shell command to run before indexing |
| `--language` | string | - | BCP-47 language hint (e.g., en, de, zh-CN) |

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
```
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
```
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
```
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
```
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
```
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
```
gno embed [--force] [--model <uri>] [--batch-size <n>] [--dry-run] [--yes] [--json]
```

**Options:**
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--force` | boolean | false | Re-embed all chunks (ignore existing vectors) |
| `--model` | string | config | Override embedding model URI |
| `--batch-size` | integer | 32 | Chunks per batch |
| `--dry-run` | boolean | false | Show what would be embedded without doing it |
| `--yes`, `-y` | boolean | false | Skip confirmation prompts |
| `--json` | boolean | false | Output result as JSON |

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
```
gno search <query> [-n <num>] [--min-score <num>] [-c <collection>] [--full] [--line-numbers] [--lang <bcp47>] [--json|--files|--csv|--md|--xml]
```

**Arguments:**
| Arg | Type | Description |
|-----|------|-------------|
| `<query>` | string | Search query |

**Options:**
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-n` | integer | 5 (20 for --json/--files) | Max results |
| `--min-score` | number | 0 | Minimum score threshold |
| `-c, --collection` | string | all | Filter to collection |
| `--full` | boolean | false | Include full mirror content instead of snippet |
| `--line-numbers` | boolean | false | Include line numbers in output |
| `--lang` | string | auto | Language filter/hint (BCP-47) |

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
```
gno vsearch <query> [-n <num>] [--min-score <num>] [-c <collection>] [--full] [--line-numbers] [--lang <bcp47>] [--json|--files|--csv|--md|--xml]
```

**Options:** Same as `gno search`

**Exit Codes:**
- 0: Success
- 1: Invalid options
- 2: Vectors not available (suggests `gno index` or `gno embed`)

---

### gno query

Hybrid search combining BM25 and vector retrieval with optional expansion and reranking.

**Synopsis:**
```
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
```
gno ask <query> [-n <num>] [-c <collection>] [--lang <bcp47>] [--answer] [--no-answer] [--max-answer-tokens <n>] [--json|--md]
```

**Options:**
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--answer` | boolean | false | Generate short grounded answer |
| `--no-answer` | boolean | false | Force retrieval-only output |
| `--max-answer-tokens` | integer | config | Cap answer generation tokens |

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
```
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
```
gno multi-get <pattern-or-list> [--max-bytes <n>] [--line-numbers] [--json|--files|--md]
```

**Arguments:**
| Arg | Type | Description |
|-----|------|-------------|
| `<pattern-or-list>` | string | Glob pattern, comma-separated refs, or docid list |

**Options:**
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--max-bytes` | integer | 10240 | Max bytes per document (truncate with warning) |
| `--line-numbers` | boolean | false | Include line numbers |

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
```
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
```
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
```
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
```
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
```
gno context rm <scope>
```

**Exit Codes:**
- 0: Success
- 1: Scope not found

---

### gno models list

List configured and available models.

**Synopsis:**
```
gno models list [--json|--md]
```

**Output (JSON):**
```json
{
  "embed": { "uri": "hf:BAAI/bge-m3", "cached": true, "path": "/path/to/model", "size": 123456789 },
  "rerank": { "uri": "hf:BAAI/bge-reranker-v2-m3", "cached": false, "path": null },
  "gen": { "uri": "hf:Qwen/Qwen2.5-0.5B-Instruct", "cached": true, "path": "/path/to/model", "size": 987654321 },
  "cacheDir": "/path/to/cache/models",
  "totalSize": 1111111110
}
```

---

### gno models pull

Download models to local cache.

**Synopsis:**
```
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
```
gno models clear [--all|--embed|--rerank|--gen]
```

---

### gno models path

Print model cache directory.

**Synopsis:**
```
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
```
gno cleanup
```

**Exit Codes:**
- 0: Success
- 2: DB failure

---

### gno doctor

Diagnose configuration and dependencies.

**Synopsis:**
```
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
```
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

| Variable | Description |
|----------|-------------|
| `GNO_CONFIG_DIR` | Override config directory |
| `GNO_DATA_DIR` | Override data directory (DB location) |
| `GNO_CACHE_DIR` | Override cache directory (models) |
| `NO_COLOR` | Disable colored output (standard) |

---

## See Also

- [MCP Specification](./mcp.md)
- [Output Schemas](./output-schemas/)
- [PRD](../docs/prd.md)
