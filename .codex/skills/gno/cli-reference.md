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

Index names use 1–64 UTF-16 code units, start with a letter or number, and
reject trailing space/dot, `..`, separators, controls, and platform-invalid
punctuation. NFC/case-equivalent spellings share one identity. See
`docs/CLI.md` under Global Options for the complete canonical-byte contract.

## Initialization

### gno setup

Preferred activation path: add one folder, prove a real exact lexical result,
then continue semantic indexing in the background.

```bash
gno setup <folder> --name <collection> [options]
```

| Option                    | Description                                               |
| ------------------------- | --------------------------------------------------------- |
| `--exclude <pattern>`     | Repeatable literal exclusion                              |
| `--authorize-secret-risk` | Explicitly allow likely-secret files                      |
| `--connector <id>`        | Install and smoke-test a connector; repeatable            |
| `--apply-profile`         | Apply a valid `.gno/index.yml` before setup               |
| `--no-semantic`           | Stop after lexical retrieval proof; start no model worker |
| `--json`                  | Structured activation receipt                             |

Setup is idempotent. Success means a corpus-derived BM25 query returned a
cited result; it does not imply that background semantic work already finished.

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

## Project Profiles

Project-local `.gno/index.yml` files describe portable collection, context,
content-type, source-metadata, and retrieval-default intent. They never relocate
the database into the repository and are never applied implicitly.

```bash
gno profile check [path]
gno profile show [path]
gno profile diff [path]
gno profile apply [path]
gno setup . --apply-profile
```

`check` validates only. `show` emits normalized state. `diff` compares the
profile with local configuration. `apply` is additive/update-oriented and does
not infer deletions. Profile project roots are trusted local affinity inputs;
MCP/SDK/REST hints remain opaque and cannot become filesystem paths.

## Capture

### gno capture

Capture a note into an editable collection with provenance.

```bash
gno capture "thought to remember"
gno capture --stdin --collection notes --preset source-summary --tags inbox,gno
gno capture --file ./clip.md --source-url https://example.com --source-kind web --json
gno capture "meeting note" --quiet
```

Preset IDs: `blank`, `project-note`, `research-note`, `decision-note`,
`prompt-pattern`, `source-summary`, `idea-original`, `person`,
`company-project`, `meeting`.

Second-brain presets keep current synthesis above `## Timeline` and dated
evidence below it. Use `idea-original` for exact idea wording, `person` for
relationship/current-state notes, `company-project` for organizations or active
workstreams, and `meeting` for analysis above transcript/raw notes/action items.

Important behavior:

- Inline content, `--stdin`, and `--file` are mutually exclusive.
- Capture accepts text only; binary-like file/stdin content is rejected before
  writing.
- Without `--path`, `--folder`, or `--title`, captures use
  `inbox/YYYY-MM-DD/capture-<body-hash>.md` in UTC.
- Capture writes fail instead of replacing a late-arriving file.
- `--json` returns a capture receipt with separate write, sync, and embed status.
- Capture syncs the file into FTS but does not imply embedding unless
  `embed.status` is `completed`.

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
| `--fast`     | ~0.7s | Skip expansion, graph, rerank  |
| (default)    | ~2-3s | Balanced, graph + reranking    |
| `--thorough` | ~5-8s | Wider expansion + graph/rerank |

Additional options:

| Option        | Description                                |
| ------------- | ------------------------------------------ |
| `--no-expand` | Disable query expansion                    |
| `--no-rerank` | Disable reranking                          |
| `--graph`     | Explicitly enable default graph candidates |
| `--no-graph`  | Disable graph-neighbor candidates          |
| `--explain`   | Print retrieval details to stderr          |

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
| `--verify`                | Closed-Capsule answer or abstention    |
| `--no-answer`             | Retrieval only                         |
| `--max-answer-tokens <n>` | Cap answer length                      |
| `--context-budget-tokens` | Global verified-Capsule token budget   |
| `--context-budget-bytes`  | Global verified-Capsule byte budget    |
| `--show-sources`          | Show all sources                       |

`--verify` is distinct from `--answer`: generation receives only a closed
Context Capsule, every substantive claim is checked against exact retained
spans, and GNO releases the answer only at 100% support coverage. Failed or
unavailable semantic verification forces an explicit abstention. This proves
support against retained evidence, not corpus completeness or source truth.

## Document Retrieval

### gno get

Get single document.

```bash
gno get <ref> [--from <line>] [-l <lines>] [--line-numbers] [--source]
```

