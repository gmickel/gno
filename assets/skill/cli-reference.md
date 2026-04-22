# GNO CLI Reference

Complete command reference for GNO.

## Global Flags

All commands accept:

| Flag              | Description                              |
| ----------------- | ---------------------------------------- |
| `--index <name>`  | Use alternate index (default: "default") |
| `--config <path>` | Override config file path                |
| `--no-color`      | Disable colored output                   |
| `--verbose`       | Enable verbose logging                   |
| `--yes`           | Non-interactive mode                     |
| `--json`          | JSON output (where supported)            |
| `--no-pager`      | Disable automatic paging                 |
| `--offline`       | Use cached models only                   |

## Initialization

### gno init

```bash
gno init [<path>] [options]
```

| Option               | Description                                     |
| -------------------- | ----------------------------------------------- |
| `--name <name>`      | Collection name                                 |
| `--pattern <glob>`   | File pattern (default: `**/*`)                  |
| `--include <exts>`   | Extension allowlist (e.g., `.md,.pdf`)          |
| `--exclude <paths>`  | Exclude patterns (default: `.git,node_modules`) |
| `--tokenizer <type>` | FTS tokenizer: unicode61, porter, trigram       |
| `--language <code>`  | BCP-47 language hint                            |

## Collections

### gno collection add

```bash
gno collection add <path> --name <name> [options]
```

Options same as `init`, plus:

| Option                | Description                                          |
| --------------------- | ---------------------------------------------------- |
| `--embed-model <uri>` | Initial collection-specific embedding model override |

### gno collection list

```bash
gno collection list [--json|--md]
```

### gno collection remove

```bash
gno collection remove <name>
```

### gno collection rename

```bash
gno collection rename <old> <new>
```

### gno collection clear-embeddings

```bash
gno collection clear-embeddings <name> [--all] [--json]
```

### gno embed

```bash
gno embed [collection] [--collection <name>] [--force] [--model <uri>] [--batch-size <n>] [--dry-run]
```

## Indexing

### gno update

Sync files from disk (no embedding).

```bash
gno update [--git-pull]
```

### gno index

Full index (update + embed).

```bash
gno index [options]
```

| Option                | Description                |
| --------------------- | -------------------------- |
| `--collection <name>` | Scope to single collection |
| `--no-embed`          | Skip embedding             |
| `--models-pull`       | Download models if missing |
| `--git-pull`          | Git pull before indexing   |

### gno embed

Generate embeddings only.

```bash
gno embed [--force] [--model <uri>] [--batch-size <n>] [--dry-run]
```

## Search Commands

### gno search

BM25 keyword search.

```bash
gno search <query> [options]
```

| Option             | Default | Description                      |
| ------------------ | ------- | -------------------------------- |
| `-n`               | 5       | Max results                      |
| `--min-score`      | 0       | Minimum score (0-1)              |
| `-c, --collection` | all     | Filter to collection             |
| `--tags-any`       | -       | Filter: has ANY tag (comma-sep)  |
| `--tags-all`       | -       | Filter: has ALL tags (comma-sep) |
| `--full`           | false   | Full content (not snippets)      |
| `--line-numbers`   | false   | Include line numbers             |
| `--lang`           | auto    | Language filter                  |

Output formats: `--json`, `--files`, `--csv`, `--md`, `--xml`

### gno vsearch

Vector semantic search. Same options as `search`.

```bash
gno vsearch <query> [options]
```

### gno query

Hybrid search with expansion and reranking.

```bash
gno query <query> [options]
```

**Search modes** (pick one):

| Flag         | Time  | Description                    |
| ------------ | ----- | ------------------------------ |
| `--fast`     | ~0.7s | Skip expansion and reranking   |
| (default)    | ~2-3s | Skip expansion, with reranking |
| `--thorough` | ~5-8s | Full pipeline with expansion   |

Additional options:

| Option        | Description                       |
| ------------- | --------------------------------- |
| `--no-expand` | Disable query expansion           |
| `--no-rerank` | Disable reranking                 |
| `--explain`   | Print retrieval details to stderr |

### gno ask

AI-powered Q&A with citations.

```bash
gno ask <question> [options]
```

| Option                    | Description                            |
| ------------------------- | -------------------------------------- |
| `--fast`                  | Skip expansion and reranking (fastest) |
| `--thorough`              | Enable query expansion (better recall) |
| `--answer`                | Generate grounded answer               |
| `--no-answer`             | Retrieval only                         |
| `--max-answer-tokens <n>` | Cap answer length                      |
| `--show-sources`          | Show all sources                       |

