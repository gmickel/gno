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

Hybrid search combining BM25 and vector results.

```bash
gno query "database optimization"
gno query "API design patterns" --rerank
```

Additional options:
- `--rerank` - Use cross-encoder reranking
- `--expansion` - Enable query expansion

### gno ask

Search and optionally generate an AI answer.

```bash
gno ask "what is the project goal"
gno ask "summarize the auth discussion" --answer
```

Options:
- `--answer` - Generate grounded AI answer
- `--min-relevance <n>` - Relevance threshold for sources

## Document Commands

### gno get

Retrieve document content by ID.

```bash
gno get abc123def456
gno get abc123def456 --json
```

### gno multi-get

Retrieve multiple documents.

```bash
gno multi-get abc123 def456 ghi789
```

### gno ls

List indexed documents.

```bash
gno ls
gno ls --json
gno ls --files
```

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

Re-index all collections (incremental).

```bash
gno update
gno update --yes  # Non-interactive
```

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

### gno models pull

Download models.

```bash
gno models pull --all
gno models pull --embed
gno models pull --rerank
gno models pull --gen
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
