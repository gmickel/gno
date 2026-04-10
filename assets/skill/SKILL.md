---
name: gno
description: Search local documents, files, notes, and knowledge bases. Index directories, search with BM25/vector/hybrid, get AI answers with citations. Use when user wants to search files, find documents, query notes, look up information in local folders, index a directory, set up document search, build a knowledge base, needs RAG/semantic search, or wants to start a local web UI for their docs.
allowed-tools: Bash(gno:*) Read
---

# GNO - Local Knowledge Engine

Fast local semantic search. Index once, search instantly. No cloud, no API keys.

## When to Use This Skill

- User asks to **search files, documents, or notes**
- User wants to **find information** in local folders
- User needs to **index a directory** for searching
- User mentions **PDFs, markdown, Word docs, code** to search
- User asks about **knowledge base** or **RAG** setup
- User wants **semantic/vector search** over their files
- User needs to **set up MCP** for document access
- User wants a **web UI** to browse/search documents
- User asks to **get AI answers** from their documents
- User wants to **tag, categorize, or filter** documents
- User asks about **backlinks, wiki links, or related notes**
- User wants to **visualize document connections** or see a **knowledge graph**
- User wants to **export a note or collection for gno.sh publishing**

## Quick Start

```bash
gno init                              # Initialize in current directory
gno collection add ~/docs --name docs # Add folder to index
gno index                             # Build index (ingest + embed)
gno search "your query"               # BM25 keyword search
```

## Command Overview

| Category     | Commands                                                         | Description                                               |
| ------------ | ---------------------------------------------------------------- | --------------------------------------------------------- |
| **Search**   | `search`, `vsearch`, `query`, `ask`                              | Find documents by keywords, meaning, or get AI answers    |
| **Links**    | `links`, `backlinks`, `similar`, `graph`                         | Navigate document relationships and visualize connections |
| **Retrieve** | `get`, `multi-get`, `ls`                                         | Fetch document content by URI or ID                       |
| **Index**    | `init`, `collection add/list/remove`, `index`, `update`, `embed` | Set up and maintain document index                        |
| **Tags**     | `tags`, `tags add`, `tags rm`                                    | Organize and filter documents                             |
| **Context**  | `context add/list/rm/check`                                      | Add hints to improve search relevance                     |
| **Models**   | `models list/use/pull/clear/path`                                | Manage local AI models                                    |
| **Serve**    | `serve`                                                          | Web UI for browsing and searching                         |
| **Publish**  | `publish export`                                                 | Export gno.sh publish artifacts                           |
| **MCP**      | `mcp`, `mcp install/uninstall/status`                            | AI assistant integration                                  |
| **Skill**    | `skill install/uninstall/show/paths`                             | Install skill for AI agents                               |
| **Admin**    | `status`, `doctor`, `cleanup`, `reset`, `vec`, `completion`      | Maintenance and diagnostics                               |

## Search Modes

| Command                | Speed   | Best For                           |
| ---------------------- | ------- | ---------------------------------- |
| `gno search`           | instant | Exact keyword matching             |
| `gno vsearch`          | ~0.5s   | Finding similar concepts           |
| `gno query --fast`     | ~0.7s   | Quick lookups                      |
| `gno query`            | ~2-3s   | Balanced (default)                 |
| `gno query --thorough` | ~5-8s   | Best recall, complex queries       |
| `gno ask --answer`     | ~3-5s   | AI-generated answer with citations |

**Retry strategy**: Use default first. If no results: rephrase query, then try `--thorough`.

## Common Flags (search/vsearch/query/ask)

```
-n <num>              Max results (default: 5)
-c, --collection      Filter to collection
--tags-any <t1,t2>    Has ANY of these tags
--tags-all <t1,t2>    Has ALL of these tags
--since <date>        Modified after date (ISO: 2026-03-01)
--until <date>        Modified before date (ISO: 2026-03-31)
--exclude <terms>     Exclude docs containing any term (comma-separated)
--intent <text>       Disambiguate ambiguous queries (e.g. "python" = language not snake)
--json                JSON output
--files               URI list output
--line-numbers        Include line numbers
```

