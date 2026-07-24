---
title: CLI Reference
description: Command-line reference for GNO search, indexing, retrieval, graph, model, collection, and agent integration workflows.
keywords: gno cli, local search cli, hybrid search cli, semantic search command line, agent memory cli
---

# CLI Reference

Command-line guide for GNO's local knowledge engine and workspace tooling.

> **Full specification**: See [spec/cli.md](../spec/cli.md) for exhaustive command documentation.

![GNO CLI](../assets/screenshots/cli.jpg)

## Project-aware ranking

`search`, `vsearch`, `query`, `ask`, and `context build` derive a trusted local
project root from the current repository/worktree by default. A matching
collection receives one soft `+0.03` contribution:

```bash
gno query "deployment decision"
gno query "deployment decision" --project-root ../service-a
gno query "deployment decision" --project-root ../service-a --project-root ../shared
gno query "deployment decision" --no-project-affinity
```

Repeatable `--project-root` values replace cwd inference; they do not stack.
`--project-root` and `--no-project-affinity` are mutually exclusive. All
auxiliary ranking signals share the `±0.08` cap, filters remain hard, and a
base-score lead greater than the applied contribution still wins.
`--explain`/diagnose output exposes only redacted aliases and score receipts,
never raw roots.

## Quick Reference

| Command          | Description                       |
| ---------------- | --------------------------------- |
| `gno init`       | Initialize config and database    |
| `gno setup`      | Add a folder and prove retrieval  |
| `gno index`      | Full index (sync + embed)         |
| `gno update`     | Sync files from disk (no embed)   |
| `gno embed`      | Generate embeddings only          |
| `gno search`     | BM25 full-text search             |
| `gno vsearch`    | Vector similarity search          |
| `gno query`      | Hybrid search (BM25 + vector)     |
| `gno bench`      | Benchmark retrieval fixtures      |
| `gno ask`        | Search with AI answer             |
| `gno get`        | Retrieve document content         |
| `gno ls`         | List indexed documents            |
| `gno daemon`     | Headless continuous indexing      |
| `gno links`      | List outgoing links from document |
| `gno backlinks`  | List documents linking to target  |
| `gno similar`    | Find semantically similar docs    |
| `gno graph`      | Export knowledge graph            |
| `gno serve`      | Start web UI server               |
| `gno mcp`        | Start MCP server for AI clients   |
| `gno models`     | Manage models (list, pull, use)   |
| `gno skill`      | Install GNO skill for AI agents   |
| `gno tags`       | Manage document tags              |
| `gno completion` | Shell tab completion              |
| `gno vec`        | Vector index maintenance          |
| `gno doctor`     | Check system health               |

## Global Flags

All commands accept:

```
--index <name>    Use alternate index (default: "default")
--config <path>   Override config file path
--no-color        Disable colored output
--no-pager        Disable automatic paging of long output
--verbose         Enable verbose logging
--yes             Non-interactive mode
--offline         Use cached models only (no auto-download)
--skill           Output SKILL.md for agent discovery and exit
```

Index names use 1–64 UTF-16 code units drawn from Unicode letters, marks,
numbers, internal ASCII spaces, `.`, `_`, or `-`. They must start with a letter
or number, cannot end with a space or `.`, and cannot contain `..`. Absolute
paths, path separators, controls, and platform-invalid punctuation are rejected.
Case and canonically equivalent Unicode spellings share one NFC/case-folded
identity. That identity may use at most 242 UTF-8 bytes, keeping the complete
`index-<identity>.sqlite` filename within the portable 255-byte component limit.

**Pager**: Long output is automatically piped through a pager when in terminal mode. Uses `$PAGER` if set, otherwise `less -R` (Unix) or `more` (Windows). Disable with `--no-pager`.

**Offline mode**: Use `--offline` or set `HF_HUB_OFFLINE=1` to prevent auto-downloading models. Set `GNO_NO_AUTO_DOWNLOAD=1` to disable auto-download while still allowing explicit `gno models pull`.

**GPU backend selection**: Set `GNO_LLAMA_GPU` to choose the local
`node-llama-cpp` backend. `GNO_LLAMA_GPU` wins over the compatibility alias
`NODE_LLAMA_CPP_GPU`.

```bash
GNO_LLAMA_GPU=metal gno embed --yes
GNO_LLAMA_GPU=false gno doctor --json
```

Accepted values: `auto`, `metal`, `vulkan`, `cuda`, or CPU-only values
`false`, `off`, `none`, `disable`, `disabled`, `0`. Invalid values warn once
and use `auto`.

GNO uses prebuilt `node-llama-cpp` backends by default. Set
`GNO_LLAMA_BUILD=autoAttempt` only if you intentionally want to allow local
source builds. Backend initialization is capped by `GNO_LLAMA_INIT_TIMEOUT_MS`
when set, otherwise 30 seconds.

> **Note:** the first CPU-only run may build or download a separate CPU backend
> if you only have GPU-backed binaries cached. Use the second run for timing.

