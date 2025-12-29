# GNO

**Local knowledge indexing and semantic search CLI**

GNO indexes your documents locally and provides fast, privacy-preserving search with optional AI-powered answers.

## Features

- **Hybrid Search** - BM25 full-text + vector similarity with reciprocal rank fusion
- **AI Answers** - Grounded responses with citations using local LLMs
- **Multi-Format** - Index Markdown, PDF, DOCX, XLSX, PPTX, and plain text
- **Collections** - Organize documents by source directory
- **Contexts** - Add semantic hints to improve search relevance
- **Multilingual** - BCP-47 language hints and configurable FTS tokenizers
- **MCP Integration** - Use as an MCP server for AI assistant access
- **Privacy First** - All processing happens locally, no data leaves your machine

## Quick Start

```bash
# Install
bun install -g gno

# Initialize with your notes folder
gno init ~/notes --name notes

# Index documents
gno update

# Search
gno search "project deadlines"
gno query "authentication best practices"
gno ask "summarize the API discussion" --answer
```

See [Quickstart Guide](docs/QUICKSTART.md) for the full walkthrough.

## Installation

Requires [Bun](https://bun.sh/) 1.0+.

```bash
curl -fsSL https://bun.sh/install | bash
bun install -g gno
```

**macOS**: Vector search requires Homebrew SQLite:

```bash
brew install sqlite3
```

Verify with `gno doctor`.

See [Installation Guide](docs/INSTALLATION.md) for platform-specific details.

## Search Modes

| Command | Mode | Description |
|---------|------|-------------|
| `gno search` | BM25 | Keyword matching, fast |
| `gno vsearch` | Vector | Semantic similarity |
| `gno query` | Hybrid | BM25 + vector with fusion |
| `gno ask --answer` | RAG | Grounded AI answer |

## Documentation

- **[Quickstart](docs/QUICKSTART.md)** - Get searching in 5 minutes
- **[Installation](docs/INSTALLATION.md)** - Platform setup, requirements
- **[CLI Reference](docs/CLI.md)** - All commands and options
- **[Architecture](docs/ARCHITECTURE.md)** - System design overview
- **[Configuration](docs/CONFIGURATION.md)** - Collections, contexts, models
- **[MCP Integration](docs/MCP.md)** - AI assistant setup
- **[Use Cases](docs/USE-CASES.md)** - Real-world workflows
- **[Troubleshooting](docs/TROUBLESHOOTING.md)** - Common issues

## Specifications

- [CLI Specification](spec/cli.md) - Command contracts
- [MCP Specification](spec/mcp.md) - Tool and resource schemas
- [Output Schemas](spec/output-schemas/) - JSON schema definitions

## Development

```bash
# Clone and install
git clone https://github.com/gmickel/gno.git
cd gno
bun install

# Run tests
bun test

# Lint and format
bun run lint

# Type check
bun run typecheck
```

## License

MIT
