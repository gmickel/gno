# GNO CLI Specification

**Version:** 0.1.0
**Last Updated:** 2025-12-30

This document specifies the command-line interface for GNO, a local knowledge indexing and retrieval system.

## Global Conventions

### Exit Codes

| Code | Name        | Description                                                   |
| ---- | ----------- | ------------------------------------------------------------- |
| 0    | SUCCESS     | Command completed successfully                                |
| 1    | VALIDATION  | Validation or usage error (bad args, missing required params) |
| 2    | RUNTIME     | Runtime failure (IO, DB, conversion, model, network)          |
| 3    | NOT_RUNNING | `--status`/`--stop` found no live matching process            |

### Global Flags

All commands accept these flags:

| Flag              | Type    | Description                                              |
| ----------------- | ------- | -------------------------------------------------------- |
| `--index <name>`  | string  | Use alternate index DB name (default: "default")         |
| `--config <path>` | string  | Override config file path                                |
| `--no-color`      | boolean | Disable colored output                                   |
| `--verbose`       | boolean | Enable verbose logging to stderr                         |
| `--yes`           | boolean | Non-interactive mode: accept safe defaults, never prompt |
| `--quiet`         | boolean | Suppress non-essential output                            |
| `--offline`       | boolean | Offline mode: use cached models only                     |
| `--no-pager`      | boolean | Disable automatic paging of long output                  |
| `--skill`         | boolean | Output SKILL.md for agent discovery and exit             |

### Output Format Flags

Commands that produce structured output support these format flags:

| Flag      | Description                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------- |
| `--json`  | JSON output (array or object depending on command)                                                             |
| `--files` | Line protocol: `#docid,<score>,gno://collection/path` (`?index=<name>` may be present for non-default indexes) |
| `--csv`   | Comma-separated values with header row                                                                         |
| `--md`    | Markdown formatted output                                                                                      |
| `--xml`   | XML formatted output                                                                                           |

Default output is human-readable terminal format.

Index names are filesystem identifiers: 1–64 UTF-16 code units drawn from
Unicode letters, marks, numbers, internal ASCII spaces, `.`, `_`, or `-`. The
first character must be a letter or number; the last cannot be a space or `.`;
`..` is forbidden. Absolute paths, path separators, controls, and
platform-invalid punctuation are validation errors (exit 1). NFC/case-folded
equivalents have one logical identity and database selection. The canonical
identity is limited to 242 UTF-8 bytes so `index-<identity>.sqlite` stays within
the portable 255-byte filename-component limit. The same contract applies to
indexed `gno://` references. New indexes use the canonical filename. One
pre-existing legacy filename for that identity remains addressable; multiple
equivalent files fail closed as ambiguous.

### Output Format Support Matrix

| Command            | --json | --files | --csv | --md | --xml | Default  |
| ------------------ | ------ | ------- | ----- | ---- | ----- | -------- |
| status             | yes    | no      | no    | yes  | no    | terminal |
| init               | no     | no      | no    | no   | no    | terminal |
| collection add     | no     | no      | no    | no   | no    | terminal |
| collection list    | yes    | no      | no    | yes  | no    | terminal |
| collection remove  | no     | no      | no    | no   | no    | terminal |
| collection rename  | no     | no      | no    | no   | no    | terminal |
| update             | no     | no      | no    | no   | no    | terminal |
| index              | no     | no      | no    | no   | no    | terminal |
| embed              | no     | no      | no    | no   | no    | terminal |
| search             | yes    | yes     | yes   | yes  | yes   | terminal |
| vsearch            | yes    | yes     | yes   | yes  | yes   | terminal |
| query              | yes    | yes     | yes   | yes  | yes   | terminal |
| bench              | yes    | no      | no    | no   | no    | terminal |
| ask                | yes    | no      | no    | yes  | no    | terminal |
| capture            | yes    | no      | no    | no   | no    | terminal |
| get                | yes    | no      | no    | yes  | no    | terminal |
| multi-get          | yes    | yes     | no    | yes  | no    | terminal |
| ls                 | yes    | yes     | no    | yes  | no    | terminal |
| daemon             | yes¹   | no      | no    | no   | no    | terminal |
| context add        | no     | no      | no    | no   | no    | terminal |
| context list       | yes    | no      | no    | yes  | no    | terminal |
| context check      | yes    | no      | no    | yes  | no    | terminal |
| context build      | yes    | no      | no    | yes  | no    | Markdown |
| context verify     | yes    | no      | no    | yes  | no    | Markdown |
| context watch      | yes    | no      | no    | no   | no    | terminal |
| context watches    | yes    | no      | no    | no   | no    | terminal |
| context unwatch    | yes    | no      | no    | no   | no    | terminal |
| context reverify   | yes    | no      | no    | no   | no    | terminal |
| context rm         | no     | no      | no    | no   | no    | terminal |
| models list        | yes    | no      | no    | yes  | no    | terminal |
| models pull        | no     | no      | no    | no   | no    | terminal |
| models clear       | no     | no      | no    | no   | no    | terminal |
| models path        | yes    | no      | no    | no   | no    | terminal |
| publish export     | yes    | no      | no    | no   | no    | terminal |
| cleanup            | no     | no      | no    | no   | no    | terminal |
| doctor             | yes    | no      | no    | yes  | no    | terminal |
| mcp                | no     | no      | no    | no   | no    | stdio    |
| mcp install        | yes    | no      | no    | no   | no    | terminal |
| mcp uninstall      | yes    | no      | no    | no   | no    | terminal |
| mcp status         | yes    | no      | no    | no   | no    | terminal |
| skill install      | yes    | no      | no    | no   | no    | terminal |
| skill uninstall    | yes    | no      | no    | no   | no    | terminal |
| skill show         | no     | no      | no    | no   | no    | terminal |
| skill paths        | yes    | no      | no    | no   | no    | terminal |
| tags list          | yes    | no      | no    | yes  | no    | terminal |
| tags add           | yes    | no      | no    | no   | no    | terminal |
| tags rm            | yes    | no      | no    | no   | no    | terminal |
| links list         | yes    | no      | no    | yes  | no    | terminal |
| backlinks          | yes    | no      | no    | yes  | no    | terminal |
| similar            | yes    | no      | no    | yes  | no    | terminal |
| graph              | yes    | no      | no    | no   | no    | terminal |
| graph query        | yes    | no      | no    | no   | no    | terminal |
| serve              | yes¹   | no      | no    | no   | no    | terminal |
| completion         | no     | no      | no    | no   | no    | terminal |
| completion install | yes    | no      | no    | no   | no    | terminal |

¹ `--json` applies only to `--status` on `gno serve` and `gno daemon` (see [process-status schema](./output-schemas/process-status.schema.json)).

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
    {
      "name": "work",
      "path": "/path",
      "documentCount": 100,
      "chunkCount": 500,
      "embeddedCount": 500
    }
  ],
  "totalDocuments": 100,
  "totalChunks": 500,
  "embeddingBacklog": 0,
  "lastUpdated": "2025-12-23T10:00:00Z",
  "healthy": true,
  "activation": {
    "schemaVersion": "1.0",
    "usable": true,
    "healthy": true,
    "collections": [
      {
        "collection": "work",
        "ready": true,
        "generatedAt": "2025-12-23T10:00:00Z",
        "stages": {
          "index": {
            "status": "passed",
            "startedAt": "2025-12-23T10:00:00Z",
            "completedAt": "2025-12-23T10:00:00Z",
            "latencyMs": 3
          },
          "lexical": {
            "status": "passed",
            "startedAt": "2025-12-23T10:00:00Z",
            "completedAt": "2025-12-23T10:00:00Z",
            "latencyMs": 2
          },
          "semantic": {
            "status": "pending",
            "startedAt": null,
            "completedAt": null,
            "latencyMs": null,
            "code": "semantic_not_checked"
          },
          "connector": {
            "status": "skipped",
            "startedAt": null,
            "completedAt": null,
            "latencyMs": null,
            "code": "connector_not_requested"
          }
        },
        "semanticAvailability": {
          "status": "pending",
          "code": "semantic_not_checked",
          "command": "gno status"
        },
        "remediation": null
      }
    ],
    "connectors": [],
    "connectorProjection": {
      "total": 0,
      "projected": 0,
      "truncated": false
    }
  }
}
```

`activation.usable` means at least one configured collection passed its local
lexical proof. `activation.healthy` means every configured collection passed.
Semantic and connector stages remain independent; passive status never starts a
model runtime or connector process. `gno status` still exits 0 when activation
is unhealthy so scripts can inspect the structured state.

JSON output also includes `resident` using
`gno://schemas/resident-status@1.0`. Direct `gno status` is intentionally
truthful about its lifecycle: `mode:"direct-cli"`, `resident:false`, no
listener, and zero resident counters. It does not imply attachment to a live
`serve` or `daemon`.

Local activation fingerprints use active-document identifiers and source/mirror
hashes plus schema, tokenizer, and owned FTS synchronization metadata. Passive
status never selects or compares stored markdown or FTS bodies. On a receipt
miss, lexical proof reads at most 64 document prefixes of 32,768 characters and
tries at most 64 corpus-derived terms. `index_out_of_sync` fails before probing
when any active document lacks a current owned FTS row. Migration 013 compares
legacy FTS bodies once before backfilling that marker; after migration, direct
out-of-band FTS body mutations remain outside the owned-writer contract.

Passive callers report `semantic_not_checked` when vector runtime availability
is unknown. `vector_unavailable` is reserved for a resident runtime that has
positively reported vector search unavailable.

`connectorProjection.total` counts every configured collection and connector
target pair before projection bounds. `projected` equals `connectors.length`,
and `truncated` is true exactly when `total > projected`. No result is claimed
for omitted pairs, and human-readable health output must not report connector
proof as healthy while the projection is truncated.

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

**Config Shape (`index.yml`):**

