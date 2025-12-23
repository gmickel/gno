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
bun run src/cli/main.ts init

# Add a collection
bun run src/cli/main.ts init ~/notes --name notes --pattern "**/*.md"

# With language hint for German docs
bun run src/cli/main.ts init ~/docs --name german --language de
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

Currently implementing core CLI commands. See `spec/cli.md` for the full interface specification.

### Completed (EPIC 2)

- Config schema with Zod validation
- Collection management (add, list, remove, rename)
- Context management (add, list, check, rm)
- Init command with multilingual support
- FTS tokenizer configuration (unicode61, porter, trigram)

### Upcoming

- EPIC 3: CLI binary and argument parsing
- EPIC 4: Database schema and migrations
- EPIC 5: File discovery and indexing

## Documentation

- [CLI Specification](spec/cli.md)
- [MCP Specification](spec/mcp.md)
- [Output Schemas](spec/output-schemas/)

## License

MIT