Ref formats:

- `gno://collection/path` — Full URI
- `gno://collection/path?index=name` — Full URI emitted from a non-default index
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

### gno context build

Compile one deterministic, extractive evidence bundle under global token and
byte budgets:

```bash
gno context build "<goal>" --budget 12000 --json --output capsule.json
gno context build "compare proposals" --budget 16000 --collection work --md
gno context build "release evidence" --budget 12000 --fast --json
```

The Capsule retains exact URI/heading/line spans, source/mirror/passage hashes,
normalized retrieval inputs, fingerprints, capability outcomes, omissions,
coverage, and explicit gaps. Selection collapses overlaps and rewards uncovered
facets. `--fast` avoids model loading; `--thorough` widens retrieval. GNO writes
only to stdout or an explicit `--output`; it never persists Capsules implicitly.

### gno context verify

Recheck a saved canonical JSON Capsule without rebuilding or mutating it:

```bash
gno context verify capsule.json --json
cat capsule.json | gno context verify - --md
```

The receipt classifies evidence as unchanged, stale, or missing; ranking as
unchanged, reranked, or unavailable; and reports fingerprint drift separately.
Verification uses the Capsule's index and refuses an explicitly mismatched
global `--index`.

### Saved Capsule watches

Register a caller-owned Capsule file for evidence-triggered reverification:

```bash
gno context watch capsule.json --question "Who owns launch?" --notify --json
gno context watches --json
gno context reverify <registration-id> --json
gno context unwatch <registration-id> --json
```

GNO stores only bounded registration metadata and evidence hashes—not Capsule
or passage bytes. `serve`/`daemon` reverify after relevant settled index
changes. Watch lifecycle operations are CLI-only. Reverification never rebuilds
or overwrites the saved Capsule.

## Knowledge Delta

Inspect retained metadata-only change history and bounded dependency impact:

```bash
gno changes --since 2026-07-20T00:00:00Z --json
gno diff gno://notes/plan.md --json
gno impact gno://notes/plan.md --max-depth 3 --json
```

`changes` accepts an ISO time or opaque cursor and optional collection/limit.
`diff` reports structural headings, links, and typed-relationship changes for
one retained change. `impact` follows inbound evidence edges with explicit
depth/node/edge/frontier/visited bounds. Expired journal history is reported,
not reconstructed.

## Private Retrieval Traces

Trace recording is local and off by default. Metadata mode excludes raw
query/goal/filter values; replay mode is separate explicit consent.

```bash
gno trace list --json
gno trace show <trace-id> --json
gno trace label <trace-id> --label relevant --target <uri> \
  --target-kind document
gno trace export <trace-id> --format qrels --output qrels.json
gno trace replay <export-id> --candidate hybrid --md
gno trace delete <trace-id>
gno trace purge
```

Only append relevance labels the user explicitly supplied. Export, delete, and
purge are explicit mutations. Replay compares one candidate with an immutable
local baseline and always reports `applied: false`; it never changes live
ranking.

## Collection Egress

Collections can be restricted to `local_only`, `lan`, or `remote`. Egress is
checked before non-loopback serving, remote model calls, network export, or
publishing and remains separate from authentication or write permission.

```bash
gno collection policy get work
gno collection policy check --action remote_model \
  --destination remote --content-class internal -c work --explain-egress
gno collection policy set work remote --confirm-relaxation <revision>
gno egress-audit list
gno egress-audit show <audit-id>
gno egress-audit status
gno egress-audit delete <audit-id>
gno egress-audit purge
```

Denied egress is terminal for that route; do not retry through another network
surface. Relaxing policy requires the current revision; tightening to
`local_only` does not. Audit receipts are local and content-free.
Deletion/purge must remain explicit.

## Note Linking

### gno links

List outgoing links from a document.

```bash
gno links <ref> [options]
```

| Option        | Description                  |
| ------------- | ---------------------------- |
| `--type`      | Filter: `wiki` or `markdown` |
| `--edge-type` | Filter by semantic edge type |
| `--relation`  | Alias for `--edge-type`      |
| `--json`      | JSON output                  |
| `--md`        | Markdown output              |

### gno backlinks

Find documents linking TO a target.

```bash
gno backlinks <ref> [options]
```

| Option             | Description                  |
| ------------------ | ---------------------------- |
| `-c, --collection` | Filter by collection         |
| `--edge-type`      | Filter by semantic edge type |
| `--relation`       | Alias for `--edge-type`      |
| `--json`           | JSON output                  |
| `--md`             | Markdown output              |