```yaml
version: "1.0"
ftsTokenizer: snowball english
editorUriTemplate: "vscode://file/{path}:{line}:{col}"
collections:
  - name: notes
    path: /Users/you/notes
    pattern: "**/*"
    include: []
    exclude: [.git, node_modules]
    updateCmd: git pull
    languageHint: en
    models:
      embed: file:/models/embed.gguf
contexts:
  - scopeType: global
    scopeKey: /
    text: Shared retrieval context
models:
  activePreset: slim-tuned
contentTypes:
  - id: person
    prefixes: [people/, contacts/]
    preset: person
    graphHints: [mentions, works_at]
    searchBoost: 1.15
  - id: meeting
    prefixes: [meetings/]
    preset: meeting
    temporal: true
```

`contentTypes` is optional and defaults to `[]`. It is schema-lite and opt-in:
Zod validates `id`, `prefixes`, `preset`, `graphHints`, `searchBoost`, and
`temporal`, while `preset` remains a permissive string. Post-parse normalization
warns and drops unknown preset references, dedupes exact duplicate prefixes,
retains overlapping prefixes, and sorts rules longest-prefix-first. `searchBoost`
is accepted but currently no-op. `graphHints` is active: ordered hints type
projected wiki/markdown edges and surface in graph traversal/diagnose metadata.

---

### gno collection add

Add a new collection to the index.

**Synopsis:**

```bash
gno collection add <path> --name <name> [--pattern <glob>] [--include <csv-ext>] [--exclude <csv>] [--update <cmd>] [--embed-model <uri>] [--language <code>]
```

**Arguments:**
| Arg | Type | Description |
|-----|------|-------------|
| `<path>` | string | Absolute path to collection root directory |

**Options:**

| Option          | Type   | Default                                    | Description                                          |
| --------------- | ------ | ------------------------------------------ | ---------------------------------------------------- |
| `--name`        | string | required                                   | Unique collection identifier                         |
| `--pattern`     | glob   | `**/*`                                     | File matching glob pattern                           |
| `--include`     | csv    | -                                          | Extension allowlist                                  |
| `--exclude`     | csv    | `.git,node_modules,.venv,.idea,dist,build` | Exclude patterns                                     |
| `--update`      | string | -                                          | Shell command to run before indexing                 |
| `--embed-model` | string | -                                          | Initial collection-specific embedding model override |
| `--language`    | string | -                                          | BCP-47 language hint (e.g., en, de, zh-CN)           |

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

---

### gno collection clear-embeddings

Clear embeddings for one collection.

**Synopsis:**

```bash
gno collection clear-embeddings <name> [--all] [--json]
```

**Arguments:**
| Arg | Type | Description |
|-----|------|-------------|
| `<name>` | string | Collection name |

**Options:**

| Option   | Type    | Default | Description                                                                  |
| -------- | ------- | ------- | ---------------------------------------------------------------------------- |
| `--all`  | boolean | false   | Remove all embeddings for the collection (default only removes stale models) |
| `--json` | boolean | false   | JSON output                                                                  |

**Behavior:**

- default mode is `stale`
- `stale` removes embeddings for models that are not the current embed model for that collection
- `all` removes every embedding for that collection and requires a new `gno embed --collection <name>` run
- embeddings shared by active documents in other collections are retained

---

### gno embed

Generate embeddings for indexed chunks.

**Synopsis:**

```bash
gno embed [collection] [--collection <name>] [--force] [--model <uri>] [--batch-size <n>] [--dry-run] [--yes] [--json]
```

**Arguments:**
| Arg | Type | Description |
|-----|------|-------------|
| `[collection]` | string | Optional collection name shortcut |

**Behavior note:**

- `[collection]` and `--collection <name>` are aliases
- if provided, embedding work is scoped to that collection only

````

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
````

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

# Debug embedding errors
gno index --verbose
```

**Verbose Mode:**

With `--verbose`, embedding errors during the embed phase are logged to stderr (see `gno embed`).

---

### gno embed

Generate embeddings for chunks without vectors.

On CPU-only machines, implementations may use multiple embedding contexts
internally to improve throughput, and may fall back to fewer contexts if
memory pressure prevents creating the full pool.

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

**Verbose Mode:**

With `--verbose`, embedding errors are logged to stderr:

```
[embed] Batch failed: <error message>
[embed] Count mismatch: got X, expected Y
[embed] Store failed: <error message>
```

---

### Retrieval trace receipts

When local retrieval tracing is enabled, successful `search`, `vsearch`,
`query`, `ask`, `get`, and `context build` commands write one
`Trace: <traceId>` receipt line to stderr after the normal result. Stdout and
all JSON/Markdown/file payload schemas remain byte-for-byte unchanged.
Retrieval-only commands leave the trace open for explicit evidence follow-up.
Pass that receipt back to `gno get --trace-id <traceId>` to record the exact
opened line range against the same query. Disabled tracing performs no trace
ID, fingerprint, or receipt work and writes no receipt line.

Trace management remains available for already-stored receipts after recording
is disabled:

```text
gno trace list [-n <limit>] [--cursor <cursor>] [--json|--md]
gno trace show <trace-id> [--detail-limit <limit>] [--json|--md]
gno trace label <trace-id> --label <relevant|irrelevant|missing-expected> --target <ref>
  [--target-kind <document|chunk|span>] [--from-line <line> --to-line <line>]
  [--source-hash <sha256>] [--docid <docid>] [--idempotency-key <key>] [--json|--md]
gno trace export <trace-id...> [--format <agentic-receipt|qrels>] [--output <path>] [--json]
gno trace replay <qrels-export-id> --candidate <bm25|vector|hybrid>
  [-n <limit>] [--candidate-limit <limit>] [--no-expand] [--no-rerank] [--json|--md]
gno trace delete <trace-id> [--json|--md]
gno --yes trace purge [--json|--md]
```

`list` is newest-first, cursor-paginated, and never returns raw replay queries
or goals. `show` returns one bounded detail receipt with exact per-section
totals and truncation flags. A relevant or irrelevant label must resolve to
recorded evidence; `missing-expected` accepts only a content-free `gno://` URI,
docid, or immutable source hash. Labels are append-only and retry-safe.

`export` accepts one or more immutable terminal traces and sorts and
deduplicates their IDs. The default deterministic `agentic-receipt` artifact
preserves the complete stored receipt. `--format qrels` requires replay-mode
receipts with an exact query, strict filters, ranked evidence, and at least one
explicit relevant or missing-expected judgment. It exports only hashes,
coordinates, ranks, capabilities, fallbacks, and explicit outcomes—never
source or mirror text. Both formats reject open or missing traces.
`completed`, `partial`, `failed`, and `cancelled` remain distinct; no terminal
state implies negative relevance.

`replay` verifies the saved qrels aggregate manifest and reruns only the named
candidate against the current local index. It compares final and planner ranks,
coverage, explicit open/cite/pin outcomes, capability fallbacks, fingerprints,
and unchanged/stale/missing source state. The result is
`improved|unchanged|regressed|unreplayable` with a human promotion
recommendation and `applied: false`; replay never changes configuration,
boosts, prompts, models, traces, or user files. Missing or cascaded manifest
links and changed source hashes fail closed instead of becoming an empty
successful run.
Without `--output`, JSON is the complete `retrieval-trace-export` receipt.
`--output` writes only the canonical artifact atomically and intentionally
emits no stdout. Full purge requires the global `--yes` flag and reports
whether SQLite/WAL physical cleanup completed, remained busy, or failed.

Structured outputs validate against
`retrieval-trace-{list,show,judgment,export,qrels,replay,delete,purge}.schema.json`;
file-only `trace export --output` is the documented exception.

---

### gno search

BM25 keyword search over indexed documents.

**Synopsis:**

```bash
gno search <query> [-n <num>] [--min-score <num>] [-c <collection>] [--since <date>] [--until <date>] [--category <values>] [--author <text>] [--intent <text>] [--exclude <values>] [--tags-all <tags>] [--tags-any <tags>] [--full] [--line-numbers] [--lang <bcp47>] [--json|--files|--csv|--md|--xml]
```

**Arguments:**
| Arg | Type | Description |
|-----|------|-------------|
| `<query>` | string | Search query |

**Options:**

| Option                  | Type     | Default                   | Description                                                                                   |
| ----------------------- | -------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| `-n`                    | integer  | 5 (20 for --json/--files) | Max results                                                                                   |
| `--min-score`           | number   | 0                         | Minimum score threshold                                                                       |
| `-c, --collection`      | string   | all                       | Filter to collection                                                                          |
| `--since`               | string   | none                      | Modified-at lower bound (ISO date/time or relative token)                                     |
| `--until`               | string   | none                      | Modified-at upper bound (ISO date/time or relative token)                                     |
| `--category`            | string   | none                      | Filter to docs with matching category/content type (comma-separated)                          |
| `--author`              | string   | none                      | Filter to docs where author contains value (case-insensitive)                                 |
| `--intent`              | string   | none                      | Disambiguating context for ambiguous queries; steers snippets without being searched directly |
| `--exclude`             | string   | none                      | Hard-prune docs containing any comma-separated term in title/path/body                        |
| `--tags-all`            | string   | none                      | Filter to docs with ALL tags (comma-separated)                                                |
| `--tags-any`            | string   | none                      | Filter to docs with ANY tag (comma-separated)                                                 |
| `--project-root`        | string[] | cwd                       | Trusted project root; repeatable, replaces default cwd/repository affinity                    |
| `--no-project-affinity` | boolean  | false                     | Disable project-aware soft ranking; invalid with `--project-root`                             |
| `--full`                | boolean  | false                     | Include full mirror content instead of snippet                                                |
| `--line-numbers`        | boolean  | false                     | Include line numbers in output                                                                |
| `--lang`                | string   | auto                      | Language filter/hint (BCP-47)                                                                 |

**Scoring:**

Scores are normalized per query to a 0-1 range using min-max scaling:

- `1.0` = best match among returned results
- `0.0` = worst match among returned results

Important notes:

- Scores are **relative within a single query's result set**, not comparable across different queries
- `--min-score` filters based on this normalized score (e.g., `--min-score 0.5` keeps top half)
- Raw SQLite FTS5 BM25 scores vary with corpus size; normalization ensures consistent UX
- When all results have equal raw scores, they all receive `1.0`
- Queries with explicit recency intent (`latest`, `newest`, `recent`) are ordered newest-first using canonical frontmatter date when present, falling back to source modified time.

**Lexical query semantics:**