## Document Retrieval

### gno get

Get single document.

```bash
gno get <ref> [--from <line>] [-l <lines>] [--line-numbers] [--source]
```

Ref formats:

- `gno://collection/path` — Full URI
- `collection/path` — Relative path
- `#docid` — Document ID
- `gno://docs/file.md:120` — With line number

### gno multi-get

Get multiple documents.

```bash
gno multi-get <pattern> [--max-bytes <n>] [--line-numbers]
```

### gno ls

List documents.

```bash
gno ls [<scope>] [--json|--files|--md]
```

## Context Management

### gno context add

```bash
gno context add <scope> "<text>"
```

Scope formats:

- `/` — Global
- `collection:` — Collection prefix
- `gno://collection/path` — Path prefix

### gno context list

```bash
gno context list [--json|--md]
```

### gno context rm

```bash
gno context rm <scope>
```

### gno context check

Validate context configuration.

```bash
gno context check [--json]
```

## Note Linking

### gno links

List outgoing links from a document.

```bash
gno links <ref> [options]
```

| Option       | Description                          |
| ------------ | ------------------------------------ |
| `--type`     | Filter: `wiki`, `markdown`, or `all` |
| `--resolved` | Only show resolved links             |
| `--broken`   | Only show broken links               |
| `--json`     | JSON output                          |

### gno backlinks

Find documents linking TO a target.

```bash
gno backlinks <ref> [options]
```

| Option   | Description               |
| -------- | ------------------------- |
| `-n`     | Max results (default: 20) |
| `--json` | JSON output               |

### gno similar

Find semantically similar documents.

```bash
gno similar <ref> [options]
```

| Option               | Description                   |
| -------------------- | ----------------------------- |
| `-n`                 | Max results (default: 5)      |
| `--threshold`        | Min similarity (0-1)          |
| `--cross-collection` | Search across all collections |
| `--json`             | JSON output                   |

**Requirements**: Embeddings must exist for source and target documents.

### gno graph

Generate knowledge graph of document connections.

```bash
gno graph [options]
```

| Option             | Default | Description                    |
| ------------------ | ------- | ------------------------------ |
| `-c, --collection` | all     | Filter to single collection    |
| `--limit`          | 2000    | Max nodes                      |
| `--edge-limit`     | 10000   | Max edges                      |
| `--similar`        | false   | Include similarity edges       |
| `--threshold`      | 0.7     | Similarity threshold (0-1)     |
| `--linked-only`    | true    | Exclude isolated nodes         |
| `--similar-top-k`  | 5       | Similar docs per node (max 20) |
| `--json`           | -       | JSON output                    |

**Edge types**: `wiki` (wiki links), `markdown` (md links), `similar` (vector similarity).

**Web UI**: Access interactive graph at `http://localhost:3000/graph` via `gno serve`.

## Tags

### gno tags

List tags with document counts.

```bash
gno tags [options]
```

| Option             | Description           |
| ------------------ | --------------------- |
| `-c, --collection` | Filter by collection  |
| `--prefix`         | Filter by tag prefix  |
| `--json`           | JSON output           |
| `--md`             | Markdown table output |

### gno tags add

Add tag to document.

```bash
gno tags add <doc> <tag>
```

- `doc`: URI (`gno://...`) or docid (`#abc123`)
- `tag`: Tag string (lowercase, alphanumeric, hyphens, dots, `/` for hierarchy)

### gno tags rm

Remove tag from document.

```bash
gno tags rm <doc> <tag>
```

## Models

### gno models list

```bash
gno models list [--json|--md]
```

### gno models use

```bash
gno models use <preset>
```

Presets: `slim` (~1GB), `balanced` (~2GB), `quality` (~2.5GB)

### gno models pull

```bash
gno models pull [--all|--embed|--rerank|--gen] [--force]
```

### gno models clear

```bash
gno models clear [--all|--embed|--rerank|--gen]
```

### gno models path

```bash
gno models path [--json]
```

## Maintenance

### gno status

```bash
gno status [--json|--md]
```

### gno doctor

```bash
gno doctor [--json|--md]
```

### gno cleanup

```bash
gno cleanup
```

### gno vec

Vector index maintenance. Use when `gno similar` returns empty despite embeddings.

```bash
gno vec sync      # Fast incremental sync
gno vec rebuild   # Full rebuild
```

| Option   | Description |
| -------- | ----------- |
| `--json` | JSON output |

## MCP Server

### gno mcp

Start MCP server (stdio transport).

```bash
gno mcp
```

### gno mcp install

Install GNO as MCP server in client configurations.