`gno links` and `gno backlinks` also accept `--edge-type <type>` or
`--relation <type>` to query semantic typed edges instead of positional
wiki/markdown links. Do not combine `--type` with `--edge-type`.

### gno graph query

Bounded typed-edge traversal from a document.

```bash
gno graph query <ref> [--edge-type <type>] [--max-depth <n>] [--direction out|in|both] [--json]
```

Use this when relation meaning matters:

```bash
gno graph query gno://notes/people/alice.md --edge-type works_at --max-depth 2 --json
```

### gno query diagnose

Explain why a target document did or did not surface for a query.

```bash
gno query diagnose "<query>" --target <ref> [--fast|--thorough] [--json]
```

The JSON output reports target status, filters, typed metadata, and per-stage
presence across BM25, vector, fusion, graph expansion, and rerank. Use `--fast`
for BM25-only diagnosis without vector/rerank startup.

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
gno graph --neighbors <ref> [--direction both|out|in]
gno graph --from <ref> --to <ref> [--max-depth 6]
```

| Option               | Default | Description                    |
| -------------------- | ------- | ------------------------------ |
| `-c, --collection`   | all     | Filter to single collection    |
| `--limit`            | 2000    | Max nodes                      |
| `--edge-limit`       | 10000   | Max edges                      |
| `--include-similar`  | false   | Include similarity edges       |
| `--threshold`        | 0.7     | Similarity threshold (0-1)     |
| `--include-isolated` | false   | Include isolated nodes         |
| `--similar-top-k`    | 5       | Similar docs per node (max 20) |
| `--neighbors`        | -       | Show graph neighbors for ref   |
| `--direction`        | both    | Neighbor direction             |
| `--from`, `--to`     | -       | Find shortest graph path       |
| `--max-depth`        | 6       | Max path hops                  |
| `--json`             | -       | JSON output                    |

**Edge types**: `wiki` (wiki links), `markdown` (md links), `similar` (vector similarity).
JSON edges include `confidence` (`explicit`, `inferred`, `ambiguous`, `similarity`) and `audit` metadata so agents can prefer exact links over fallback or collision-prone matches.

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

Built-ins: `slim-tuned` (default), `slim`, `balanced`, `quality`. Actual
download/cache use depends on the selected artifacts and existing shared cache.

### gno models pull

```bash
gno models pull [--all|--embed|--rerank|--gen] [--force]
```

Cached/local model files are validated as GGUF before use. If the cache contains
HTML or another non-GGUF response, rerun with `--force` after fixing network
access.

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

| Option         | Default        | Description               |
| -------------- | -------------- | ------------------------- |
| `-t, --target` | claude-desktop | Target client (see below) |
| `-s, --scope`  | target default | Scope: `user`, `project`  |
| `-f, --force`  | false          | Overwrite existing config |
| `--dry-run`    | false          | Preview changes           |

Targets: `claude-desktop`, `claude-code`, `codex`, `cursor`, `zed`,
`windsurf`, `opencode`, `amp`, `lmstudio`, and `librechat`. Project scope is
supported by Claude Code, Codex, Cursor, OpenCode, and LibreChat.
LibreChat is project-only; all other targets default to user scope.

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

| Option         | Default | Description                                                        |
| -------------- | ------- | ------------------------------------------------------------------ |
| `-t, --target` | claude  | Target: `claude`, `codex`, `opencode`, `openclaw`, `hermes`, `all` |
| `-s, --scope`  | project | Scope: `project`, `user`                                           |
| `-f, --force`  | false   | Overwrite existing                                                 |

Examples:

```bash
gno skill install --target claude --scope project
gno skill install --target codex --scope user
gno skill install --target openclaw --scope user
gno skill install --target hermes --scope user
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
gno skill show [--file <name>] [--all]
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
gno reset --confirm [--keep-config] [--keep-cache]
```

### gno completion

Install shell tab completion.

```bash
gno completion install [--shell <bash|zsh|fish>]
gno completion output <bash|zsh|fish>
```

## Exit Codes

| Code | Description                                                          |
| ---- | -------------------------------------------------------------------- |
| 0    | Success                                                              |
| 1    | Validation error (bad args)                                          |
| 2    | Runtime error (IO, DB, model)                                        |
| 3    | `NOT_RUNNING` — `--status` / `--stop` found no live matching process |