- plain terms use prefix matching
- quoted phrases are supported
- negation is supported only when at least one positive term exists
- hyphenated compounds such as `real-time`, `gpt-4`, and `DEC-0054` are handled intentionally
- malformed lexical syntax returns exit code `1`

**Output (JSON):**
See [Output Schemas](./output-schemas/search-result.schema.json)

Every structured search result may include `context`, the matching
user-configured guidance joined in deterministic global, collection, then
broad-to-specific path-prefix order. The field is absent when no scope matches;
`uri` and `docid` remain the exact source identity. The same contract applies to
`vsearch`, `query`, and the `results` array returned by `ask`.

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
gno vsearch <query> [-n <num>] [--min-score <num>] [-c <collection>] [--since <date>] [--until <date>] [--category <values>] [--author <text>] [--intent <text>] [--exclude <values>] [--tags-all <tags>] [--tags-any <tags>] [--full] [--line-numbers] [--lang <bcp47>] [--json|--files|--csv|--md|--xml]
```

**Options:** Same as `gno search` (including temporal/category/author, tag, and
project-affinity controls).

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
gno query <query> [-n <num>] [--min-score <num>] [-c <collection>] [--since <date>] [--until <date>] [--category <values>] [--author <text>] [--intent <text>] [--exclude <values>] [-C <num>] [--tags-all <tags>] [--tags-any <tags>] [--full] [--line-numbers] [--lang <bcp47>] [--no-expand] [--no-rerank] [--graph] [--no-graph] [--query-mode <mode:text>]... [--explain] [--json|--files|--csv|--md|--xml]
gno query diagnose <query> --target <doc> [-n <num>] [--min-score <num>] [-c <collection>] [--since <date>] [--until <date>] [--category <values>] [--author <text>] [--intent <text>] [--exclude <values>] [-C <num>] [--tags-all <tags>] [--tags-any <tags>] [--lang <bcp47>] [--no-expand] [--no-rerank] [--graph] [--no-graph] [--json]
```

**Options:** Same as `gno search`, plus:

**Additional Options:**
| Option | Type | Description |
|--------|------|-------------|
| `--no-expand` | boolean | Disable query expansion |
| `--no-rerank` | boolean | Disable cross-encoder reranking |
| `--graph` | boolean | Enable bounded one-hop graph neighbor expansion |
| `--no-graph` | boolean | Compatibility no-op; graph expansion is off unless `--graph` is passed |
| `--intent` | string | Disambiguating context for ambiguous queries; steers expansion, rerank chunk/snippet choice, and disables strong-signal bypass without being searched directly |
| `--exclude` | string | Hard-prune docs containing any comma-separated term in title/path/body |
| `-C, --candidate-limit` | integer | Max candidates passed to reranking (default 20) |
| `--query-mode` | string[] | Structured mode entry (`term:<text>`, `intent:<text>`, `hyde:<text>`). Repeatable. |
| `--explain` | boolean | Print retrieval explanation to stderr |
| `--target` | ref | Required for `query diagnose`; target document to diagnose |

`query diagnose` accepts the same `--project-root` and
`--no-project-affinity` controls as `query`.

**Compatibility / Migration:**

- Legacy query invocations remain valid (`gno query "<text>"`, `--fast`, `--thorough`, `--no-expand`, `--no-rerank`).
- `--fast` skips query expansion and reranking. Graph expansion is already off unless `--graph` is passed.
- `--intent` is orthogonal to `--query-mode`: intent steers scoring/prompting, while query modes inject caller-provided retrieval expansions.
- `--query-mode` is optional and additive to the command surface.
- If one or more `--query-mode` entries are provided, generated expansion is bypassed and provided entries are used as retrieval intents.
- By default, `gno query` does not expand through the document graph. Use `--graph` to add a capped one-hop graph-neighbor candidate set after BM25/vector retrieval. Explicit links are weighted above inferred, ambiguous, or similarity edges.

**Diagnose Output:**

`gno query diagnose` wraps the shared `diagnoseQueryTarget()` core and emits
`query-diagnose.schema.json` for `--json`. The payload requires
`schemaVersion: "1.0"`, resolves the target first, reports `target.status`
(`not_found|inactive|no_indexed_content|filtered_out|diagnosed`), and only runs
stage tracing for `diagnosed` targets. Stages report
`present`, `rank`, `score`, `survived`, `dropReason`, `status`, and
`sourceCount` across BM25, vector, fusion, graph, and rerank. BM25-only mode
marks vector/rerank skipped when unavailable or disabled, but fusion remains
active with `sourceCount: 1`.

**Explain Output (stderr):**

```
[explain] expansion: enabled (3 lexical, 2 semantic variants)
[explain] bm25: 45 candidates
[explain] vector: 38 candidates
[explain] graph: seeds=5, candidates=4/20, explicit=3, inferred=1, ambiguous=0, similarity=0
[explain] fusion: RRF k=60, 52 unique candidates
[explain] rerank: top 20 reranked
[explain] result 1: score=0.92 (bm25=0.85, vec=0.78, rerank=0.95)
```

**Exit Codes:**

- 0: Success (degrades gracefully if vectors unavailable)
- 1: Invalid options
- 2: DB or model failure

---

### gno bench

Run retrieval quality benchmarks against an already indexed GNO corpus.

**Synopsis:**

```bash
gno bench <fixture.json> [-c <collection>] [-k <num>] [--mode <name>]... [-C <num>] [--json]
```

**Fixture schema:** [`spec/bench-fixture.schema.json`](./bench-fixture.schema.json)

**JSON output schema:** [`spec/output-schemas/bench-result.schema.json`](./output-schemas/bench-result.schema.json)

**Options:**

| Option                  | Type     | Description                                                                                     |
| ----------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `-c, --collection`      | string   | Override fixture/query collection                                                               |
| `-k, --top-k`           | integer  | Override top-k cutoff used for Precision@K, Recall@K, F1@K, MRR, and nDCG@K                     |
| `--mode`                | string[] | Override fixture modes. Repeatable: `bm25`, `vector`, `hybrid`, `fast`, `no-rerank`, `thorough` |
| `-C, --candidate-limit` | integer  | Override candidate limit for hybrid/rerank modes                                                |
| `--json`                | boolean  | Emit structured benchmark result                                                                |

Fixtures support:

- `version: 1`
- optional `metadata`, `collection`, `topK`, `candidateLimit`
- `modes` as aliases or objects with `type`, `noExpand`, `noRerank`, `candidateLimit`, `limit`, and `queryModes`
- `queries[]` with `id`, `query`, expected documents/URIs, optional `collection`, optional `topK`, optional `queryModes`, and optional graded `judgments`

Metrics reported per mode and per query:

- `precisionAtK`
- `recallAtK`
- `f1AtK`
- `mrr`
- `ndcgAtK`
- latency summaries (`p50Ms`, `p95Ms`, `meanMs`)

**Exit Codes:**

- 0: Fixture loaded and benchmark ran
- 1: Invalid fixture, mode, or options
- 2: Runtime failure

---

### gno ask

Human-friendly query with citations-first output and optional grounded answer.

**Synopsis:**

```bash
gno ask <query> [-n <num>] [-c <collection>] [--lang <bcp47>] [--since <date>] [--until <date>] [--category <values>] [--author <text>] [--intent <text>] [--exclude <values>] [--query-mode <mode:text>]... [-C <num>] [--answer|--verify] [--no-answer] [--max-answer-tokens <n>] [--context-budget-tokens <n>] [--context-budget-bytes <n>] [--min-score <score>] [--graph] [--no-expand] [--no-rerank] [--show-sources] [--json|--md]
```

**Options:**

| Option                    | Type     | Default | Description                                                                        |
| ------------------------- | -------- | ------- | ---------------------------------------------------------------------------------- |
| `--answer`                | boolean  | false   | Generate short grounded answer                                                     |
| `--verify`                | boolean  | false   | Generate from a closed Context Capsule; verify every claim or abstain              |
| `--no-answer`             | boolean  | false   | Force retrieval-only output                                                        |
| `--max-answer-tokens`     | integer  | config  | Cap answer generation tokens                                                       |
| `--context-budget-tokens` | integer  | 12000   | Global token budget for verified Context evidence                                  |
| `--context-budget-bytes`  | integer  | none    | Optional global byte budget for verified Context evidence                          |
| `--min-score`             | number   | none    | Minimum retrieval score from 0 through 1                                           |
| `--graph`                 | boolean  | false   | Include bounded graph expansion in verified Context retrieval                      |
| `--since`                 | string   | none    | Modified-at lower bound (ISO date/time or relative token)                          |
| `--until`                 | string   | none    | Modified-at upper bound (ISO date/time or relative token)                          |
| `--category`              | string   | none    | Filter to docs with matching category/content type (comma-separated)               |
| `--author`                | string   | none    | Filter to docs where author contains value (case-insensitive)                      |
| `--intent`                | string   | none    | Disambiguating context for ambiguous questions without searching on that text      |
| `--exclude`               | string   | none    | Hard-prune docs containing any comma-separated term in title/path/body             |
| `--query-mode`            | string[] | none    | Structured mode entry (`term:<text>`, `intent:<text>`, `hyde:<text>`). Repeatable. |
| `-C, --candidate-limit`   | integer  | 20      | Max candidates passed to reranking                                                 |
| `--no-expand`             | boolean  | false   | Disable query expansion                                                            |
| `--no-rerank`             | boolean  | false   | Disable cross-encoder reranking                                                    |
| `--show-sources`          | boolean  | false   | Show all retrieved sources (not just cited)                                        |
| `--project-root`          | string[] | cwd     | Trusted project root; repeatable, replaces default cwd/repository affinity         |
| `--no-project-affinity`   | boolean  | false   | Disable project-aware soft ranking; invalid with `--project-root`                  |

**Output (JSON):**
See [Output Schemas](./output-schemas/ask.schema.json)

Notes:

- `meta.answerContext` is optional explain payload for answer source selection.
- `--verify` implies answer generation and cannot be combined with
  `--no-answer`. The JSON result adds the closed Capsule, freshness receipt,
  four-state per-claim verdicts (`supported`, `contradicted`, `insufficient`,
  `uncertain`), exact evidence IDs and line spans, coverage, gaps, semantic
  verifier state, and explicit abstention. Support below 100% never returns the
  draft answer.