```bash
gno mcp install [options]
```

| Option         | Default        | Description                                      |
| -------------- | -------------- | ------------------------------------------------ |
| `-t, --target` | claude-desktop | Target: `claude-desktop`, `claude-code`, `codex` |
| `-s, --scope`  | user           | Scope: `user`, `project`                         |
| `-f, --force`  | false          | Overwrite existing config                        |
| `--dry-run`    | false          | Preview changes                                  |

Examples:

```bash
# Claude Desktop (default)
gno mcp install

# Claude Code (user scope)
gno mcp install -t claude-code

# Claude Code (project scope)
gno mcp install -t claude-code -s project
```

### gno mcp uninstall

Remove GNO MCP server from client configuration.

```bash
gno mcp uninstall [-t <target>] [-s <scope>]
```

### gno mcp status

Show MCP installation status.

```bash
gno mcp status [--json]
```

## Web UI

### gno serve

Start web UI for browsing, searching, and querying documents.

```bash
gno serve [options]
```

| Option       | Default | Description      |
| ------------ | ------- | ---------------- |
| `-p, --port` | 3000    | Port to serve on |
| `--host`     | 0.0.0.0 | Host to bind     |

Features: Dashboard, search, browse collections, document viewer, AI Q&A with citations.

#### Long-running process flags (shared with `gno daemon`)

`gno serve` and `gno daemon` share an identical management contract.
The full spec is reproduced in this section so installed copies of this
skill stay self-contained. The canonical source in the gno repo is
`docs/CLI.md#long-running-processes` (kept in sync with this section
on every release).

| Flag                | Purpose                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `--detach`          | Self-spawn a detached child; parent prints `pid` (+ `url` for serve) and exits 0. Unix-only. |
| `--status`          | Read pid-file, check liveness, print status. Pair with `--json` for machine output.          |
| `--stop`            | SIGTERM the recorded pid, poll up to 10s, fall back to SIGKILL.                              |
| `--pid-file <path>` | Override pid-file location (defaults to `{data}/serve.pid`).                                 |
| `--log-file <path>` | Override log-file location (append-only; defaults to `{data}/serve.log`).                    |

`--detach`, `--status`, and `--stop` are mutually exclusive (Commander conflict error).

**`--json` is gated to `--status` only.** Passing `--json` with `--detach`,
`--stop`, or the foreground path produces a `VALIDATION` error (exit 1).
The literal stderr message is:

```
--json is only supported with `gno serve --status`
```

Do **not** try to parse a NOT_RUNNING envelope from stderr in this case —
it isn't there. Match on the literal string above (or just on exit code 1
plus the absence of structured output) and fall back to a status call.

**Exit codes:**

- `gno serve --status` → `0` when running, `3` (`NOT_RUNNING`) when not.
  The stdout JSON payload is still emitted in JSON mode on exit 3 so
  consumers always get a schema-shaped result; the NOT_RUNNING envelope
  rides on stderr (JSON mode only).
- `gno serve --stop` → `0` when stopped, `3` (`NOT_RUNNING`) when there
  was nothing to stop. **Silent on `3`** — no stderr envelope. Branch on
  `$?`, not stderr text. `1` when refusing to signal a foreign-version
  live pid; `2` when SIGTERM + SIGKILL both timed out.

Examples:

```bash
gno serve --detach                            # self-spawn, parent exits 0
gno serve --status                            # terminal table
gno serve --status --json                     # process-status schema
gno serve --stop                              # graceful stop
gno serve --detach --pid-file /tmp/gs.pid \
                   --log-file /tmp/gs.log
```

> **Windows note**: `--detach` returns a clean `VALIDATION` error pointing
> to WSL. `--status` / `--stop` / `--pid-file` / `--log-file` remain
> parseable but have nothing to manage in the absence of a detached child.

### gno daemon

Headless long-running watcher process. Same watch + sync + embed loop as
`gno serve`, no web UI, no port.

```bash
gno daemon [options]
```

| Option               | Description                                                 |
| -------------------- | ----------------------------------------------------------- |
| `--no-sync-on-start` | Skip the initial sync pass; only watch future file changes. |

