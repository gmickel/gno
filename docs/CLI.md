# CLI Reference

GNO command-line interface guide.

> **Full specification**: See [spec/cli.md](../spec/cli.md) for exhaustive command documentation.

## Quick Reference

| Command | Description |
|---------|-------------|
| `gno init` | Initialize config and database |
| `gno update` | Index all collections |
| `gno search` | BM25 full-text search |
| `gno vsearch` | Vector similarity search |
| `gno query` | Hybrid search (BM25 + vector) |
| `gno ask` | Search with AI answer |
| `gno get` | Retrieve document content |
| `gno ls` | List indexed documents |
| `gno models` | Manage models (list, pull, use) |
| `gno skill` | Install GNO skill for AI agents |
| `gno doctor` | Check system health |

## Global Flags

All commands accept:

```
--index <name>    Use alternate index (default: "default")
--config <path>   Override config file path
--no-color        Disable colored output
--verbose         Enable verbose logging
--yes             Non-interactive mode
```

**Output format flags** (`--json`, `--files`, `--csv`, `--md`, `--xml`) are per-command.
See [spec/cli.md](../spec/cli.md#output-format-support-matrix) for which commands support which formats.

## Search Commands

### gno search

Full-text search using BM25.

```bash
gno search "project deadlines"
gno search "error handling" -n 5
gno search "auth" --json
gno search "meeting" --files
```

Options:
- `-n, --limit <n>` - Limit results (default: 5; 20 with --json/--files)
- `--min-score <n>` - Minimum score threshold (0-1)
- `--full` - Show full document content
- `--line-numbers` - Show line numbers in snippets
- `--lang <code>` - Filter by detected language in code blocks

### gno vsearch

Semantic similarity search using vector embeddings.

```bash
gno vsearch "how to handle errors gracefully"
gno vsearch "authentication best practices" --json
```

Same options as `gno search`. Requires embed model.

### gno query

Hybrid search combining BM25 and vector results. This is the recommended search command for most use cases.

```bash
gno query "database optimization"
gno query "API design patterns" --explain
gno query "auth" --no-expand --no-rerank
```

Additional options:
- `--no-expand` - Disable query expansion (faster, less recall)
- `--no-rerank` - Disable cross-encoder reranking (faster)
- `--explain` - Show detailed scoring breakdown (to stderr)

The `--explain` flag outputs:
- BM25 scores per result
- Vector similarity scores
- RRF fusion scores
- Rerank scores (if enabled)
- Final blended scores

See [How Search Works](HOW-SEARCH-WORKS.md) for details on the scoring pipeline.

### gno ask

Search and optionally generate an AI answer. Combines retrieval with optional LLM-generated response.

```bash
gno ask "what is the project goal"
gno ask "summarize the auth discussion" --answer
gno ask "explain the auth flow" --answer --show-sources
```

Options:
- `--answer` - Generate grounded AI answer (requires gen model)
- `--no-answer` - Force retrieval-only output
- `--max-answer-tokens <n>` - Limit answer length
- `--show-sources` - Show all retrieved sources, not just cited ones
- `-n, --limit <n>` - Max source results
- `-c, --collection <name>` - Filter by collection
- `--lang <code>` - Language hint (BCP-47)

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
gno get abc123 --from 50 -n 100  # Lines 50-150
```

Options:
- `--from <line>` - Start output at line number (1-indexed)
- `-n, --limit <n>` - Limit lines returned
- `--source` - Include source file metadata in output

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
```

Options:
- `--name <name>` - Collection identifier (required)
- `--pattern <glob>` - File matching pattern
- `--include <csv>` - Extension allowlist
- `--exclude <csv>` - Exclude patterns
- `--language <code>` - BCP-47 language hint

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

## Indexing Commands

### gno update

Re-index all collections (incremental). Only processes files changed since last index.

```bash
gno update
gno update --yes            # Non-interactive
gno update --git-pull       # Pull git repos first
gno update --models-pull    # Auto-download missing models
```

Options:
- `--git-pull` - Run `git pull` in collections that are git repositories
- `--models-pull` - Download models if not cached
- `--no-embed` - Skip embedding generation (BM25 only)

### gno index

Index a specific collection.

```bash
gno index notes
```

### gno embed

Generate embeddings for indexed chunks.

```bash
gno embed
gno embed notes
```

## Context Commands

Contexts add semantic hints to improve search relevance.

### gno context add

```bash
gno context add "/" "Global search context"
gno context add "notes:" "Personal notes and journal entries"
gno context add "gno://notes/projects" "Active project documentation"
```

### gno context list

```bash
gno context list
```

### gno context check

Validate context configuration.

```bash
gno context check
```

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
gno models use slim       # Fast, ~1GB disk
gno models use balanced   # Default, ~2GB disk
gno models use quality    # Best answers, ~2.5GB disk
```

### gno models pull

Download models.

```bash
gno models pull --all
gno models pull --embed
gno models pull --rerank
gno models pull --gen
gno models pull --force   # Re-download even if cached
```

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

## Skill Commands

Install GNO as a skill for AI coding assistants (Claude Code, Codex).

### gno skill install

Install the GNO skill files.

```bash
gno skill install                    # Project scope, Claude target
gno skill install --scope user       # User-wide installation
gno skill install --target codex     # For Codex instead of Claude
gno skill install --target all       # Both Claude and Codex
gno skill install --force            # Overwrite existing
```

Options:
- `--scope <project|user>` - Installation scope (default: project)
- `--target <claude|codex|all>` - Target agent (default: claude)
- `--force` - Overwrite existing installation

### gno skill uninstall

Remove installed skill.

```bash
gno skill uninstall
gno skill uninstall --scope user
gno skill uninstall --target all --scope all
```

Options:
- `--scope <project|user|all>` - Scope to uninstall from
- `--target <claude|codex|all>` - Target to uninstall from
- `--file <name>` - Remove specific file only

### gno skill show

Preview skill files without installing.

```bash
gno skill show
gno skill show --file SKILL.md
```

### gno skill paths

Show installation paths for all scope/target combinations.

```bash
gno skill paths
gno skill paths --json
```

See [Using GNO with AI Agents](USE-CASES.md#ai-agent-integration) for setup guide.

## Admin Commands

### gno status

Show index status.

```bash
gno status
gno status --json
```

### gno doctor

Check system health.

```bash
gno doctor
gno doctor --json
```

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

## Output Formats

| Format | Flag | Use Case |
|--------|------|----------|
| Terminal | (default) | Human reading |
| JSON | `--json` | Scripting, parsing |
| Files | `--files` | Pipe to other tools |
| CSV | `--csv` | Spreadsheet import |
| Markdown | `--md` | Documentation |
| XML | `--xml` | XML tooling |

Example:

```bash
# Get file URIs for piping
gno search "important" --files | xargs gno get

# Parse JSON in scripts
gno search "test" --json | jq '.results[].uri'
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Validation error (bad input) |
| 2 | Runtime error (IO, DB, model) |

## MCP Server

Start MCP server for AI assistant integration.

```bash
gno mcp
```

See [MCP Integration](MCP.md) for setup details.