- Terminal and Markdown verified output preserve the same verdicts, exact
  support/conflict spans, coverage, gaps, abstention, and capability
  degradation. With `--show-sources`, both formats list every retained Capsule
  evidence span with its exact URI and line range. JSON remains the canonical
  machine contract.
- Verification classifies support only against the closed Capsule and its
  freshness receipt. It does not guarantee corpus completeness or source truth.
  An unavailable, incapable, failed, or malformed semantic verifier cannot mark
  claims supported; unresolved substantive claims remain uncertain and force
  abstention.
- Verified retrieval records the normalized request and requested/attempted
  capability states in its Capsule. The active `--index` value is host-owned
  and used for both compilation and freshness verification.
- Strategy: adaptive coverage (relevance + query/facet coverage), not fixed top-N.
- Each result preserves optional configured `context`. Answer generation places
  that trusted configuration in a separate prompt role from untrusted retrieved
  document content.

**Exit Codes:**

- 0: Success
- 1: Invalid options
- 2: DB or model failure

**Examples:**

```bash
gno ask "how do we deploy to staging"
gno ask "termination clause" --collection work --answer
gno ask "who owns launch?" --verify --show-sources
```

---

### gno capture

Capture a note into an editable collection with structured provenance.

**Synopsis:**

```bash
gno capture [content...] [--stdin|--file <path>] [--collection <name>] [--title <title>] [--path <relPath>] [--folder <relPath>] [--preset <id>] [--tags <tags>] [--collision-policy <policy>] [--source-kind <kind>] [--source-url <url>] [--source-title <title>] [--source-author <author>] [--source-date <date>] [--source-id <id>] [--json]
```

**Content Sources:**

- Inline argument, `--stdin`, and `--file` are mutually exclusive.
- Content is required unless `--preset` can scaffold a non-empty note.
- `--preset` accepts: `blank`, `project-note`, `research-note`,
  `decision-note`, `prompt-pattern`, `source-summary`, `idea-original`,
  `person`, `company-project`, `meeting`.
- `--json` wins over global `--quiet`; quiet prints only the created/opened URI.

**Provenance:**

Capture writes structured `source:` frontmatter and returns the shared
[`capture-receipt`](./output-schemas/capture-receipt.schema.json). `--source-date`
maps to `source.observedAt`; `--source-id` maps to `source.externalId`.

**Path and Collision Rules:**

- Explicit `--path` wins.
- Without `--path`, `--folder`/`--title` produce a safe markdown filename.
- Without path, folder, or title, GNO writes to
  `inbox/YYYY-MM-DD/capture-<body-hash>.md` using UTC capture time.
- Default collision policy is `open_existing` for generated hash paths and
  `error` for explicit/title/folder paths.
- Collision checks include indexed documents and disk-only files.
- Content must be text; NUL or binary-like control bytes are rejected.
- Capture writes use exclusive create semantics so a file that appears after
  planning is not replaced.

**Examples:**

```bash
gno capture "thought to remember"
gno capture --stdin --collection notes --preset source-summary --tags inbox,gno
gno capture --file ./clip.md --source-url https://example.com --source-kind web --json
gno capture "meeting note" --quiet
```

---

### gno get

Retrieve a single document by reference.

**Synopsis:**

```bash
gno get <ref> [--from <line>] [-l <lines>] [--line-numbers] [--trace-id <id>] [--source] [--json|--md]
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
| `--trace-id` | string | Continue an open retrieval trace and record the exact returned span |
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
gno get gno://work/doc.md --from 120 -l 50 --trace-id <traceId>
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

Configured text is returned as optional `context` on matching structured
retrieval results and is used as trusted guidance during grounded answer
generation. Matching scopes compose once in this order: global, collection,
then path prefixes from broadest to most specific. Context guides interpretation;
it is not searched and does not change ranking.

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

### gno context build

Compile exact indexed evidence into a deterministic Context Capsule. The
Capsule is returned only on stdout or at an explicitly requested output path;
the command never persists Capsules implicitly. Model and download progress is
written to stderr.

**Synopsis:**

```bash
gno context build "<goal>" --budget <tokens> [--collection <name>] [--project-root <path>]... [--no-project-affinity] [--fast|--thorough] [--json|--md] [--output <file>]
```

`--budget` is the global token ceiling. `--bytes` optionally sets a separate
byte ceiling; otherwise it is four times the token request. Without an active
token counter, `usedTokens` uses the conservative UTF-8 byte count and the
Capsule records `tokenizer_unavailable`. `--query`, `--uri-prefix`, tag,
category, author, language, date, and repeatable `--query-mode` filters use the
same canonical retrieval semantics as `gno query`. `--collection` is
repeatable. Tag filters are NFC-normalized, lowercased, deduplicated, and
validated before retrieval. Result and candidate limits are global across
repeated collections: the merged result pool is capped once, while candidate
work is distributed deterministically in canonical collection order.
Project affinity defaults to the trusted process cwd/repository. Repeatable
`--project-root` values replace that default, are normalized/deduplicated, and
are capped at 16. `--no-project-affinity` disables the soft signal and cannot
be combined with explicit roots.

JSON is the canonical V1 payload. Markdown is a readable projection of that
same payload and hard-delimits each untrusted evidence passage. Passage,
metadata, manifest, and verification-receipt blocks use deterministic
collision-resistant Markdown fences: the fence character and width are derived
from the complete block, so indexed text cannot forge a closing boundary.
Indexed title, heading, and configured-context metadata remains JSON-escaped;
exact passage bytes remain unchanged inside the fence. Budgets, normalized
retrieval requests, capability attempts/outcomes, fingerprints, snapshots,
fallbacks, omissions, and truncation remain auditable.
An enabled retrieval trace links the request to `capsuleId` in local trace
storage and returns its random identity only on stderr. The trace identity is
never added to the canonical Capsule, its budget, or its deterministic ID.
Invalid goals,
budgets, filters, URI/index combinations, or output paths exit 1. Snapshot,
retrieval, provenance, and store failures exit 2 with no partial Capsule.
Requested collections must exist in the active configuration before retrieval.

### gno context verify

Verify a saved canonical JSON Capsule without rebuilding or mutating it.

**Synopsis:**

```bash
gno context verify <file|-> [--json|--md] [--output <file>]
```

`-` reads stdin. Verification re-resolves exact source, mirror, chunk, passage,
and index state. Without a live rank resolver, ranking is reported as
`ranking_unavailable`; stale or missing evidence is never reported as ranked.
JSON uses the canonical verification schema. Markdown projects the same receipt,
including fingerprint drift and every available current hash. Non-canonical
metadata and invalid identity/budget data fail before the store is read.
When global `--index` is omitted, the Capsule scope selects the index. An
explicit global `--index` must match the Capsule scope; mismatch fails before a
store is opened. Active-tokenizer Capsules require the matching tokenizer
fingerprint and deterministic recount callback before any store read; CLI
runtimes without that tokenizer fail with `tokenizer_unavailable` rather than
trusting saved `usedTokens`.

### gno context watch / watches / unwatch / reverify

Register an explicit canonical JSON Capsule file for local, evidence-triggered
reverification:

```bash
gno context watch <file> [--question <text>] [--label <text>] [--notify] [--json]
gno context watches [--json]
gno context unwatch <registration> [--json]
gno context reverify <registration> [--json]
```

The registration persists only the absolute file path, exact file hash,
Capsule/index identity, optional question and label, notification preference,
and evidence URI/hash references. Capsule bytes and evidence passages are never
copied into the database. The file remains caller-owned and immutable to GNO.
The Capsule's canonical index is authoritative when `watch` is invoked without
an explicit global `--index`; an explicit mismatch fails before journal or
evidence reads.

A resident `serve` or `daemon` runtime reverifies affected registrations after
watcher work has settled. Raw journal changes are coalesced, one bounded
reverification batch runs at a time, and the durable journal high-water mark
prevents duplicate work after restart. An expired journal cursor triggers a
conservative bounded pass over all registrations. Reverification uses the
canonical `context verify` receipt. Operation failures are stored separately
and never synthesized into a receipt.

`--notify` enables local metadata-only `capsule-reverified` events after the
verification record commits. Events contain registration/Capsule identity,
operation status, affected-question state, and timestamp; they contain no
question, file path, URI, passage, Capsule, or receipt bytes. `context
reverify` performs the same non-generative verification immediately.

`context reverify` exits `0` only when `operationStatus` is `completed`. A
persisted `failed` operation is still rendered: terminal output includes the
failure code and message, while `--json` writes the closed structured
reverification object to stdout. The command then exits `2`; the structured
failure must never be mistaken for a successful verification receipt.

JSON contracts are Draft-07 and closed:

- `watch`: `saved-capsule-watch.schema.json`; the initial verification is null.
- `watches`: `saved-capsule-list.schema.json`.
- `unwatch`: `saved-capsule-unwatch.schema.json`.
- `reverify`: `saved-capsule-reverification.schema.json`; a completed
  canonical receipt and a failed operation record are mutually exclusive.
- local SSE notification data: `capsule-reverified-event.schema.json`.

These registration-management surfaces are CLI-only. REST, MCP, and SDK expose
the non-persistent `context verify` operation, not watch lifecycle mutations.

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
  "activePreset": "slim",
  "presets": [
    { "id": "slim", "name": "Slim (Default, ~1GB)", "active": true },
    { "id": "balanced", "name": "Balanced (~2GB)", "active": false },
    {
      "id": "quality",
      "name": "Quality (Best Answers, ~2.5GB)",
      "active": false
    }
  ],
  "embed": {
    "uri": "hf:gpustack/bge-m3-GGUF/bge-m3-Q4_K_M.gguf",
    "cached": true
  },
  "rerank": {
    "uri": "hf:gpustack/bge-reranker-v2-m3-GGUF/bge-reranker-v2-m3-Q4_K_M.gguf",
    "cached": false
  },
  "gen": {
    "uri": "hf:unsloth/Qwen3-1.7B-GGUF/Qwen3-1.7B-Q4_K_M.gguf",
    "cached": true
  }
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
| `slim` | Qwen3-1.7B | ~1GB | Default, fast queries |
| `balanced` | Qwen2.5-3B-Instruct | ~2GB | Slightly larger model |
| `quality` | Qwen3-4B-Instruct | ~2.5GB | Best grounded answers |

**Exit Codes:**

- 0: Success
- 1: Unknown preset

**Behavior note:**

- if the preset switch changes the active embedding model, terminal output should
  tell the user to run `gno embed`

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

### gno publish export

Build a reader-safe gno.sh artifact from one active collection or document.

**Synopsis:**

```bash
gno publish export <target> \
  [--out <path>] \
  [--visibility public|secret-link|invite-only|encrypted] \
  [--passphrase <value>] \
  [--slug <slug>] \
  [--title <title>] \
  [--summary <summary>] \
  [--preview] \
  [--json]