Plus the shared long-running-process flags listed in [`gno serve`](#gno-serve)
above (`--detach` / `--status` / `--stop` / `--pid-file` / `--log-file`).
Defaults: `{data}/daemon.pid`, `{data}/daemon.log` (`{data}` =
`resolveDirs().data`, honours `GNO_DATA_DIR`).

**`--json` gating** mirrors `gno serve` exactly. The literal stderr
message on a misuse is:

```
--json is only supported with `gno daemon --status`
```

**Exit codes** are identical to `gno serve` (`0` / `1` / `2` / `3`
`NOT_RUNNING`). `--stop` is silent on `3`.

Examples:

```bash
gno daemon                                    # foreground
gno daemon --no-sync-on-start                 # watcher-only
gno daemon --detach                           # self-spawn
gno daemon --detach --log-file /tmp/gd.log
gno daemon --status
gno daemon --status --json
gno daemon --stop
```

Avoid running `gno daemon` and `gno serve` against the same index at the
same time until cross-process coordination exists.

## Publish

### gno publish export

Export a note or collection as a gno.sh publish artifact JSON.

```bash
gno publish export <target> [--out <path.json>] [options]
```

| Option         | Default | Description                                                                |
| -------------- | ------- | -------------------------------------------------------------------------- |
| `--out`        | auto    | Output path, defaults to `~/Downloads/<slug>-<YYYYMMDD>.json`              |
| `--visibility` | public  | One of `public`, `secret-link`, `invite-only`, `encrypted`                 |
| `--slug`       | auto    | Override the published route slug                                          |
| `--title`      | auto    | Override the exported title                                                |
| `--summary`    | auto    | Override the exported summary                                              |
| `--passphrase` | none    | Required for `--visibility encrypted`; encrypts locally before upload      |
| `--preview`    | false   | Print sanitized markdown + preprocessor report instead of writing artifact |
| `--json`       | false   | Structured result output                                                   |

Examples:

```bash
gno publish export work-docs --out ~/Downloads/work-docs.json
gno publish export "gno://work-docs/runbooks/deploy.md" --out ~/Downloads/deploy.json

# Encrypted share — ciphertext produced locally before upload
gno publish export "gno://work-docs/offer-letter.md" \
  --visibility encrypted --passphrase "correct horse battery staple"

# Inspect what the sanitizer strips before writing anything
gno publish export "gno://vault/my-note.md" --preview
```

On success, upload the JSON file at `https://gno.sh/studio`.

**Obsidian pre-processor (v1.0.2+)**: before the artifact is written, the
export pipeline runs a sanitizer over each note's markdown. It:

- drops the navigation-sidebar idiom (`[[Hub]] | [[Related]]` immediately
  under the frontmatter)
- strips any `[[_internal/...]]` references (privacy guard — the
  `_internal/` convention is treated as never-publish)
- converts `[[Target|Alias]]` to the alias text, and `[[Target]]` to the
  tail segment of the target
- drops `![[image.png]]` embeds (attachments are not bundled yet) with a
  warning so the author can migrate to `![alt](url)` or wait for bundling
- refuses to export a note whose frontmatter contains `publish: false`
  (single-note export errors; collection export silently skips)

Every sanitizer decision surfaces in the CLI output as a "Preprocessor
notes" section, on the `--json` response under `warnings`, and on
`--preview` as a structured report — so nothing is silently lost.

## Skill Management

### gno skill install

Install GNO skill for AI coding assistants.

```bash
gno skill install [options]
```

| Option         | Default | Description                                              |
| -------------- | ------- | -------------------------------------------------------- |
| `-t, --target` | claude  | Target: `claude`, `codex`, `opencode`, `openclaw`, `all` |
| `-s, --scope`  | user    | Scope: `user`, `project`                                 |
| `-f, --force`  | false   | Overwrite existing                                       |
| `--dry-run`    | false   | Preview changes                                          |

Examples:

```bash
gno skill install --target claude --scope project
gno skill install --target codex --scope user
gno skill install --target openclaw --scope user
gno skill install --target all --force   # Install to all targets
```

### gno skill uninstall

Remove GNO skill from AI assistant.

```bash
gno skill uninstall [-t <target>] [-s <scope>]
```

### gno skill show

Preview skill files that would be installed.

```bash
gno skill show [--json]
```

### gno skill paths

Show skill installation paths for each target.

```bash
gno skill paths [--json]
```

## Additional Admin Commands

### gno reset

Delete all GNO data (database, embeddings, config). Use with caution.

```bash
gno reset [--force]
```

### gno completion

Install shell tab completion.

```bash
gno completion install [--shell <bash|zsh|fish>]
gno completion uninstall
```

## Exit Codes

| Code | Description                                                          |
| ---- | -------------------------------------------------------------------- |
| 0    | Success                                                              |
| 1    | Validation error (bad args)                                          |
| 2    | Runtime error (IO, DB, model)                                        |
| 3    | `NOT_RUNNING` — `--status` / `--stop` found no live matching process |
