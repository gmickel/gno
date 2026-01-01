# GNO CLI Reference

Complete command reference for GNO.

## Global Flags

All commands accept:

| Flag | Description |
|------|-------------|
| `--index <name>` | Use alternate index (default: "default") |
| `--config <path>` | Override config file path |
| `--no-color` | Disable colored output |
| `--verbose` | Enable verbose logging |
| `--yes` | Non-interactive mode |
| `--json` | JSON output (where supported) |

## Initialization

### gno init

```bash
gno init [<path>] [options]
```

| Option | Description |
|--------|-------------|
| `--name <name>` | Collection name |
| `--pattern <glob>` | File pattern (default: `**/*`) |
| `--include <exts>` | Extension allowlist (e.g., `.md,.pdf`) |
| `--exclude <paths>` | Exclude patterns (default: `.git,node_modules`) |
| `--tokenizer <type>` | FTS tokenizer: unicode61, porter, trigram |
| `--language <code>` | BCP-47 language hint |

## Collections

### gno collection add

```bash
gno collection add <path> --name <name> [options]
```

Options same as `init`.

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

| Option | Description |
|--------|-------------|
| `--collection <name>` | Scope to single collection |
| `--no-embed` | Skip embedding |
| `--models-pull` | Download models if missing |
| `--git-pull` | Git pull before indexing |

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

| Option | Default | Description |
|--------|---------|-------------|
| `-n` | 5 | Max results |
| `--min-score` | 0 | Minimum score (0-1) |
| `-c, --collection` | all | Filter to collection |
| `--full` | false | Full content (not snippets) |
| `--line-numbers` | false | Include line numbers |
| `--lang` | auto | Language filter |

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

| Flag | Time | Description |
|------|------|-------------|
| `--fast` | ~0.7s | Skip expansion and reranking |
| (default) | ~2-3s | Skip expansion, with reranking |
| `--thorough` | ~5-8s | Full pipeline with expansion |

Additional options:

| Option | Description |
|--------|-------------|
| `--no-expand` | Disable query expansion |
| `--no-rerank` | Disable reranking |
| `--explain` | Print retrieval details to stderr |

### gno ask

AI-powered Q&A with citations.

```bash
gno ask <question> [options]
```

| Option | Description |
|--------|-------------|
| `--fast` | Skip expansion and reranking (fastest) |
| `--thorough` | Enable query expansion (better recall) |
| `--answer` | Generate grounded answer |
| `--no-answer` | Retrieval only |
| `--max-answer-tokens <n>` | Cap answer length |
| `--show-sources` | Show all sources |

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

| Option | Default | Description |
|--------|---------|-------------|
| `-t, --target` | claude-desktop | Target: `claude-desktop`, `claude-code`, `codex` |
| `-s, --scope` | user | Scope: `user`, `project` |
| `-f, --force` | false | Overwrite existing config |
| `--dry-run` | false | Preview changes |

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

## Exit Codes

| Code | Description |
|------|-------------|
| 0 | Success |
| 1 | Validation error (bad args) |
| 2 | Runtime error (IO, DB, model) |