```

Public V1 spaces MUST carry a `manifest` conforming to
[`publish-artifact.schema.json`](./output-schemas/publish-artifact.schema.json).
The manifest contains schema version `1.0`, a deterministic projection
revision, generated time, closed public capabilities, sorted published
documents, relative Markdown locators, SHA-256 content hashes, and
Capsule-compatible evidence identities. Manifest hashes and revisions MUST be
derived only from sanitized notes and metadata present in the published
projection. Local collection paths, document source URIs, unpublished
documents, and filtered metadata MUST NOT enter artifact bytes or revision
inputs. Reader metadata values containing embedded local path or GNO/file URI
tokens MUST be filtered. Canonical and image metadata MUST contain
uncredentialed public HTTP(S) targets; local hostnames and literal loopback,
private, or link-local addresses MUST be filtered.

Secret-link and invite-only V1 spaces MUST NOT contain a manifest or agent
capability field. Encrypted V2 spaces MUST contain only ciphertext parameters,
the opaque secret token, route slug, source type, and encrypted visibility; no
plaintext manifest or evidence may appear outside the ciphertext. V2 builders
MUST emit a closed projection, validate payload strings as non-empty bounded
base64, require a positive safe-integer KDF iteration count, and bound the
non-blank opaque token. Caller-supplied extension fields MUST NOT enter the
artifact.

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
    {
      "name": "config",
      "status": "ok",
      "message": "Config loaded: ~/.config/gno/config.yaml"
    },
    {
      "name": "database",
      "status": "ok",
      "message": "Database found: ~/.local/share/gno/index.db"
    },
    { "name": "embed-model", "status": "ok", "message": "embed model cached" },
    {
      "name": "rerank-model",
      "status": "warn",
      "message": "rerank model not cached. Run: gno models pull --rerank"
    },
    { "name": "gen-model", "status": "ok", "message": "gen model cached" },
    {
      "name": "node-llama-cpp",
      "status": "ok",
      "message": "node-llama-cpp loaded successfully"
    },
    {
      "name": "embedding-fingerprint",
      "status": "warn",
      "message": "current abc123def456, 12 pending/stale, 3 legacy, 2 groups",
      "details": [
        "Run: gno embed",
        "If vectors still look stale, run: gno embed --force"
      ],
      "embeddingFingerprint": {
        "model": "hf:Qwen/Qwen3-Embedding-0.6B-GGUF:Qwen3-Embedding-0.6B-Q8_0.gguf",
        "currentFingerprint": "abc123def4567890",
        "pendingChunks": 12,
        "legacyChunks": 3,
        "mixedGroups": 2,
        "groups": [
          {
            "model": "hf:Qwen/Qwen3-Embedding-0.6B-GGUF:Qwen3-Embedding-0.6B-Q8_0.gguf",
            "fingerprint": "abc123def4567890",
            "count": 42,
            "current": true,
            "legacy": false
          }
        ]
      }
    }
  ]
}
```

The `embedding-fingerprint` check is additive doctor-only diagnostics. It uses
the active embed model and stored vector dimensions to report the current
freshness fingerprint, pending/stale chunks, legacy empty-fingerprint vectors,
and stored fingerprint groups. Stale, legacy, and mixed groups are warnings;
recover with `gno embed`, or `gno embed --force` if vectors still look stale.

The additive `activation` object uses the same contract as `gno status` and
`GET /api/status`. Doctor performs only the local lexical proof. It never starts
connector children or initializes/downloads models. A failed lexical proof adds
the `retrieval-activation` error check and exits 2 after writing the complete
result; no duplicate error is written to stderr. Connector failure or projection
truncation adds a warning and makes the structured doctor result non-healthy,
but preserves exit 0 when lexical proof and all other required checks pass. An
omitted target/collection pair has no inferred result.

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

| Option      | Type    | Default        | Description                                               |
| ----------- | ------- | -------------- | --------------------------------------------------------- |
| `--target`  | string  | claude-desktop | Target client (see table below)                           |
| `--scope`   | string  | target default | Scope: `user` or `project`; LibreChat defaults to project |
| `--force`   | boolean | false          | Overwrite existing gno configuration                      |
| `--dry-run` | boolean | false          | Show what would be done without changes                   |

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
| codex          | user    | `~/.codex/config.toml`                                            | `~/.codex/config.toml`                        | `~/.codex/config.toml`                        |
| codex          | project | `./.codex/config.toml`                                            | `./.codex/config.toml`                        | `./.codex/config.toml`                        |
| cursor         | user    | `~/.cursor/mcp.json`                                              | `~/.cursor/mcp.json`                          | `~/.cursor/mcp.json`                          |
| cursor         | project | `./.cursor/mcp.json`                                              | `./.cursor/mcp.json`                          | `./.cursor/mcp.json`                          |
| zed            | user    | `~/.config/zed/settings.json`                                     | `%APPDATA%\Zed\settings.json`                 | `~/.config/zed/settings.json`                 |
| windsurf       | user    | `~/.codeium/windsurf/mcp_config.json`                             | `~/.codeium/windsurf/mcp_config.json`         | `~/.codeium/windsurf/mcp_config.json`         |
| opencode       | user    | `~/.config/opencode/opencode.json`                                | `~/.config/opencode/opencode.json`            | `~/.config/opencode/opencode.json`            |
| opencode       | project | `./opencode.json`                                                 | `./opencode.json`                             | `./opencode.json`                             |
| amp            | user    | `~/.config/amp/settings.json`                                     | `~/.config/amp/settings.json`                 | `~/.config/amp/settings.json`                 |
| lmstudio       | user    | `~/.lmstudio/mcp.json`                                            | `~/.lmstudio/mcp.json`                        | `~/.lmstudio/mcp.json`                        |
| librechat      | project | `./librechat.yaml`                                                | `./librechat.yaml`                            | `./librechat.yaml`                            |

**Config Formats:**

- JSONC-compatible (`mcpServers` key): Claude Desktop, Claude Code, Cursor, Windsurf, LM Studio
- Standard YAML (`mcpServers` key): LibreChat
- Codex TOML: `[mcp_servers.gno]` plus `[mcp_servers.gno.env]`
- Zed: `context_servers` key
- OpenCode: `mcp` key with array command format
- Amp: `amp.mcpServers` key

JSON/JSONC edits preserve comments, trailing commas, and unrelated layout.
OpenCode and Amp discover an existing `.jsonc` alternate instead of creating a
duplicate canonical `.json` file.

`--dry-run --json` reports the normalized command, arguments, and workspace
environment, not the target's persisted wrapper shape. Previewing replacement
of an existing `gno` entry requires `--force --dry-run --json`; no file is
written in dry-run mode.

**Behavior:**

1. Resolves the active index and validates it with the shared index-name contract
2. Resolves the active explicit, environment-selected, or default config to an absolute path
3. Builds an absolute command using the current Bun executable, `run`, and the current package's `src/index.ts`
4. Appends `--index <active> --config <absolute> mcp` (`--enable-write` follows `mcp` when requested)
5. Resolves absolute `GNO_DATA_DIR` and `GNO_CACHE_DIR` values for the active workspace
6. Reads existing config (creates if missing)
7. Adds the format-specific `gno` server entry, using `env` for standard/Codex/YAML entries and `environment` for OpenCode
8. Creates a backup before modifying
9. Writes atomically via temp file + rename

The persisted index, config, data directory, and cache directory are workspace
identity, not display metadata. They make the installed GUI client deterministic
even when it has a different `PATH` or does not inherit `GNO_*` variables. Only
the two audited absolute-path environment keys are persisted; status and
activation reject other environment keys or invalid values.

**Output (JSON):**

```json
{
  "installed": {
    "target": "claude-desktop",
    "scope": "user",
    "configPath": "~/Library/Application Support/Claude/claude_desktop_config.json",
    "action": "created",
    "serverEntry": {
      "command": "/path/to/bun",
      "args": [
        "run",
        "/path/to/@gmickel/gno/src/index.ts",
        "--index",
        "default",
        "--config",
        "/absolute/path/to/index.yml",
        "mcp"
      ],
      "env": {
        "GNO_DATA_DIR": "/absolute/path/to/data",
        "GNO_CACHE_DIR": "/absolute/path/to/cache"
      }
    }
  }
}
```

**Exit Codes:**

- 0: Success
- 1: Already configured (without --force), invalid scope for target, invalid index name
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

| Option     | Type   | Default        | Description                          |
| ---------- | ------ | -------------- | ------------------------------------ |
| `--target` | string | claude-desktop | Target client                        |
| `--scope`  | string | target default | Scope; LibreChat defaults to project |

**Behavior:**

1. Reads existing config
2. Removes the format-specific GNO entry if present (`mcpServers.gno`,
   `context_servers.gno`, `mcp.gno`, `amp.mcpServers.gno`, or Codex's
   `[mcp_servers.gno]` plus `[mcp_servers.gno.env]` tables)
3. Creates backup before modifying
4. Removes an empty format-specific server object; Codex preserves unrelated
   TOML and comments byte-for-byte apart from necessary surrounding whitespace
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

**Output (Terminal, abbreviated; unfiltered status enumerates 14 target/scope
pairs):**