## Advanced: Structured Query Modes (query/ask only)

Use `--query-mode` to combine multiple retrieval strategies in one query (repeatable):

```bash
# Combine keyword + hypothetical document
gno query "API rate limiting" \
  --query-mode "term:rate limit" \
  --query-mode "hyde:how to implement request throttling"

# Add intent steering
gno query "python" \
  --query-mode "term:python" \
  --query-mode "intent:programming language"
```

Modes: `term:<text>` (keyword), `intent:<text>` (disambiguation), `hyde:<text>` (hypothetical doc for semantic matching). Max one hyde per query.

## Document Retrieval

```bash
# Full document by URI
gno get gno://work/readme.md

# By document ID
gno get "#a1b2c3d4"

# Specific line range: --from <start> -l <count>
gno get gno://work/report.md --from 100 -l 20

# With line numbers
gno get gno://work/report.md --line-numbers

# JSON output with capabilities metadata
gno get gno://work/report.md --json

# Multiple documents
gno multi-get gno://work/doc1.md gno://work/doc2.md
```

**Editable vs read-only**: `gno get --json` returns a `capabilities` field showing whether a document is editable at its source. Markdown and plain text files are editable in place. Converted documents (PDF, DOCX, XLSX) are read-only -- to edit their content, create a new markdown note instead of overwriting the binary source.

## Search Then Get (common pipeline)

```bash
# Search, get full content of top result
gno query "auth" --json | jq -r '.results[0].uri' | xargs gno get

# Get all results
gno search "error handling" --json | jq -r '.results[].uri' | xargs gno multi-get
```

## Document Links & Similarity

```bash
# Outgoing links from a document
gno links gno://notes/readme.md

# Find documents linking TO a document (backlinks)
gno backlinks gno://notes/api-design.md

# Find semantically similar documents
gno similar gno://notes/auth.md

# Similar across all collections (not just same collection)
gno similar gno://notes/auth.md --cross-collection

# Stricter threshold (default: 0.7)
gno similar gno://notes/auth.md --threshold 0.85

# Knowledge graph
gno graph --json
gno graph -c notes --similar   # Include similarity edges
```

## Global Flags

```
--index <name>    Alternate index (default: "default")
--config <path>   Override config file
--verbose         Verbose logging
--json            JSON output
--yes             Non-interactive mode
--offline         Use cached models only
--no-color        Disable colors
--no-pager        Disable paging
```

## Important: Embedding After Changes

If you edit/create files that should be searchable via vector search:

```bash
gno index              # Full re-index (sync + embed)
# or
gno embed              # Embed only (if already synced)
gno embed travel       # Embed one collection only
# or
gno embed --collection travel
```

MCP `gno.sync` and `gno.capture` do NOT auto-embed. Use CLI for embedding.

## Collection-specific embedding models

Collections can override the global embedding model with `models.embed`.

CLI path:

```bash
gno collection add ~/work/gno/src \
  --name gno-code \
  --embed-model "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
```

Good default guidance:

- keep the global preset for mixed notes/docs collections
- use a collection-specific embed override for code-heavy collections when benchmark guidance says so
- after changing an embed model on an existing populated collection, run:

```bash
gno embed --collection gno-code
```

If you want to remove old vectors after switching:

```bash
gno collection clear-embeddings gno-code        # stale models only
gno collection clear-embeddings gno-code --all  # remove everything, then re-embed
```

MCP-equivalent write tool:

- `gno_clear_collection_embeddings`

## Reference Documentation

| Topic                                                 | File                                 |
| ----------------------------------------------------- | ------------------------------------ |
| Complete CLI reference (all commands, options, flags) | [cli-reference.md](cli-reference.md) |
| MCP server setup and tools                            | [mcp-reference.md](mcp-reference.md) |
| Usage examples and patterns                           | [examples.md](examples.md)           |