**Output format flags** (`--json`, `--files`, `--csv`, `--md`, `--xml`) are per-command.
See [spec/cli.md](../spec/cli.md#output-format-support-matrix) for which commands support which formats.

## Verified Folder Setup

`gno setup` is the fastest safe path from a local folder to a proven searchable
collection:

```bash
gno setup ~/notes
gno setup ~/notes --name notes --exclude .env --exclude private
gno --offline setup ~/notes
gno setup ~/notes --no-semantic
gno setup ~/notes --connector codex-skill
gno setup ~/notes --connector cursor-mcp --connector codex-skill
gno setup ~/notes --json
```

The command creates or reuses the collection, synchronizes the lexical index,
and runs a corpus-derived BM25 query. It reports success only when that query
returns an exact `gno://` result URI. Rerunning the same canonical folder is
idempotent: it reuses the collection and resumes from the durable local setup
receipt.

`--exclude` is repeatable and literal; it is not a comma-separated list. If GNO
finds likely env files, credentials, or private keys, terminal use asks once
with a default of No. `--authorize-secret-risk` is the only pre-authorization.
`--yes`, JSON mode, non-terminal input, decline, and EOF never authorize likely
secrets.

After lexical proof, semantic indexing starts in a detached one-shot process.
The command returns immediately without starting or contacting `gno serve`,
`gno daemon`, MCP, or another resident process. Its private receipt records
scheduled/running/completed/failed/pending/skipped state and the exact
foreground fallback command. A live worker remains authoritative until it
exits, even when a rerun requests different semantic options, so its completion
receipt cannot be stranded. Model download, partial embedding, vector-sync, or
worker-launch failures do not invalidate proven lexical search:

```bash
# Printed in the setup result when background semantic work needs attention
gno --index default --config /path/to/index.yml embed notes
```

Use `--no-semantic` to record semantic work as skipped. Use `--json` for one
closed result on stdout; progress is suppressed. Without `--connector`, the
payload remains the unchanged `setup-command-result@1.0`. With one or more
explicit connector IDs, it is `setup-activation-result@1.0`, containing the
unchanged setup result plus bounded per-target install and verification state.
Connector-mode argument or lexical failure still uses that outer schema with
`status: failed` and an empty connector list; the nested setup result and exit
code remain unchanged, and no connector action runs.

Supported connector IDs are `claude-code-skill`, `claude-desktop-mcp`,
`cursor-mcp`, `codex-skill`, `opencode-skill`, `openclaw-skill`, and
`hermes-skill`. Exact repeats dedupe. Existing entries are reused without
overwrite; missing entries use the read-only installer only after lexical
success. MCP targets run a bounded retrieval smoke. Skill targets report
`target_runtime_unverifiable`, because setup cannot safely execute the host
agent runtime. Connector follow-up keeps lexical setup successful and exit 0,
with `completed_with_actions` and bounded remediation. Direct setup remains
standalone and never attaches to a resident runtime.

Terminal progress is stderr-only, and `--quiet` suppresses it while preserving
the final result.

## Search Commands

### Private retrieval receipts

With `retrievalTraces.enabled: true`, successful `search`, `vsearch`, `query`,
`ask`, `get`, and `context build` calls print `Trace: <traceId>` to stderr.
Normal stdout—including JSON—is unchanged. Retrieval-only calls keep that
trace open so a later exact read can be linked:

```bash
gno query "deployment decision"
# stderr: Trace: <traceId>
gno get gno://work/decisions/deploy.md --from 40 -l 20 --trace-id <traceId>
```

Tracing disabled: no ID generation, fingerprint work, local receipt write, or
stderr receipt. See [Configuration](./CONFIGURATION.md#private-retrieval-traces).

### gno search

Full-text search using document-level BM25 with Snowball stemmer.

```bash
gno search "project deadlines"
gno search "error handling" -n 5
gno search "auth" --json
gno search "meeting" --files
```

**Document-level indexing**: Finds documents where terms appear anywhere, even across sections. "authentication JWT" matches docs with those terms in different parts.

**Snowball stemming**: "running" matches "run", "scored" matches "score", plurals match singulars.

**Lexical query rules**: `gno search` uses a small explicit FTS grammar:

- plain terms use prefix matching
- quoted phrases are supported: `"zero downtime deploy"`
- negation is supported only with at least one positive term: `dashboard -lag`
- hyphenated technical terms like `real-time`, `gpt-4`, and `DEC-0054` are handled intentionally
- malformed lexical syntax returns a validation error instead of leaking raw SQLite FTS errors

**Recency intent sorting**: Queries containing `latest`, `newest`, or `recent` are ordered newest-first using frontmatter date when present, falling back to file modified time.

Options:

- `-n, --limit <n>` - Limit results (default: 5; 20 with --json/--files)
- `--min-score <n>` - Minimum score threshold (0-1)
- `--full` - Show full document content (not just snippet)
- `--line-numbers` - Show line numbers in snippets
- `--lang <code>` - Filter by detected language in code blocks
- `--since <date>` - Modified-at lower bound (ISO date/time or token like `today`, `last week`, `recent`)
- `--until <date>` - Modified-at upper bound (ISO date/time or token)
- `--category <values>` - Require matching category/content type (comma-separated)
- `--author <text>` - Author contains text (case-insensitive)
- `--intent <text>` - Disambiguating context for ambiguous queries; steers snippet selection without searching on this text
- `--exclude <values>` - Exclude docs containing any comma-separated term in title/path/body
- `--tags-all <tags>` - Filter: docs must have ALL tags (comma-separated)
- `--tags-any <tags>` - Filter: docs must have ANY tag (comma-separated)

Examples:

```bash
gno search '"zero downtime deploy"'
gno search 'dashboard -lag'
gno search 'DEC-0054'
```

JSON results include a top-level `line` anchor when the matching chunk is known.
For non-default indexes, emitted `gno://` URIs include output-only index
metadata, e.g. `gno://docs/api.md?index=research`; readers such as `gno get`
can round-trip that URI back to the named index.

### gno vsearch

Semantic similarity search using vector embeddings with contextual chunking.

```bash
gno vsearch "how to handle errors gracefully"
gno vsearch "authentication best practices" --json
```

**Contextual embeddings**: Each chunk is embedded with its document title prepended, helping the model distinguish context (e.g., "configuration" in React vs database docs).

Same options as `gno search`, including temporal/category/author and tag filters. Requires embed model.

If sqlite-vec cannot load at runtime, `gno vsearch` fails with the preserved
load/probe reason and a `gno doctor` recovery hint. BM25 search continues to
work; `gno query` degrades to BM25-only and includes the vector reason in
`--explain`.

If `--intent` is provided, vector search uses it only to steer snippet selection toward the intended interpretation. It is not embedded or searched directly.

### gno query

Hybrid search combining BM25 and vector results. This is the recommended search command for most use cases.

```bash
gno query "database optimization"
gno query "API design patterns" --explain
gno query "auth" --fast              # Fastest: ~0.7s
gno query "auth" --thorough          # Full pipeline: ~5-8s
gno query "auth" --tags-all work,backend   # Filter by tags
gno query "performance" --intent "web performance and latency"
gno query "auth" --graph             # Enable graph-neighbor candidates
gno query diagnose "Alice Acme" --target gno://notes/people/alice.md --json
gno query "auth flow" --query-mode term:"jwt refresh token" --query-mode intent:"how refresh token rotation works"
gno query $'auth flow\nterm: "refresh token"\nintent: token rotation'
```

**Search modes**:

- **Default** (~2-3s on slim): Preset-aware balanced mode. On `slim` / `slim-tuned`, uses expansion + reranking; on larger presets, keeps reranking on and expansion off by default.
- `--fast` (~0.7s): Skip query expansion and reranking. Use for quick lookups.
- `--thorough` (~5-8s): Expansion + reranking with a wider candidate pool. Best recall.

**Pipeline features**:

- **Strong signal detection**: Skips expensive LLM expansion when BM25 has confident match
- **2× weight for original query**: Prevents dilution by LLM-generated variants
- **Tiered top-rank bonus**: +0.05 for #1, +0.02 for #2-3
- **Graph-aware expansion**: Adds capped one-hop neighbors from top seeds; explicit links outrank inferred, ambiguous, and similarity edges
- **Chunk-level reranking**: Best chunk per doc (4K max) for 25× faster reranking
- **Lexical top-hit protection**: Preserves original BM25 #1 exact hits against rerank-only demotion

Additional options:

- `--fast` - Skip query expansion and reranking (fastest, ~0.7s)
- `--thorough` - Use the widest retrieval/rerank budget (slower, best recall)
- `--no-expand` - Disable query expansion
- `--no-rerank` - Disable cross-encoder reranking
- `--graph` - Enable bounded one-hop graph neighbor expansion
- `--no-graph` - Compatibility no-op; graph expansion is off unless `--graph` is passed
- `--intent <text>` - Disambiguating context for ambiguous queries. Steers expansion, rerank chunk/snippet choice, and disables strong-signal bypass, but is not searched directly.
- `--exclude <values>` - Hard-prune docs containing any comma-separated term in title/path/body
- `-C, --candidate-limit <n>` - Max candidates passed to reranking (default: 20)
- `--query-mode <mode:text>` - Structured expansion hints; repeat for multiple entries. Modes: `term`, `intent`, `hyde`
- `--explain` - Show detailed scoring breakdown (to stderr)
- `--since <date>` - Modified-at lower bound (ISO date/time or token)
- `--until <date>` - Modified-at upper bound (ISO date/time or token)
- `--category <values>` - Require matching category/content type
- `--author <text>` - Author contains text (case-insensitive)
- `--tags-all <tags>` - Filter: docs must have ALL tags
- `--tags-any <tags>` - Filter: docs must have ANY tag

**Target diagnostics**:

`gno query diagnose "<query>" --target <doc>` runs the query with an opt-in
trace and reports whether the target document appears at each retrieval stage.
The JSON payload uses the closed `query-diagnose.schema.json` contract.
Requests without trusted local affinity metadata retain the exact legacy
`schemaVersion: "1.0"` shape and omit `affinity`; the unchanged closed v1
contract remains available as `query-diagnose-v1.schema.json`. When a trusted
cwd or `--project-root` is resolved, the payload uses `schemaVersion: "1.1"`
and requires closed, redacted `affinity` metadata, including `matched: false`
when the trusted root does not match the target collection. The payload also
includes `target.status`
(`not_found|inactive|no_indexed_content|filtered_out|diagnosed`), per-stage
`present/rank/score/survived/dropReason`, typed metadata, graph hints, and the
chunk/line selected for the target. In BM25-only mode, vector/rerank stages are
reported as skipped while fusion remains active with `sourceCount: 1`.

**Migration notes (retrieval v2):**

- Existing calls keep working (`gno query "..."`, `--fast`, `--thorough`, `--no-expand`, `--no-rerank`).
- `--intent` is orthogonal to `--query-mode`: intent steers scoring/prompting, while query modes inject caller-provided retrieval expansions.
- `--query-mode` is opt-in for explicit intent control and replaces generated expansion for that query.
- Graph-neighbor expansion is opt-in: pass `--graph` when linked context matters. If graph data, embeddings, or similarity edges are unavailable, query falls back to the normal BM25/vector path.
- Use `term` for exact lexical constraints, `intent` for semantic reformulations, and `hyde` for one hypothetical answer passage.
- Multi-line structured query documents are also supported. See [Structured Query Syntax](./SYNTAX.md).
- In terminal output, `gno search`, `gno vsearch`, and `gno query` can wrap the visible `gno://...` URI in an OSC 8 hyperlink when stdout is a TTY. Configure the target with `editorUriTemplate` in `~/.config/gno/index.yml` or override it with `GNO_EDITOR_URI_TEMPLATE`. Env override wins. If unset, GNO falls back to `file://` links using absolute paths when available.

```bash
# Existing call (still valid)
gno query "auth flow" --thorough

# Retrieval v2 structured call
gno query "auth flow" \
  --query-mode term:"jwt refresh token -oauth1" \
  --query-mode intent:"how refresh token rotation works" \
  --query-mode hyde:"Refresh tokens rotate on each use and previous tokens are revoked."

# Multi-line structured query document
gno query $'auth flow\nterm: "refresh token" -oauth1\nintent: how refresh token rotation works\nhyde: Refresh tokens rotate on each use and previous tokens are revoked.'
```

The `--explain` flag outputs:

- BM25 scores per result
- Vector similarity scores
- RRF fusion scores (with variant weights)
- `skipped_strong` indicator if expansion was skipped
- Rerank scores (if enabled)
- Final blended scores
- Per-stage timing breakdown (`lang`, `expansion`, `bm25`, `vector`, `fusion`, `rerank`, `assembly`, `total`)
- Fallback/counter summary (`fallbacks=...`, cache counters for expansion/rerank)

See [How Search Works](HOW-SEARCH-WORKS.md) for details on the scoring pipeline.

### gno bench

Run a retrieval benchmark fixture against the current index.

```bash
gno bench docs/examples/bench-fixture.json
gno bench bench.json --mode bm25 --mode no-rerank --json
gno bench bench.json --top-k 5 --candidate-limit 40
```

Fixtures are JSON (`version: 1`) with `queries`, expected documents/URIs, optional `collection`, optional `modes`, and optional graded `judgments`.

Mode aliases:

- `bm25`
- `vector`
- `hybrid`
- `fast`
- `no-rerank`
- `thorough`

Output reports Precision@K, Recall@K, F1@K, MRR, nDCG@K, and latency summaries per mode. See [spec/bench-fixture.schema.json](../spec/bench-fixture.schema.json) and [bench-result.schema.json](../spec/output-schemas/bench-result.schema.json).

### gno ask

Search and optionally generate an AI answer. Combines retrieval with optional LLM-generated response.

```bash
gno ask "what is the project goal"
gno ask "summarize the auth discussion" --answer
gno ask "summarize the auth discussion" --verify
gno ask "explain the auth flow" --answer --show-sources
gno ask "explain the auth flow" --verify --show-sources
gno ask "quick lookup" --fast            # Fastest retrieval
gno ask "complex topic" --thorough       # Best recall
gno ask "performance" --intent "web latency and vitals"
gno ask "performance" --query-mode term:"web performance budgets" --query-mode intent:"latency and vitals" --no-answer
gno ask $'term: web performance budgets\nintent: latency and vitals' --no-answer
```

**Full-document context**: When `--answer` is used, GNO passes complete document content to the generation model, not truncated snippets. This ensures the LLM sees tables, code examples, and full context needed for accurate answers.

**Adaptive source selection**: `gno ask --answer` picks context sources using relevance + query coverage + facet coverage (instead of fixed top-N). Comparison queries (`vs`, `compare`, `difference`) force at least two competing sources when available.

**Verified synthesis**: `gno ask --verify` is an explicit closed-evidence mode.
It builds one token- and byte-budgeted Context Capsule, generates only from
retained Capsule sections, and classifies every substantive claim as
`supported`, `contradicted`, `insufficient`, or `uncertain`. GNO returns a
verified answer only when substantive-claim support coverage is exactly 100%;
otherwise it withholds the answer and reports abstention. Citations retain exact
Capsule evidence IDs, URIs, and line spans. `--show-sources` lists the Capsule
evidence used by the verifier.

The semantic verifier fails closed. An unavailable, incapable, failed, or
malformed verifier cannot turn a claim into supported evidence; unresolved
claims become uncertain and the answer abstains. Verified synthesis also checks
the retained evidence's source and mirror freshness before trusting a support
judgment.

`--verify` is a support classification against one closed Capsule, not a
general factual guarantee. It cannot prove that the corpus is complete or that
the underlying sources are true. Plain `gno ask`, `--no-answer`, and the
existing `--answer` full-document workflow remain compatible and unchanged.

**Configured guidance**: Structured `search`, `vsearch`, `query`, and `ask`
results may include `context`. It contains matching user configuration ordered
global → collection → broad-to-specific path prefix while preserving the
source's exact `uri` and `docid`. Ask treats this guidance as trusted
configuration in a prompt section separate from untrusted retrieved content.

**Preset requirement**: For documents with markdown tables or structured data, use the `quality` preset (`gno models use quality`). Smaller models cannot reliably parse tabular content. This only applies to standalone `--answer` usage. When AI agents (Claude Code, Codex) call GNO via MCP/skill/CLI, they handle answer generation.

Options:

- `--fast` - Skip expansion and reranking (fastest)
- `--thorough` - Enable query expansion (slower, better recall)
- `--intent <text>` - Disambiguating context for ambiguous questions without searching on that text
- `--exclude <values>` - Hard-prune docs containing any comma-separated term in title/path/body
- `--query-mode <mode:text>` - Structured expansion hints; repeat for multiple entries. Modes: `term`, `intent`, `hyde`
- Multi-line structured query documents are also supported. See [Structured Query Syntax](./SYNTAX.md).
- `-C, --candidate-limit <n>` - Max candidates passed to reranking (default: 20)
- `--answer` - Generate grounded AI answer (requires gen model)
- `--verify` - Generate against a closed Capsule and abstain unless every substantive claim is supported
- `--no-answer` - Force retrieval-only output
- `--max-answer-tokens <n>` - Limit answer length
- `--context-budget-tokens <n>` - Verified Capsule token budget
- `--context-budget-bytes <n>` - Verified Capsule byte budget
- `--show-sources` - Show all retrieved sources, not just cited ones
- `-n, --limit <n>` - Max source results
- `--since <date>` - Modified-at lower bound (ISO date/time or token)
- `--until <date>` - Modified-at upper bound (ISO date/time or token)
- `--category <values>` - Require matching category/content type
- `--author <text>` - Author contains text (case-insensitive)

JSON output includes `meta.answerContext` with selected/dropped source explain details.
JSON output also includes `meta.queryModes` when structured query modes are supplied.

- `-c, --collection <name>` - Filter by collection
- `--lang <code>` - Language hint (BCP-47)
- `--tags-all <tags>` - Filter: docs must have ALL tags
- `--tags-any <tags>` - Filter: docs must have ANY tag

## Capture Commands

### gno capture

Capture a note into an editable collection with structured provenance.

```bash
gno capture "thought to remember"
gno capture --stdin --collection notes --preset source-summary --tags inbox,gno
gno capture --file ./clip.md --source-url https://example.com --source-kind web --json
gno capture "meeting note" --quiet
```

Content source modes are mutually exclusive: inline argument, `--stdin`, or
`--file`. Content is required unless `--preset` can scaffold a non-empty note.
All capture inputs must be text; binary-like file/stdin content is rejected
before writing.

Preset IDs: `blank`, `project-note`, `research-note`, `decision-note`,
`prompt-pattern`, `source-summary`, `idea-original`, `person`,
`company-project`, `meeting`.

Second-brain presets use a synthesis/timeline pattern: keep the current
assessment above `## Timeline`, then place dated evidence below it. Use
`idea-original` for exact idea phrasing and related concepts, `person` for
relationship and current-state notes, `company-project` for organizations or
active workstreams, and `meeting` when transcript, raw notes, and action items
should live below the analysis.

Path behavior:

- `--path` writes to an explicit relative path.
- `--folder` and `--title` create a safe markdown path.
- With no path, folder, or title, GNO writes to
  `inbox/YYYY-MM-DD/capture-<body-hash>.md` using UTC capture time.
- `--collision-policy` accepts `error`, `open_existing`, or
  `create_with_suffix`.
- Collision checks include indexed documents and disk-only files.
- Capture writes use exclusive create semantics so a late-arriving file fails
  instead of being replaced.

Provenance flags write structured `source:` frontmatter. `--source-date` maps to
`source.observedAt`; `--source-id` maps to `source.externalId`. `--json` returns
the shared capture receipt with write, sync, and embed status; quiet mode prints
only the URI.

Browser-clip receipts extend that same contract with optional normalized source
fields and closed `source.browserClip` provenance: extraction mode, exact
selection when applicable, extraction/final hashes, deterministic clip/preview
digests, browser metadata, capture time, and bounded warnings. Existing CLI
capture inputs are unchanged. A browser clip using `open_existing` opens only a
note with the same stored `clipIdentity`; missing or different provenance is an
explicit conflict. `create_with_suffix` creates a distinct note.

## Document Commands

### gno get

Retrieve document content by reference. Supports multiple reference formats:

- `#abc123` - Document ID (hash prefix)
- `gno://collection/path/to/file` - Virtual URI
- `collection/path` - Collection + relative path

```bash
gno get abc123def456
gno get "gno://notes/projects/readme.md"
gno get notes/projects/readme.md --json
gno get abc123 --from 50 -l 100  # Lines 50-150
```

Options:

- `--from <line>` - Start output at line number (1-indexed)
- `-l, --limit <lines>` - Limit to N lines
- `--line-numbers` - Prefix lines with numbers
- `--trace-id <id>` - Continue an open query receipt and record the exact returned span
- `--source` - Include source metadata

### gno multi-get

Retrieve multiple documents at once.

```bash
gno multi-get abc123 def456 ghi789
gno multi-get abc123 def456 --max-bytes 10000
```

Options:

- `--max-bytes <n>` - Limit bytes per document (truncates long docs)

### gno ls

List indexed documents. Optional scope argument filters results.

```bash
gno ls                    # All documents
gno ls notes              # Documents in 'notes' collection
gno ls gno://notes/proj   # Documents under path prefix
gno ls --json
gno ls --files
```

Options:

- `[scope]` - Filter by collection name or URI prefix

## Collection Commands

### gno collection add

Add a collection to index.

```bash
gno collection add ~/notes --name notes
gno collection add ~/code --name code --pattern "**/*.ts" --exclude node_modules
gno collection add ~/work/gno/src --name gno-code --embed-model "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
```

Options:

- `-n, --name <name>` - Collection identifier (required)
- `--pattern <glob>` - File matching pattern
- `--include <exts>` - Extension allowlist (CSV)
- `--exclude <patterns>` - Exclude patterns (CSV)
- `--embed-model <uri>` - Initial collection-specific embedding model override
- `--update <cmd>` - Shell command to run before indexing

Use `--embed-model` when one collection should use a different embedding model from the active global preset.

### gno collection list

List configured collections.

```bash
gno collection list
gno collection list --json
```

### gno collection remove

Remove a collection.

```bash
gno collection remove notes
```

### gno collection rename

Rename a collection.

```bash
gno collection rename notes work-notes
```

### gno collection clear-embeddings

Clear embeddings for one collection.

```bash
gno collection clear-embeddings notes          # Safe default: stale models only
gno collection clear-embeddings notes --all    # Remove every embedding for this collection
```

Behavior:

- default mode is `stale`
- `stale` removes models that are no longer the active embed model for that collection
- `all` removes every embedding for that collection and then you should run:

```bash
gno embed --collection notes
```

Shared vectors still referenced by other active collections are retained.

### gno embed

Generate embeddings for all collections or one collection.

```bash
gno embed
gno embed travel
gno embed --collection travel
```

If you only want one collection to catch up after a model change, use the
positional collection argument or `--collection`.

If the active embedding model keeps the same URI but changes formatting/profile
behavior, `stale` cleanup is not enough because the vectors are still tagged
with the same model URI. In that case, use either:

```bash
gno embed --force
```

or a per-collection reset:

```bash
gno collection clear-embeddings notes --all
gno embed --collection notes
```

If a run still hits model/runtime problems, use verbose mode to see concrete
sample failures and GNO's retry hint:

```bash
gno --verbose embed --force
gno --verbose embed --collection notes
```

If the error mentions `Object is disposed`, rerun the command once. GNO now
resets the embedding port automatically after that class of node-llama-cpp
failure, but a fresh rerun is still the safest last resort when a run was
interrupted mid-way.

## Indexing Commands

### gno update

Sync files from disk into the index (BM25/FTS only, no embeddings). Incremental - only processes files changed since last sync.

```bash
gno update
gno update --git-pull       # Pull git repos first
```

Options:

- `--git-pull` - Run `git pull` in git repositories

Use `gno update` when you only need keyword search, or when you want to quickly sync changes and run `gno embed` separately.

Password-protected PDFs and XLSX files are recorded as per-file `PERMISSION`
errors and skipped without aborting the rest of the run.

### gno index

Full index end-to-end: runs `gno update` then `gno embed`. This is the recommended command for most users.

```bash
gno index                   # Index all collections
gno index notes             # Index specific collection
gno index --no-embed        # Skip embedding (same as gno update)
gno index --git-pull        # Pull git repos first
```

Options:

- `--collection <name>` - Scope to single collection
- `--no-embed` - Skip embedding phase
- `--models-pull` - Download models if missing
- `--git-pull` - Run `git pull` in git repositories

**Incremental**: Both `gno index` and `gno update` are incremental. Files are tracked by SHA-256 hash. Only new or modified files are processed. Unchanged files are skipped instantly.

**Collection scoping**: `gno index notes` now scopes both sync and embedding to
`notes`. It no longer burns through unrelated embedding backlog from other
collections.

### gno embed

Generate embeddings for indexed chunks.

On CPU-only machines, GNO uses a small adaptive pool of embedding contexts to
keep more cores busy. If RAM is tight, it automatically falls back to fewer
contexts.

```bash
gno embed
gno embed notes
```

## Private Retrieval Trace Commands

When retrieval traces are enabled, use the receipt ID printed on stderr to
inspect and explicitly label the local evidence path:

```bash
gno trace list --md
gno trace show <trace-id> --json
gno trace label <trace-id> --label relevant \
  --target gno://notes/decision.md
gno trace label <trace-id> --label missing-expected \
  --target '#abcdef'
```

Relevant and irrelevant labels must match evidence already recorded by that
trace. Missing-expected labels accept only a `gno://` URI, docid, or immutable
source hash; GNO does not copy document text into the judgment. Retrying the
same label is idempotent. A later correction is appended instead of rewriting
history.

Build one deterministic receipt from immutable terminal traces:

```bash
gno trace export <trace-id> <another-trace-id> --output traces.json
gno trace export <trace-id> --format qrels --output qrels.json
```

Open traces cannot be exported. Completed, partial, failed, and cancelled
outcomes stay distinct and never become implicit negative labels.
Qrels export additionally requires replay-mode receipts with complete query,
filter, rank, hash, and exact-span provenance. It writes only content-free
identities and outcomes; source and mirror text are not copied.

Compare that immutable qrels baseline with a candidate retrieval pipeline:

```bash
gno trace replay <qrels-export-id> --candidate bm25 --md
gno trace replay <qrels-export-id> --candidate hybrid \
  --candidate-limit 100 --no-expand --json
```

Replay verifies the local aggregate manifest before running, reports final
rank separately from planner rank, classifies sources as unchanged, stale,
missing, inactive, or unindexed, and preserves capability/fallback truth. It
can recommend promotion but always returns `applied: false`; it never edits
ranking, prompts, models, configuration, traces, or user files.

Delete one receipt or purge all local receipt data:

```bash
gno trace delete <trace-id>
gno --yes trace purge --json
```

The purge receipt reports `physicalCleanup` as `completed`, `wal_busy`, or
`failed`; only `completed` confirms the SQLite WAL was truncated. Recording
can be disabled without disabling management of receipts already stored.

## Context Commands

Contexts add semantic hints to improve search relevance.

### gno context add

```bash
gno context add "/" "Global search context"
gno context add "notes:" "Personal notes and journal entries"
gno context add "gno://notes/projects" "Active project documentation"
```

Matching contexts appear in structured retrieval output; they guide agents and
grounded answers but are not searched and do not boost ranking. Multiple scopes
compose from global to most-specific prefix. Results without a match omit the
optional `context` field.

### gno context list

```bash
gno context list
```

### gno context check

Validate context configuration.

```bash
gno context check
```

### gno context build

Compile a goal into a deterministic, citation-complete evidence Capsule:

```bash
gno context build "launch decision" --budget 12000 --json
gno context build "compare the proposals" --budget 16000 --collection work --md
gno context build "release evidence" --budget 12000 --fast --output capsule.json
```

The budget applies to the complete canonical payload, not separately to each
document. Evidence keeps exact canonical-mirror line ranges and source, mirror,
and passage hashes. Selection collapses duplicates, rewards uncovered query
facets, and records every omission and gap. `--fast` avoids model loading;
default and `--thorough` use available semantic/rerank capabilities and record
fallbacks when attempted but unavailable. The persisted retrieval plan records
normalized author/language/query-mode filters, effective limits, graph request,
and requested/attempted/outcome state. A capability that was not requested is
reported as `not_requested`, not as an availability failure. Unknown requested
collections fail validation before retrieval. Tag filters are NFC-normalized,
lowercased, deduplicated, and validated. Result and candidate limits are global
across repeated collections: result admission is capped after the merged rank,
and rerank/graph candidate work is distributed deterministically in canonical
collection order.

JSON is deterministic and machine-readable. Markdown is a readable projection
of the same Capsule with untrusted passages explicitly delimited. Each passage,
metadata object, and canonical manifest uses a collision-resistant Markdown
fence whose width and character are derived from that block, so source text
cannot forge a closing boundary. Indexed title, heading, and configured-context
text remains JSON-escaped; passage bytes remain exact.
Use
`--output <file>` for explicit file output; GNO never saves Capsules implicitly.
Progress stays on stderr, leaving stdout or the output file clean.

Filters include repeatable `--collection`, `--uri-prefix`, `--tags-all`,
`--tags-any`, `--category`, `--author`, `--lang`, `--since`, and `--until`.
`--query` can separate the retrieval query from the stated goal; repeatable
`--query-mode term:...|intent:...|hyde:...` entries become part of the frozen
normalized retrieval request.

### gno context verify

Recheck a saved Capsule without rebuilding it:

```bash
gno context verify capsule.json --json
cat capsule.json | gno context verify - --md
```

The receipt classifies each evidence item as unchanged, stale, or missing and
ranking as unchanged, reranked, or unavailable. It includes fingerprint drift
independently from ranking plus current source, mirror, and passage hashes when
known. No rank resolver means `ranking_unavailable`; stale or missing content
is never ranked.

With no global `--index`, verification opens the Capsule's saved index. An
explicit global `--index` must match that index; mismatches fail before GNO
opens a store. Verification of an `active_tokenizer` Capsule requires the
matching tokenizer fingerprint and deterministic token counter before GNO
opens the store; runtimes without that tokenizer return `tokenizer_unavailable`
and never trust saved `usedTokens` alone.

### gno context watch

Register an explicitly saved Capsule file for automatic reverification:

```bash
gno context watch capsule.json --question "Who owns launch?" --label launch
gno context watch capsule.json --notify --json
```

GNO stores registration metadata and exact evidence hash references—not the
Capsule body or passage text. The original file remains caller-owned; GNO never
rewrites it. The file's canonical index is used unless an explicit global
`--index` is supplied, in which case it must match.

`serve` and `daemon` coalesce settled document-journal changes and reverify only
registrations whose evidence changed. Restart resumes from a durable journal
high-water mark; an expired cursor causes one conservative bounded pass. The
saved verification is the same canonical, non-generative receipt returned by
`gno context verify`. File changes, missing files, index mismatches, and other
operation failures remain distinct from completed receipts.

`--notify` publishes a local `capsule-reverified` event only after the result is
stored. The event is metadata-only: registration/Capsule identity, operation
status, affected-question state, and timestamp.

Manage registrations:

```bash
gno context watches
gno context watches --json
gno context reverify capsule-abc123 --json
gno context unwatch capsule-abc123
```

Registrations are scoped to one index database. `watches`, `reverify`, and
`unwatch` therefore use the matching global `--index` when the registration is
not in the default index. JSON is governed by the closed Draft-07
`saved-capsule-watch`, `saved-capsule-list`, `saved-capsule-unwatch`, and
`saved-capsule-reverification` schemas. Completed reverification contains a
canonical receipt; operation failure contains no receipt. These lifecycle
commands are CLI-only—REST, MCP, and SDK do not add persistent watch endpoints.

Manual reverification exits `0` only for a completed operation. A failed
operation remains visible: terminal output prints its code and message, while
`--json` preserves the closed structured failure object on stdout. The process
then exits `2`, so scripts cannot mistake a persisted failure for successful
verification.

### gno context rm

```bash
gno context rm "/"
```

## Model Commands

### gno models list

List available and cached models.

```bash
gno models list
gno models list --json
```

### gno models use

Switch model preset. Changes take effect on next search.

```bash
gno models use slim-tuned # Current default, tuned expansion
gno models use slim       # Untuned slim expansion
gno models use balanced   # Qwen2.5 3B expansion + answers
gno models use quality    # Qwen3 4B expansion + answers
```

If the preset switch changes the embedding model, GNO now tells you directly:

```bash
gno models use quality
# ...
# Embedding model changed. Run: gno embed
```

That keeps old vectors intact, but marks the new model as the active target. Run
`gno embed` so vector and hybrid retrieval catch up to the new preset.

### gno models pull

Download models.

```bash
gno models pull --all
gno models pull --embed
gno models pull --rerank
gno models pull --expand
gno models pull --gen
gno models pull --force   # Re-download even if cached
```

Downloaded and cached local GGUF files are validated before use. If a proxy,
firewall, captive portal, or HTML error page is cached instead of a GGUF, GNO
removes the bad cached file and reports a specific recovery error. Explicit
`file:` or absolute model paths are validated but never deleted.

### Using A Fine-Tuned GGUF

If you have exported a fine-tuned GGUF, point a custom preset at it:

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

Then use it normally:

```bash
gno models use slim-tuned
gno query "ECONNREFUSED 127.0.0.1:5432" --thorough
```

Recommended workflow:

1. benchmark the exported model first
2. keep the tuned model in a custom preset
3. only replace defaults after repeated measured wins

See [Fine-Tuned Models](FINE-TUNED-MODELS.md) for the full promotion and troubleshooting workflow.

### gno models clear

Remove cached models.

```bash
gno models clear
```

### gno models path

Show model cache directory.

```bash
gno models path
```

### gno publish export

Export one active document or collection as a reader-safe gno.sh artifact:

```bash
gno publish export work-docs --out ~/Downloads/work-docs.json
gno publish export "gno://work-docs/runbooks/deploy.md"
gno publish export "gno://work-docs/runbooks/deploy.md" \
  --visibility encrypted \
  --passphrase "correct horse battery staple"
```

Options are `--out`, `--visibility`, `--passphrase`, `--slug`, `--title`,
`--summary`, `--preview`, and `--json`. Without `--out`, GNO writes to the
platform Downloads directory. A note with `publish: false` is refused; such
notes are omitted from collection exports.

Public artifacts include the canonical
`gno://schemas/publish-artifact@1.0` manifest: stable projection revision,
published Markdown paths and line locators, SHA-256 content/evidence identity,
and closed public reader capabilities. Local source paths and source URIs are
not exported. Metadata values containing embedded local path or GNO/file URI
tokens are omitted; canonical and image fields accept only uncredentialed
public HTTP(S) targets. Secret-link and invite-only artifacts contain the
requested reader projection but no agent manifest or capability flags.
Encrypted artifacts expose only ciphertext metadata and an opaque share token;
GNO never adds plaintext evidence outside the encrypted payload. The V2
builder emits a closed projection and validates bounded base64 payload fields,
the positive safe-integer KDF iteration count, route/source identity, and the
bounded opaque token before export.

See [Publishing to gno.sh](PUBLISHING.md) for the visibility, public-agent,
privacy, verification, and current commercial boundaries.

## Skill Commands

Install GNO as a skill for AI coding assistants (Claude Code, Codex, OpenCode, OpenClaw, Hermes Agent).

### gno skill install

Install the GNO skill files, including nested recipe playbooks.

```bash
gno skill install                    # Project scope, Claude target
gno skill install --scope user       # User-wide installation
gno skill install --target codex     # For Codex instead of Claude
gno skill install --target hermes    # For Hermes Agent
gno skill install --target all       # All supported agents
gno skill install --force            # Overwrite existing
```

Options:

- `--scope <project|user>` - Installation scope (default: project)
- `--target <claude|codex|opencode|openclaw|hermes|all>` - Target agent (default: claude)
- `--force` - Overwrite existing installation

Supported targets: Claude Code, Codex, OpenCode, OpenClaw, Hermes Agent. Use `all` to install to every target.

### gno skill uninstall

Remove installed skill.

```bash
gno skill uninstall
gno skill uninstall --scope user
gno skill uninstall --target all
```

Options:

- `-s, --scope <project|user>` - Scope to uninstall from (default: project)
- `-t, --target <claude|codex|opencode|openclaw|hermes|all>` - Target to uninstall from (default: claude)

### gno skill show

Preview skill files without installing.

```bash
gno skill show
gno skill show --file SKILL.md
gno skill show --file recipes/brain-first-lookup.md
gno skill show --all
```

Options:

- `--file <name>` - Show specific markdown file only, including safe nested paths like `recipes/brain-first-lookup.md`
- `--all` - Show all skill markdown files

`--file` accepts relative POSIX markdown paths inside the bundled skill asset directory. Absolute paths, `..`, backslashes, and non-markdown paths are rejected.

### gno skill paths

Show installation paths for all scope/target combinations.

```bash
gno skill paths
gno skill paths --json
```

See [Using GNO with AI Agents](USE-CASES.md#ai-agent-integration) for setup guide.

## Tag Commands

Manage document tags. Tags are extracted from markdown frontmatter during sync.

**Tag format**: lowercase alphanumeric, hyphens, dots, slashes for hierarchy (e.g., `project/web`, `status.active`).

### gno tags

List all tags with document counts.

```bash
gno tags                    # All tags
gno tags --collection notes # Tags in collection
gno tags --json
```

### gno tags add

Add tag(s) to a document.

```bash
gno tags add abc123 work
gno tags add abc123 project/alpha urgent
```

### gno tags rm

Remove tag(s) from a document.

```bash
gno tags rm abc123 obsolete
gno tags rm abc123 draft wip
```

Tag changes update the document's YAML frontmatter on disk.

## Link Commands

Navigate document relationships via wiki links and markdown links.

### gno links

List outgoing links from a document.

```bash
gno links gno://notes/source.md        # List all links
gno links #abc123 --type wiki          # Wiki links only
gno links source.md --edge-type mentions --json
gno links source.md --relation mentions --json
gno links source.md --json
```

Options:

- `--type <wiki|markdown>` - Filter positional links by syntax
- `--edge-type <type>`, `--relation <type>` - Filter semantic relationship edges
- `--json`, `--md` - Output format

Default output shows positional link type, target, display text, line/column, and whether the target resolves to an indexed document. `--edge-type`/`--relation` are aliases for the same semantic edge type filter; either switches to the semantic edge layer and returns `edgeType`, `relationType`, `confidence`, and `edgeSource`. They cannot be combined with `--type`, and if both aliases are supplied they must match.

### gno backlinks

List documents that link TO a target document.

```bash
gno backlinks gno://notes/target.md
gno backlinks #abc123 --collection notes
gno backlinks target.md --relation related_to --json
gno backlinks target.md --json
```

Options:

- `-c, --collection <name>` - Filter by source collection
- `--edge-type <type>`, `--relation <type>` - Filter semantic relationship backlinks
- `--json`, `--md` - Output format

### gno similar

Find semantically similar documents using vector embeddings.

```bash
gno similar gno://notes/note.md
gno similar #abc123 --limit 10 --threshold 0.5
gno similar doc.md --cross-collection --json
```

Options:

- `-n, --limit <num>` - Max results (default: 5)
- `--threshold <num>` - Minimum similarity (default: 0.7)
- `--cross-collection` - Search across all collections
- `--json`, `--md` - Output format

**Requirements**: Embeddings must be generated with `gno embed` or `gno index`.
**Similarity basis**: Uses the doc's `seq=0` embedding (falls back to first chunk).

### gno graph

Export knowledge graph of document links (wiki links, markdown links, similarity edges).
JSON output includes a `report` block with hubs, bridge candidates, isolated
documents, unresolved-link counts, edge-type totals, and deterministic
community summaries.

```bash
gno graph                           # JSON output (default)
gno graph --dot                     # Graphviz DOT format
gno graph --mermaid                 # Mermaid diagram format
gno graph -c notes                  # Single collection
gno graph --include-similar         # Add similarity edges
gno graph --neighbors gno://notes/auth.md
gno graph --from gno://notes/a.md --to gno://notes/b.md
gno graph query gno://notes/auth.md --edge-type mentions --json
```

Options:

- `-c, --collection <name>` - Filter to single collection
- `--limit <n>` - Max nodes (default: 2000)
- `--edge-limit <n>` - Max edges (default: 10000)
- `--include-similar` - Include similarity edges
- `--threshold <num>` - Similarity threshold (default: 0.7)
- `--include-isolated` - Include nodes with no links
- `--similar-top-k <n>` - Similar docs per node (default: 5)
- `--neighbors <ref>` - Show incoming/outgoing graph neighbors for a document/node
- `--direction <both|out|in>` - Neighbor direction (default: `both`)
- `--from <ref>` / `--to <ref>` - Find shortest relationship path
- `--max-depth <n>` - Max path hops for `--from`/`--to` (default: 6)
- `--json` - JSON output (default)
- `--dot` - Graphviz DOT format
- `--mermaid` - Mermaid diagram format

#### `gno graph query`

Run a bounded typed-edge traversal from one document. It uses the typed
`doc_edges` projection, so `relations:` frontmatter and graph-hinted links can
be traversed by relation type.

Options:

- `--direction <both|out|in>` - Traversal direction (default: `both`)
- `--edge-type <type>` - Filter to one typed edge/relation
- `--max-depth <n>` - Maximum traversal depth (default: 2)
- `--max-nodes <n>` - Maximum returned nodes (default: 100)
- `--frontier-limit <n>` - Max frontier width per depth (default: 100)
- `--visited-limit <n>` - Max visited rows during traversal (default: 500)
- `--json` - JSON output using `graph-query.schema.json`

**Pipeline to Graphviz**:

```bash
gno graph --dot | dot -Tsvg > graph.svg
```

**Pipeline to Mermaid Live**:

```bash
gno graph --mermaid | pbcopy
# Paste into https://mermaid.live
```

Similarity edges use `seq=0` embeddings only.

## Knowledge Change Commands

```bash
gno changes --since 2026-07-20T00:00:00Z --json
gno diff gno://notes/plan.md --json
gno impact gno://notes/plan.md --max-depth 3 --max-edges 250 --json
```

- `gno changes` lists retained metadata-only lifecycle entries. `--since`
  accepts an ISO-8601 time or an opaque cursor returned by an earlier response.
- `gno diff` returns the latest retained structural delta; `--change <id>`
  selects an exact opaque change ID. Source bodies are never retained, and
  missing prior structure is disclosed through `history` and
  `structureDelta.truncated`.
- `gno impact` follows inbound typed, wiki, and Markdown dependencies. Depth,
  node, edge, frontier, and visited-row caps are always enforced, and every result
  includes an evidence path back to the changed document.
- Journal entries retain metadata and bounded structural summaries, not source
  bodies. Retention may expire an opaque cursor; that response returns no
  fabricated history and directs the caller to restart from the disclosed
  earliest cursor.
- Machine-readable contracts: `changes.schema.json`,
  `document-diff.schema.json`, and `impact.schema.json`.

## Admin Commands

### gno status

Show index status plus the shared retrieval activation contract.

```bash
gno status
gno status --json
```

`activation.usable` means at least one configured collection passed a local,
corpus-derived lexical retrieval proof; `activation.healthy` means every
configured collection passed. Status exits 0 even when those fields are false
so automation can inspect remediation. It does not start connector children,
initialize/download models, or invoke remote inference.

Semantic availability is separate: unknown resident capability is
`semantic_not_checked`; only a positively known unavailable vector runtime is
`vector_unavailable`. Connector status is a bounded passive projection of
explicit verification receipts. `connectorProjection.truncated` means omitted
target/collection pairs have no result and overall health is degraded.

JSON output includes a safe `resident-status@1.0` lifecycle projection. A
direct `gno status` invocation reports `mode:"direct-cli"` and
`resident:false`; it does not pretend to be attached to a live server.

### gno doctor

Check system health.

```bash
gno doctor
gno doctor --json
```

Checks include:

- config + database presence
- code-chunking mode + supported extensions
- SQLite FTS5 availability
- vendored `fts5-snowball` extension loading
- `sqlite-vec` extension loading
- local model cache readiness
- embedding fingerprint freshness: current fingerprint, pending/stale chunks,
  legacy empty-fingerprint vectors, and mixed stored fingerprint groups
- per-collection corpus-derived lexical retrieval proof
- passive projection of explicit connector proof receipts

Doctor exits 2 when lexical activation fails. Connector failures or a truncated
projection remain warnings for process-exit purposes but make the structured
doctor result non-healthy. Doctor never actively starts a connector or model.

### gno cleanup

Remove orphaned content.

```bash
gno cleanup
```

### gno reset

Reset to fresh state.

```bash
gno reset --confirm
```

### gno vec

Vector index maintenance. Use when vector search returns empty despite embeddings existing.

```bash
gno vec sync      # Sync vec0 index with content_vectors
gno vec rebuild   # Full rebuild of vec0 index
```

- `sync` - Fast incremental sync, fixes drift after failed inserts
- `rebuild` - Full rebuild, use when sync isn't enough
- `--json` - JSON output format

**When to use**: If `gno similar` returns empty results but embeddings exist, run `gno vec sync`.

## Output Formats

| Format   | Flag      | Use Case            |
| -------- | --------- | ------------------- |
| Terminal | (default) | Human reading       |
| JSON     | `--json`  | Scripting, parsing  |
| Files    | `--files` | Pipe to other tools |
| CSV      | `--csv`   | Spreadsheet import  |
| Markdown | `--md`    | Documentation       |
| XML      | `--xml`   | XML tooling         |

Example:

```bash
# Get file URIs for piping
gno search "important" --files | xargs gno get

# Parse JSON in scripts
gno search "test" --json | jq '.results[].uri'
```

## Exit Codes

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| 0    | Success                                                              |
| 1    | Validation error (bad input)                                         |
| 2    | Runtime error (IO, DB, model)                                        |
| 3    | `NOT_RUNNING` — `--status` / `--stop` found no live matching process |

Exit code `3` is reserved for `gno serve --status` / `--stop` and `gno daemon --status` / `--stop`. See [Long-Running Processes](#long-running-processes) below for the management contract.

## Long-Running Processes

Both `gno daemon` and `gno serve` ship with a symmetric set of management flags so you can self-background, inspect, and stop them without `nohup`, `launchd`, or `systemd` units. The contract is identical for both commands.

| Flag                | Purpose                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `--detach`          | Self-spawn a detached child; parent prints `pid` (+ url for serve) and exits 0. macOS/Linux only. |
| `--status`          | Read pid-file, check liveness, print status. Pair with `--json` for machine output.               |
| `--stop`            | SIGTERM the recorded pid, poll up to 10s, fall back to SIGKILL.                                   |
| `--pid-file <path>` | Override pid-file location (defaults to `{data}/{kind}.pid`).                                     |
| `--log-file <path>` | Override log-file location (append-only; defaults to `{data}/{kind}.log`).                        |

`--detach`, `--status`, and `--stop` are mutually exclusive (Commander emits a clean conflict error if you combine them).

**`--json` is gated to `--status`.** Passing `--json` with `--detach`, `--stop`, or the foreground path produces a `VALIDATION` error (exit 1). The message names the command you invoked:

```
--json is only supported with `gno serve --status`
--json is only supported with `gno daemon --status`
```

`--detach` writes a JSON pid-file at `{data}/{kind}.pid` containing `{pid, port, cmd, version, started_at}`. For `serve`, `port` hosts Web, REST, and MCP; for `daemon`, it hosts the headless MCP gateway. `{data}` resolves to `resolveDirs().data` (honours `GNO_DATA_DIR`); pass `--pid-file` to override.

**`--status` exit codes:**

- `0` — a live matching process was found; stdout carries the [process-status payload](../spec/output-schemas/process-status.schema.json) (terminal table without `--json`, JSON object with `--json`). JSON includes a best-effort copy of the live listener's redacted resident snapshot.
- `3` (`NOT_RUNNING`) — no live matching process. **The stdout payload is still emitted in JSON mode** so machine consumers always get the schema-shaped result; the `NOT_RUNNING` envelope only appears on stderr in JSON mode (and not at all in terminal mode).

**`--stop` exit codes:**

- `0` — process stopped (SIGTERM clean, or SIGKILL fallback).
- `3` (`NOT_RUNNING`) — no pid-file or the recorded pid is dead. **Silent**: nothing is written to stderr (no error envelope), so script `--stop` against the exit code, not stderr text.
- `1` (`VALIDATION`) — refusing to signal a live foreign-version pid (see live-foreign case below); the message tells the operator to terminate manually and delete the pid-file.
- `2` (`RUNTIME`) — SIGTERM + SIGKILL both timed out.

**Live-foreign case (operator upgraded gno mid-run).** If the pid-file records a live process whose `version` doesn't match the current binary, `--stop` refuses to signal it (the binary that started it is the only one trusted to manage its lifecycle). `--status --json` returns `running:false` plus a NOT_RUNNING envelope on stderr that carries:

```json
{
  "code": "NOT_RUNNING",
  "details": {
    "foreign_live": {
      "pid": 12345,
      "recorded_version": "1.0.4",
      "current_version": "1.1.0"
    }
  }
}
```

Operators should `kill <pid>` manually and remove the pid-file before relaunching.

### gno daemon

Start a headless long-running watcher process for continuous indexing.

```bash
gno daemon
gno daemon --port 8080
gno daemon --no-sync-on-start
gno daemon --detach
```

Options:

- `--no-sync-on-start` - Skip the initial sync pass and only watch future file changes
- `-p, --port <num>` - Streamable HTTP MCP port (default: 3000)
- `--host`, `--mcp-token-file`, repeatable `--mcp-allowed-host` /
  `--mcp-allowed-origin`, and `--mcp-enable-write` - see
  [Resident HTTP MCP security](MCP.md#resident-http-transport)
- `--detach` / `--status` / `--stop` / `--pid-file <path>` / `--log-file <path>` - see [shared management contract](#long-running-processes) above

**Behavior:**

- Opens the selected index DB and loads config
- Starts the same watcher + embed scheduler used by `gno serve`
- Runs an initial sync by default, then embeds backlog immediately
- Foreground: stays in the foreground until `SIGINT` / `SIGTERM`
- Detached: parent prints `PID <pid>` and exits 0; child writes to `{data}/daemon.log` (or `--log-file`) in append mode
- Hosts `/mcp` without the Web UI or browser REST routes
- Hosts `GET /api/resident/status` alongside `/mcp`; full `GET /api/status`
  remains loopback-only because it includes local index and configuration
  details

**Notes:**

- Serve and daemon are mutually exclusive resident modes for one data
  directory. A second owner fails startup with the current owner hint.
- For normie/local UI usage, prefer the desktop app or `gno serve`.

**Managing the daemon:**

```bash
# Start detached
gno daemon --detach

# Check status (terminal)
gno daemon --status

# Check status (machine-readable; exits 3 when not running)
gno daemon --status --json

# Stop gracefully (SIGTERM with 10s timeout, SIGKILL fallback)
gno daemon --stop

# Override paths
gno daemon --detach --pid-file /tmp/gd.pid --log-file /tmp/gd.log
```

### gno serve

Start a local web server for visual search and document browsing.

```bash
gno serve
gno serve --port 8080
gno serve --detach
```

Options:

- `-p, --port <num>` - Port to listen on (default: 3000)
- `--host`, `--mcp-token-file`, repeatable `--mcp-allowed-host` /
  `--mcp-allowed-origin`, and `--mcp-enable-write` - see
  [Resident HTTP MCP security](MCP.md#resident-http-transport)
- `--detach` / `--status` / `--stop` / `--pid-file <path>` / `--log-file <path>` - see [shared management contract](#long-running-processes) above

**Features:**

- **Dashboard** (`/`) - Index stats, collection overview, health status
- **First run** (`/`) - Guided folder setup, preset chooser, and health center
- **Search** (`/search`) - Full-text BM25 search with highlighted snippets
- **Browse** (`/browse`) - Collection and document list with filtering
- **Document View** (`/doc`) - Rendered document content with syntax highlighting

**API Endpoints:**

- `GET /api/health` - Health check
- `GET /api/status` - Index status, onboarding, health center, and resident lifecycle
- `GET /api/resident/status` - Safe resident-only counters and lifecycle state
- `GET /api/collections` - List collections
- `GET /api/docs` - List documents (paginated: `?limit=20&offset=0&collection=name`)
- `GET /api/doc` - Get document content (`?uri=gno://collection/path`)
- `POST /api/search` - Search (`{"query": "...", "limit": 10}`)
- `/mcp` - Stateful MCP 2025-11-25 Streamable HTTP (POST/GET/DELETE)

**Security:**

- Binds to literal `127.0.0.1` and remains loopback-only even when MCP token
  settings are present
- `gno serve` rejects non-loopback hosts because Web and REST share the
  listener; use `gno daemon` for authenticated non-loopback MCP
- Content Security Policy headers
- CSRF protection for mutations
- DNS rebinding protection

**Managing the server:**

```bash
# Start in foreground
gno serve --port 3001

# Start detached (parent prints {pid, url} and exits 0)
gno serve --detach --port 3001

# Check status (exit 3 when not running)
gno serve --status
gno serve --status --json

# Stop gracefully
gno serve --stop
```

> Want live indexing without the browser? Use `gno daemon`.

> **Windows note**: `--detach` is **not supported** on Windows and returns a `VALIDATION` error pointing to WSL. `--status` / `--stop` / `--pid-file` / `--log-file` remain parseable but have nothing to manage in the absence of a detached child.

## Shell Completion

Enable tab completion for gno commands.

### Install Automatically

```bash
gno completion install
```

Auto-detects your shell and installs to the appropriate config file.

### Manual Installation

```bash
# Bash (add to ~/.bashrc)
gno completion bash >> ~/.bashrc

# Zsh (add to ~/.zshrc)
gno completion zsh >> ~/.zshrc

# Fish
gno completion fish > ~/.config/fish/completions/gno.fish
```

Restart your shell or source the config file to activate.

### Completion Features

- Commands and subcommands
- All flags and options
- Collection names (dynamic, when DB available)

## MCP Server

Start MCP server for AI assistant integration.

```bash
gno mcp
```

See [MCP Integration](MCP.md) for setup details.

`gno mcp install` writes an absolute, workspace-pinned entry: the current Bun
executable runs the current package's `src/index.ts`, followed by the active
`--index` and canonical absolute `--config` before `mcp`. It also persists
absolute `GNO_DATA_DIR` and `GNO_CACHE_DIR` values (`env` for standard clients
and Codex, `environment` for OpenCode). This is intentional; desktop clients
need not share the shell's `PATH` or GNO environment variables. Codex writes
native `~/.codex/config.toml` or project `.codex/config.toml` tables. Use
`gno mcp install --dry-run --json` to inspect the exact command, arguments, and
workspace values. If the target already has GNO configured, add `--force` to
preview the replacement without writing it.