```text
MCP Server Status
──────────────────────────────────────────────────

✓ Claude Desktop: configured
    Command: /path/to/bun
    Args: run /path/to/@gmickel/gno/src/index.ts --index default --config /absolute/path/to/index.yml mcp
    Config: ~/Library/Application Support/Claude/claude_desktop_config.json

✗ Claude Code: not configured
    Config: ~/.claude.json

✗ Claude Code (project): not configured
    Config: ./.mcp.json

1/14 targets configured
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
      "serverEntry": {
        "command": "/path/to/bun",
        "args": [
          "run",
          "/path/to/@gmickel/gno/src/index.ts",
          "--index",
          "default",
          "--config",
          "/absolute/path/to/index.yml",
          "mcp"
        ],
        "env": {
          "GNO_DATA_DIR": "/absolute/path/to/data",
          "GNO_CACHE_DIR": "/absolute/path/to/cache"
        }
      }
    },
    {
      "target": "claude-code",
      "scope": "user",
      "configPath": "~/.claude.json",
      "configured": false
    }
  ],
  "summary": { "configured": 1, "total": 14 }
}
```

**Exit Codes:**

- 0: Success
- 1: Invalid target or scope
- 2: IO failure

---

### gno skill install

Install GNO agent skill for Claude Code, Codex, OpenCode, OpenClaw, or Hermes.

**Synopsis:**

```bash
gno skill install [--scope <project|user>] [--target <claude|codex|opencode|openclaw|hermes|all>] [--force] [--json]
```

**Options:**

| Option     | Type    | Default | Description                                                   |
| ---------- | ------- | ------- | ------------------------------------------------------------- |
| `--scope`  | string  | project | `project` (.claude/skills/) or `user` (~/.claude/skills/)     |
| `--target` | string  | claude  | `claude`, `codex`, `opencode`, `openclaw`, `hermes`, or `all` |
| `--force`  | boolean | false   | Overwrite existing skill without prompting                    |

**Behavior:**

1. Resolves target path based on scope and target
2. If skill exists and not `--force`/`--yes`: error
3. Atomically installs skill directory (temp + rename)
4. Copies SKILL.md, reference files, and nested recipe files

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
gno skill uninstall [--scope <project|user>] [--target <claude|codex|opencode|openclaw|hermes|all>] [--json]
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
gno skill show [--file <relative-md-path>] [--all]
```

**Options:**

| Option   | Type    | Default  | Description                                                                                       |
| -------- | ------- | -------- | ------------------------------------------------------------------------------------------------- |
| `--file` | string  | SKILL.md | Relative POSIX markdown path to show, including nested paths like `recipes/brain-first-lookup.md` |
| `--all`  | boolean | false    | Show all skill markdown files with separators                                                     |

**Behavior:**

- Outputs file content to stdout
- Lists available files at end
- Recursively lists bundled markdown files under the skill asset directory
- Rejects absolute paths, `..`, backslashes, and non-markdown file paths

**Exit Codes:**

- 0: Success
- 1: Invalid file name

**Examples:**

```bash
gno skill show
gno skill show --file cli-reference.md
gno skill show --file recipes/brain-first-lookup.md
gno skill show --all
```

---

### gno skill paths

Show resolved skill installation paths.

**Synopsis:**

```bash
gno skill paths [--scope <project|user>] [--target <claude|codex|opencode|openclaw|hermes|all>] [--json]
```

**Options:** Same as `skill install`

**Output (JSON):**

```json
{
  "paths": [
    {
      "target": "claude",
      "scope": "project",
      "path": "/path/to/.claude/skills/gno",
      "exists": false
    },
    {
      "target": "claude",
      "scope": "user",
      "path": "/home/user/.claude/skills/gno",
      "exists": true
    }
  ]
}
```

**Exit Codes:**

- 0: Success

---

### gno tags list

List all tags with document counts.

**Synopsis:**

```bash
gno tags [list] [-c, --collection <name>] [--prefix <prefix>] [--json] [--md]
```

**Options:**

| Option             | Type   | Description               |
| ------------------ | ------ | ------------------------- |
| `-c, --collection` | string | Filter by collection name |
| `--prefix`         | string | Filter by tag prefix      |
| `--json`           | flag   | JSON output               |
| `--md`             | flag   | Markdown output           |

**Output (JSON):**

```json
{
  "tags": [
    { "tag": "javascript", "count": 15 },
    { "tag": "python", "count": 8 }
  ],
  "meta": {
    "total": 25,
    "collection": "notes",
    "prefix": "java"
  }
}
```

**Exit Codes:**

- 0: Success

---

### gno tags add

Add a tag to a document.

**Synopsis:**

```bash
gno tags add <doc> <tag> [--json]
```

**Arguments:**

- `<doc>` - Document reference (docid or URI)
- `<tag>` - Tag to add (normalized to lowercase)

**Options:**

| Option   | Type | Description |
| -------- | ---- | ----------- |
| `--json` | flag | JSON output |

**Behavior:**

- Validates tag format (lowercase alphanumeric with hyphens/dots/slashes)
- Adds tag to document in database with source='user'
- For markdown files, also updates frontmatter tags
- Idempotent: succeeds if tag already exists

**Output (JSON):**

```json
{
  "docid": "abc123",
  "tag": "javascript",
  "wroteToFile": true
}
```

**Exit Codes:**

- 0: Success
- 1: Invalid tag format or document not found

---

### gno tags rm

Remove a tag from a document.

**Synopsis:**

```bash
gno tags rm <doc> <tag> [--json]
```

**Arguments:**

- `<doc>` - Document reference (docid or URI)
- `<tag>` - Tag to remove

**Options:**

| Option   | Type | Description |
| -------- | ---- | ----------- |
| `--json` | flag | JSON output |

**Behavior:**

- Removes tag from document in database
- For markdown files with frontmatter tags, also updates the file

**Output (JSON):**

```json
{
  "docid": "abc123",
  "tag": "javascript",
  "removedFromFile": true
}
```

**Exit Codes:**

- 0: Success
- 1: Tag not found on document or document not found

---

### gno links list

List outgoing links from a document.

**Synopsis:**

```bash
gno links [list] <doc> [--type <wiki|markdown>] [--edge-type <type>] [--relation <type>] [--json] [--md]
```

**Arguments:**

| Argument | Description                              |
| -------- | ---------------------------------------- |
| `<doc>`  | Document reference (docid, URI, or path) |

**Options:**

| Flag          | Type   | Description                       |
| ------------- | ------ | --------------------------------- |
| `--type`      | string | Filter positional links by syntax |
| `--edge-type` | string | Filter semantic edges by type     |
| `--relation`  | string | Alias for `--edge-type`           |
| `--json`      | flag   | JSON output                       |
| `--md`        | flag   | Markdown output                   |

**Behavior:**

- Lists all outgoing links from the document
- Shows link type (wiki or markdown), target, display text, location
- Indicates whether each link resolves to an indexed document
- Default subcommand is `list` (can be omitted)
- `--edge-type`/`--relation` switches to semantic `doc_edges` output (`edgeType`, `relationType`, `confidence`, `edgeSource`)
- `--edge-type` and `--relation` are aliases for the same semantic edge type filter; if both are supplied they must match
- `--type` cannot be combined with `--edge-type` or `--relation`

**Output (JSON):**

Schema: `links-list.schema.json`

```json
{
  "links": [
    {
      "targetRef": "Other Note",
      "linkType": "wiki",
      "linkText": "display text",
      "startLine": 10,
      "startCol": 5,
      "resolved": true,
      "resolvedDocid": "#abc123"
    }
  ],
  "meta": {
    "docid": "#def456",
    "uri": "gno://notes/source.md",
    "totalLinks": 1,
    "resolvedCount": 1
  }
}
```

**Exit Codes:**

- 0: Success
- 1: Document not found or invalid options

**Examples:**

```bash
# List all links from a document
gno links gno://notes/source.md

# Filter to wiki links only
gno links list #abc123 --type wiki

# Filter semantic relationship edges
gno links gno://notes/source.md --edge-type mentions --json
gno links gno://notes/source.md --relation mentions --json

# JSON output
gno links gno://notes/note.md --json
```

---

### gno backlinks

List documents that link to a target document.

**Synopsis:**

```bash
gno backlinks <doc> [-c, --collection <name>] [--edge-type <type>] [--relation <type>] [--json] [--md]
```

**Arguments:**

| Argument | Description                              |
| -------- | ---------------------------------------- |
| `<doc>`  | Document reference (docid, URI, or path) |

**Options:**

| Flag               | Type   | Description                       |
| ------------------ | ------ | --------------------------------- |
| `-c, --collection` | string | Filter by collection              |
| `--edge-type`      | string | Filter semantic backlinks by type |
| `--relation`       | string | Alias for `--edge-type`           |
| `--json`           | flag   | JSON output                       |
| `--md`             | flag   | Markdown output                   |

**Behavior:**

- Lists all documents that link TO the specified document
- Shows source document info, link location, and link text
- Supports both wiki and markdown link resolution
- `--edge-type`/`--relation` switches to semantic `doc_edges` backlinks (`edgeType`, `relationType`, `confidence`, `edgeSource`) while preserving `--collection`

**Output (JSON):**

Schema: `backlinks.schema.json`

```json
{
  "backlinks": [
    {
      "sourceDocid": "#abc123",
      "sourceUri": "gno://notes/source.md",
      "sourceTitle": "Source Note",
      "linkText": "link to target",
      "startLine": 15,
      "startCol": 3
    }
  ],
  "meta": {
    "docid": "#def456",
    "uri": "gno://notes/target.md",
    "totalBacklinks": 1
  }
}
```

**Exit Codes:**

- 0: Success
- 1: Document not found

**Examples:**

```bash
# List backlinks to a document
gno backlinks gno://notes/target.md

# Filter by collection
gno backlinks #abc123 --collection notes

# Filter semantic backlinks
gno backlinks gno://notes/target.md --relation related_to --json

