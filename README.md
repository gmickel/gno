# GNO - Gno Knows

Local knowledge indexing and semantic search CLI with MCP (Model Context Protocol) integration.

## Features

- **Hybrid Search**: BM25 full-text + vector similarity search
- **Multi-Format**: Index Markdown, PDF, DOCX, and more
- **Collections**: Organize documents by source directory
- **Contexts**: Add semantic hints to improve search relevance
- **Multilingual**: BCP-47 language hints and configurable FTS tokenizers
- **MCP Integration**: Use as an MCP server for AI assistant access

## Installation

```bash
bun install
```

## Quick Start

```bash
# Initialize GNO
bun run src/index.ts init

# Add a collection
bun run src/index.ts init ~/notes --name notes --pattern "**/*.md"

# Index and search
bun run src/index.ts index
bun run src/index.ts query "your question"
bun run src/index.ts ask "your question" --answer
```

## Development

```bash
# Run tests
bun test

# Lint and format
bun run lint

# Type check
bun run typecheck
```

## Project Status

Core CLI and indexing infrastructure complete. See `spec/cli.md` for the full interface specification.

### Completed

- **EPIC 2**: Config schema, collection/context management, init command
- **EPIC 3**: CLI binary with Commander.js, doctor command
- **EPIC 4**: SQLite schema, migrations, store adapters
- **EPIC 5**: File discovery, content extraction (md/txt/pdf/docx), FTS indexing
- **EPIC 6**: LLM subsystem with node-llama-cpp (embedding, rerank, generation)
- **EPIC 7**: Vector embeddings with sqlite-vec, `gno embed` command
- **EPIC 8**: Search pipelines (BM25, vector, hybrid query with reranking)
- **EPIC 8.3/8.4**: `gno ask` with grounded answers and citation validation
- **EPIC 9**: Output formatters (json, md, csv, xml, files) and `gno get`
- **EPIC 10**: MCP server integration

## Documentation

- [CLI Specification](spec/cli.md)
- [MCP Specification](spec/mcp.md)
- [Output Schemas](spec/output-schemas/)

## License

MIT