# JSON output
gno backlinks gno://docs/api.md --json
```

---

### gno similar

Find semantically similar documents using vector embeddings.

**Synopsis:**

```bash
gno similar <doc> [-n, --limit <num>] [--threshold <num>] [--cross-collection] [--json] [--md]
```

**Arguments:**

| Argument | Description                              |
| -------- | ---------------------------------------- |
| `<doc>`  | Document reference (docid, URI, or path) |

**Options:**

| Flag                 | Type   | Default | Description                    |
| -------------------- | ------ | ------- | ------------------------------ |
| `-n, --limit`        | number | 5       | Maximum results                |
| `--threshold`        | number | 0.7     | Minimum similarity score (0-1) |
| `--cross-collection` | flag   | false   | Search across all collections  |
| `--json`             | flag   |         | JSON output                    |
| `--md`               | flag   |         | Markdown output                |

**Behavior:**

- Finds documents semantically similar to the source document
- Requires embeddings to be generated (`gno embed`)
- Uses average document embedding for comparison
- By default, limits results to same collection

**Output (JSON):**

Schema: `similar.schema.json`

```json
{
  "similar": [
    {
      "docid": "#abc123",
      "uri": "gno://notes/related.md",
      "title": "Related Note",
      "score": 0.85,
      "collection": "notes",
      "relPath": "related.md"
    }
  ],
  "meta": {
    "docid": "#def456",
    "totalResults": 1,
    "limit": 5,
    "threshold": 0.7,
    "crossCollection": false
  }
}
```

**Exit Codes:**

- 0: Success
- 1: Document not found or no embeddings
- 2: Vector search unavailable

**Examples:**

```bash
# Find similar documents
gno similar gno://notes/note.md

# Increase limit and lower threshold
gno similar #abc123 --limit 10 --threshold 0.5

# Search across all collections
gno similar gno://docs/api.md --cross-collection --json
```

---

### gno graph

Generate knowledge graph of document links.

**Synopsis:**

```bash
gno graph [-c, --collection <name>] [--limit <num>] [--edge-limit <num>] [--include-similar] [--threshold <num>] [--include-isolated] [--similar-top-k <num>] [--json]
```

**Options:**

| Flag                 | Type   | Default | Description                    |
| -------------------- | ------ | ------- | ------------------------------ |
| `-c, --collection`   | string | all     | Filter to single collection    |
| `--limit`            | number | 2000    | Maximum nodes to return        |
| `--edge-limit`       | number | 10000   | Maximum edges to return        |
| `--include-similar`  | flag   | false   | Include similarity edges       |
| `--threshold`        | number | 0.7     | Similarity threshold (0-1)     |
| `--include-isolated` | flag   | false   | Include isolated nodes         |
| `--similar-top-k`    | number | 5       | Similar docs per node (max 20) |
| `--json`             | flag   |         | JSON output                    |

**Behavior:**

- Returns nodes (documents) and links (edges) as graph data
- Includes a graph report with hubs, bridge candidates, isolated documents, unresolved links, and edge-type counts
- Edges include wiki links, markdown links, and optionally similarity edges
- Node degree reflects total unique connections (in + out)
- When collection is filtered, degree may reflect links outside the filter
- Truncates results if node/edge limits are exceeded

**Output (JSON):**

Schema: `graph.schema.json`

```json
{
  "nodes": [
    {
      "id": "#abc123",
      "uri": "gno://notes/note.md",
      "title": "My Note",
      "collection": "notes",
      "relPath": "note.md",
      "degree": 5
    }
  ],
  "links": [
    {
      "source": "#abc123",
      "target": "#def456",
      "type": "wiki",
      "weight": 1,
      "confidence": "explicit",
      "audit": { "resolution": "exact-title", "matchCount": 1 }
    }
  ],
  "report": {
    "hubs": [
      {
        "id": "#abc123",
        "uri": "gno://notes/note.md",
        "title": "My Note",
        "collection": "notes",
        "relPath": "note.md",
        "degree": 5
      }
    ],
    "bridgeCandidates": [],
    "isolated": { "total": 2, "examples": [] },
    "unresolvedLinks": {
      "total": 5,
      "byType": { "wiki": 4, "markdown": 1 }
    },
    "edgeTypes": { "wiki": 280, "markdown": 40, "similar": 0 },
    "edgeConfidence": {
      "explicit": 300,
      "inferred": 18,
      "ambiguous": 2,
      "similarity": 0
    },
    "audit": { "inferredEdges": 18, "ambiguousEdges": 2, "similarityEdges": 0 }
  },
  "meta": {
    "collection": null,
    "nodeLimit": 2000,
    "edgeLimit": 10000,
    "totalNodes": 150,
    "totalEdges": 320,
    "totalEdgesUnresolved": 5,
    "returnedNodes": 150,
    "returnedEdges": 320,
    "truncated": false,
    "linkedOnly": true,
    "includedSimilar": false,
    "similarAvailable": true,
    "similarTopK": 5,
    "similarTruncatedByComputeBudget": false,
    "warnings": []
  }
}
```

### gno graph query

Run a bounded typed-edge traversal from one document. This command uses the
typed `doc_edges` projection (`relations:`, graph-hinted links, and backfilled
wiki/markdown links) and is scoped to a resolved root rather than the global
graph export.

**Synopsis:**

```bash
gno graph query <doc> [--direction <both|out|in>] [--edge-type <type>] [--max-depth <n>] [--max-nodes <n>] [--frontier-limit <n>] [--visited-limit <n>] [--json]
```

**Options:**

| Flag               | Type   | Default | Description                          |
| ------------------ | ------ | ------- | ------------------------------------ |
| `--direction`      | enum   | both    | Traverse outgoing, incoming, or both |
| `--edge-type`      | string | all     | Filter to one typed edge/relation    |
| `--max-depth`      | number | 2       | Maximum traversal depth              |
| `--max-nodes`      | number | 100     | Maximum returned nodes               |
| `--frontier-limit` | number | 100     | Max frontier width per depth         |
| `--visited-limit`  | number | 500     | Max visited rows during traversal    |
| `--json`           | flag   |         | JSON output                          |

**Behavior:**

- Resolves `<doc>` using the shared core ref parser (`#docid`, `gno://...`, or `collection/path`)
- Traverses typed edges with cycle safety and deterministic ordering
- Enforces hard depth, frontier, and visited-row caps; sets `meta.truncated` with warnings when caps trip
- Includes per-node `graphHints` from the node's configured content type

Schema: `graph-query.schema.json`

**Global Graph Edge Types:**

- `wiki`: Wiki link (`[[Target]]`)
- `markdown`: Markdown link (`[text](path.md)`)
- `similar`: Semantic similarity (requires `--include-similar` flag)

`gno graph query --edge-type` filters the typed `doc_edges.edge_type` values
derived from frontmatter relations, content-type graph hints, and backfilled
wiki/markdown projections (for example `mentions`, `references`, or
`related`), not the global graph export edge-type enum above.

### gno changes

List retained, metadata-only document lifecycle changes.

```bash
gno changes [--since <ISO-8601|cursor>] [--collection <name>] [--limit <n>] [--json]
```

- `--since` accepts an ISO-8601 time or an opaque cursor returned by an earlier
  call. Cursors are monotonic, stable, and must not be parsed by callers.
- `--limit` defaults to 100 and is bounded to 1-1000.
- JSON output uses `changes.schema.json`. It includes opaque per-change IDs,
  old/new identity and hash snapshots, normalized structural deltas, pagination,
  cursor-expiry, and retention-truncation disclosure.
- The journal never returns source bodies.

### gno diff

Show the latest retained structural delta for one document, or select an exact
retained journal entry by opaque ID.

```bash
gno diff <doc> [--change <id>] [--json]
```

JSON output uses `document-diff.schema.json`. `content.status` is always
`not_retained`; GNO does not reconstruct old bodies. `history.status` is
`partial` when `structureDelta.truncated` discloses unavailable prior
structure. Expired/purged IDs return `status: "expired"` without inventing
history.

### gno impact

Find active documents that depend on one document through inbound typed,
wiki-link, or Markdown-link edges.

```bash
gno impact <doc> [--max-depth <n>] [--max-nodes <n>] [--max-edges <n>] [--frontier-limit <n>] [--visited-limit <n>] [--json]
```

The traversal is cycle-safe and enforces depth, node, edge, frontier, and
visited-row caps. Every impacted document includes one deterministic
dependency-to-root evidence path. JSON output uses `impact.schema.json`.

**Exit Codes:**

- 0: Success
- 1: No documents indexed

**Examples:**

```bash
# Full graph
gno graph

# Filter by collection
gno graph --collection notes

# Include similarity edges
gno graph --include-similar --threshold 0.6

# JSON output with limits
gno graph --limit 500 --edge-limit 2000 --json
```

---

### gno serve

Start web UI server for visual search and browse.

Both resident commands read the optional root `gateway` config. CLI gateway
flags override the corresponding scalar/list values for that invocation:

```yaml
gateway:
  host: 127.0.0.1
  tokenFile: ~/.config/gno/mcp-token
  allowedHosts: [127.0.0.1:3000, localhost:3000]
  allowedOrigins: [http://127.0.0.1:3000, http://localhost:3000]
  enableWrite: false
  limits:
    maxBodyBytes: 1048576
    maxRequestsPerMinute: 120
    maxConcurrentRequests: 64
    maxQueuedRequests: 16
    maxSessions: 32
    sessionIdleTimeoutMs: 300000
```

The token file is generated only when a path is explicitly configured. A
wildcard/non-loopback `host` requires a token file plus non-empty exact Host and
Origin allowlists; startup otherwise exits 2 without opening a listener.
`gno serve` additionally rejects non-loopback hosts because its Web UI and REST
API share the listener; use `gno daemon` for authenticated non-loopback MCP.

**Synopsis:**

```bash
gno serve [--port <num>] [gateway-options] [--detach] [--pid-file <path>] [--log-file <path>]
gno serve --status [--json]
gno serve --stop
```

**Options:**

| Option                 | Type    | Default                  | Description                                                      |
| ---------------------- | ------- | ------------------------ | ---------------------------------------------------------------- |
| `-p, --port`           | number  | 3000                     | Port to listen on                                                |
| `--detach`             | boolean | false                    | Self-spawn a detached child; parent prints `{pid,url}` and exits |
| `--pid-file <path>`    | string  | `{data}/serve.pid`       | Override pid-file location (JSON metadata, absolute path)        |
| `--log-file <path>`    | string  | `{data}/serve.log`       | Override log-file location (append mode)                         |
| `--status`             | boolean | false                    | Read pid-file, check liveness, print status (JSON with `--json`) |
| `--stop`               | boolean | false                    | Graceful SIGTERM with 10s timeout → SIGKILL fallback             |
| `--host <address>`     | string  | `127.0.0.1`              | Loopback listen address (Web/REST remains local-only)            |
| `--mcp-token-file`     | string  | config                   | Restrictive bearer-token file                                    |
| `--mcp-allowed-host`   | string  | config/loopback defaults | Exact Host value; repeatable                                     |
| `--mcp-allowed-origin` | string  | config/loopback defaults | Exact Origin; repeatable                                         |
| `--mcp-enable-write`   | boolean | false                    | Separately authorize HTTP MCP mutation tools                     |

`--detach`, `--status`, and `--stop` are mutually exclusive. Passing more than one produces a `VALIDATION` error (exit 1).

Default paths live under `resolveDirs().data` (honours `GNO_DATA_DIR`). Only one
resident owner (`serve` or `daemon`) may use a `GNO_DATA_DIR`; any second start
is blocked.

**Behavior:**

- Opens database once at startup (not per-request)
- Closes the HTTP server, background runtime, and database on SIGINT/SIGTERM
  before the CLI exits; the CLI bootstrap does not race the command's handler
- Sets CSP header: `default-src 'self'; script-src 'self'`
- Health check at `/api/health` returns `{ok:true}`
- Safe lifecycle status at `/api/resident/status` and the `resident` member of
  `/api/status` derive from the same `resident-status@1.0` snapshot
- Mounts stateful Streamable HTTP MCP at `/mcp` only after the fail-closed
  actual-peer, Host, Origin, bearer, body, rate, request, queue, and session
  boundary initializes
- On `--detach`: forks a detached child with stdio redirected to `--log-file`, writes pid-file JSON (`{pid, port, cmd:"serve", version, started_at}`), prints `{pid, url}` on stdout, exits 0
- On `--status`: output matches the [process-status schema](./output-schemas/process-status.schema.json). Liveness via `process.kill(pid, 0)`; stale pid-files (ESRCH) are reported as `running:false`. Live status best-effort reads the same redacted `resident-status@1.0` snapshot from the recorded listener.
- On `--stop`: sends SIGTERM, polls every 100ms for up to 10s, falls back to SIGKILL, polls 2s more, unlinks pid-file if the process cleaned up after itself
- **Windows**: `--detach` is unsupported and returns a `VALIDATION` error pointing to WSL. `--status` / `--stop` / `--pid-file` / `--log-file` remain parseable but have nothing to manage.

**Exit Codes:**

- 0: Server stopped gracefully, `--detach` succeeded, `--stop` completed, or `--status` found a live process
- 1: Validation error (mutex violation, bad flag combination, Windows `--detach`)
- 2: Server failed to start (DB error, port in use, spawn failure)
- 3: `--status` or `--stop` found no live matching process (`NOT_RUNNING`)

**Examples:**

```bash
gno serve
gno serve --port 8080

# Backgrounding
gno serve --detach
gno serve --status
gno serve --status --json
gno serve --stop

# Custom paths
gno serve --detach --pid-file /tmp/gno-serve.pid --log-file /tmp/gno-serve.log

# Mutually exclusive — errors with VALIDATION
gno serve --detach --stop
```

---

### gno daemon

Start a headless long-running watcher process for continuous indexing.

**Synopsis:**

```bash
gno daemon [--port <num>] [--no-sync-on-start] [gateway-options] [--detach] [--pid-file <path>] [--log-file <path>]
gno daemon --status [--json]
gno daemon --stop
```

**Options:**

| Option                 | Type    | Default                  | Description                                                      |
| ---------------------- | ------- | ------------------------ | ---------------------------------------------------------------- |
| `--no-sync-on-start`   | boolean | false                    | Skip initial sync; only watch future file changes                |
| `-p, --port <num>`     | number  | 3000                     | Headless HTTP MCP gateway port                                   |
| `--detach`             | boolean | false                    | Self-spawn a detached child; parent prints `{pid}` and exits     |
| `--pid-file <path>`    | string  | `{data}/daemon.pid`      | Override pid-file location (JSON metadata, absolute path)        |
| `--log-file <path>`    | string  | `{data}/daemon.log`      | Override log-file location (append mode)                         |
| `--status`             | boolean | false                    | Read pid-file, check liveness, print status (JSON with `--json`) |
| `--stop`               | boolean | false                    | Graceful SIGTERM with 10s timeout → SIGKILL fallback             |
| `--host <address>`     | string  | `127.0.0.1`              | HTTP listen address                                              |
| `--mcp-token-file`     | string  | config                   | Restrictive bearer-token file                                    |
| `--mcp-allowed-host`   | string  | config/loopback defaults | Exact Host value; repeatable                                     |
| `--mcp-allowed-origin` | string  | config/loopback defaults | Exact Origin; repeatable                                         |
| `--mcp-enable-write`   | boolean | false                    | Separately authorize HTTP MCP mutation tools                     |

`--detach`, `--status`, and `--stop` are mutually exclusive. Passing more than one produces a `VALIDATION` error (exit 1).

Default paths live under `resolveDirs().data` (honours `GNO_DATA_DIR`). Only one
resident owner (`serve` or `daemon`) may use a `GNO_DATA_DIR`; any second start
is blocked.

**Behavior:**

- Opens DB once at startup
- Loads config and requires at least one configured collection
- Starts the same watcher + embed scheduler used by `gno serve`
- Runs an initial sync by default
- Triggers embedding after initial sync completes
- Runs in the foreground until `SIGINT` / `SIGTERM`
- Starts a headless `/mcp` Streamable HTTP listener; it does not serve the Web UI
- Exposes the same safe REST lifecycle snapshot at `/api/resident/status`;
  resident-aware app status at `/api/status` is loopback-only because it
  includes local index and configuration details
- On `--detach`: forks a detached child with stdio redirected to `--log-file`, writes pid-file JSON including the MCP gateway `port`, prints `{pid}` on stdout, exits 0
- On `--status`: output matches the [process-status schema](./output-schemas/process-status.schema.json), including the MCP gateway port and a best-effort copy of the live redacted resident snapshot
- On `--stop`: SIGTERM → 10s poll → SIGKILL → 2s poll; the daemon's own signal handler unlinks the pid-file, `--stop` unlinks as fallback
- **Windows**: `--detach` is unsupported and returns a `VALIDATION` error pointing to WSL.

**Packaged conformance:** `bun run test:package` installs the generated npm
tarball and exercises the shipped binary. It covers concurrent HTTP MCP clients,
stdio parity, resident reuse, redacted lifecycle schemas, boundary rejection,
bearer rotation and session binding, daemon-only authenticated non-loopback
binding, and detached restart/shutdown. Windows artifact jobs provide the final
platform-specific detach and interrupt-exit sweep.

**Exit Codes:**

- 0: Daemon stopped gracefully, `--detach` succeeded, `--stop` completed, or `--status` found a live process
- 1: Validation error (mutex violation, bad flag combination, Windows `--detach`)
- 2: Startup/runtime failure
- 3: `--status` or `--stop` found no live matching process (`NOT_RUNNING`)

**Examples:**

```bash
gno daemon
gno daemon --no-sync-on-start

# Backgrounding
gno daemon --detach
gno daemon --status
gno daemon --status --json
gno daemon --stop

# Custom paths
gno daemon --detach --log-file /tmp/gno-daemon.log

# Mutually exclusive — errors with VALIDATION
gno daemon --status --stop
```

---

### gno completion

Output or install shell completion scripts.

**Synopsis:**

```bash
gno completion <shell>
gno completion install [--shell <shell>] [--json]
```

**Subcommands:**

| Subcommand | Description                                |
| ---------- | ------------------------------------------ |
| `<shell>`  | Output completion script (bash, zsh, fish) |
| `install`  | Auto-install completion to shell config    |

**Options (install):**

| Flag          | Type   | Description                                     |
| ------------- | ------ | ----------------------------------------------- |
| `-s, --shell` | string | Shell to install for (auto-detected if omitted) |
| `--json`      | flag   | JSON output                                     |

**Supported Shells:**

- `bash` - Appends to ~/.bashrc or ~/.bash_profile (macOS)
- `zsh` - Appends to ~/.zshrc
- `fish` - Creates ~/.config/fish/completions/gno.fish

**Completion Features:**

- Static: Commands, subcommands, flags (always available)
- Dynamic: Collection names for `--collection` flag (when DB available)

**Examples:**

```bash
# Output bash completion script
gno completion bash >> ~/.bashrc

# Auto-install for detected shell
gno completion install

# Install for specific shell
gno completion install --shell zsh
```

**Exit Codes:**

- 0: Success
- 1: Unsupported shell

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

Error codes match exit codes: `VALIDATION` (exit 1), `RUNTIME` (exit 2), `NOT_RUNNING` (exit 3).

**`NOT_RUNNING` is not an error envelope.** `gno serve|daemon --status --json` returns a `process-status`-shaped payload on stdout with exit 3 when no live matching process is found (it reports observable state, not failure). `--stop` exits 3 silently when there is nothing to stop and does not accept `--json`. The error envelope above is reserved for `VALIDATION` and `RUNTIME` failures where the command could not produce its structured output at all.

---

## Environment Variables

| Variable                   | Description                                      |
| -------------------------- | ------------------------------------------------ |
| `GNO_CONFIG_DIR`           | Override config directory                        |
| `GNO_DATA_DIR`             | Override data directory (DB location)            |
| `GNO_CACHE_DIR`            | Override cache directory (models)                |
| `NO_COLOR`                 | Disable colored output (standard)                |
| `PAGER`                    | Pager for long output (default: less -R, more)   |
| `GNO_SKILLS_HOME_OVERRIDE` | Override home dir for skill user scope (testing) |
| `CLAUDE_SKILLS_DIR`        | Override Claude skills directory                 |
| `CODEX_SKILLS_DIR`         | Override Codex skills directory                  |

---

## See Also

- [MCP Specification](./mcp.md)
- [Output Schemas](./output-schemas/)
- [PRD](../docs/prd.md)
