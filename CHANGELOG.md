# Changelog

All notable changes to GNO will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2025-12-31

### Added
- **MCP Install CLI** - One-command setup for AI assistant integration
  - `gno mcp install` - Configure gno as MCP server in Claude Desktop, Claude Code, or Codex
  - `gno mcp uninstall` - Remove gno from MCP configuration
  - `gno mcp status` - Check installation status across all targets
- Cross-platform support (macOS, Windows, Linux)
- Atomic config writes with automatic backup
- User and project scope support for Claude Code and Codex

## [0.2.0] - 2025-12-30

### Added
- MCP server with stdio transport for AI assistant integration
- Tools: `gno_search`, `gno_vsearch`, `gno_query`, `gno_get`, `gno_multi_get`, `gno_status`
- Resources: `gno://{collection}/{path}` document access
- Plan for `gno mcp install` auto-configuration command
- Website: punchy tagline, 8 features in bento grid, theme-aware terminal glow

## [0.1.0] - 2025-12-30

### Added

#### Core Features
- **Hybrid Search Pipeline** - BM25 + vector retrieval with RRF fusion
- **HyDE Query Expansion** - Hypothetical Document Embeddings for better semantic matching
- **Cross-encoder Reranking** - Two-stage retrieval with reranking for precision
- **Multi-language Support** - Automatic language detection with BCP-47 codes

#### CLI Commands
- `gno init` - Initialize a knowledge base with a collection
- `gno collection add/list/remove/rename` - Manage document collections
- `gno update` - Sync files from disk (no embedding)
- `gno index` - Full index with optional embedding
- `gno embed` - Generate vector embeddings
- `gno search` - BM25 keyword search
- `gno vsearch` - Vector semantic search
- `gno query` - Hybrid search with expansion and reranking
- `gno ask` - AI-powered Q&A with citations
- `gno get` - Retrieve single document by reference
- `gno multi-get` - Batch document retrieval
- `gno ls` - List indexed documents
- `gno context add/list/rm` - Manage retrieval context hints
- `gno models list/use/pull/clear/path` - Model management
- `gno status` - Index status and health
- `gno doctor` - Diagnostics and troubleshooting
- `gno cleanup` - Remove orphaned data
- `gno skill install/uninstall/show/paths` - Claude Code skill management

#### Document Processing
- **Native Converters** - Markdown, plain text, JSON, YAML, TOML, CSV
- **External Converters** - PDF (pdftotext), Office docs (pandoc), images (tesseract OCR)
- **Smart Chunking** - Semantic-aware document splitting
- **File Walker** - Configurable patterns, gitignore support, extension filters

#### Storage & Indexing
- **SQLite Backend** - Single-file database with FTS5 full-text search
- **sqlite-vec** - Cross-platform vector storage and similarity search
- **Migrations** - Schema versioning with automatic upgrades
- **Mirror Cache** - Converted document caching for fast re-indexing

#### AI/ML Integration
- **Local Embeddings** - GGUF models via node-llama-cpp (no API keys)
- **Model Presets** - slim (~1GB), balanced (~2GB), quality (~2.5GB)
- **Reranker Models** - Cross-encoder scoring for result quality
- **LLM Abstraction** - Pluggable providers (Anthropic, OpenAI, Ollama)

#### Developer Experience
- **Output Formats** - JSON, CSV, Markdown, XML, files protocol
- **Verbose Mode** - Detailed logging with `--verbose`
- **Exit Codes** - 0 (success), 1 (validation), 2 (runtime)
- **Contract Tests** - Schema validation for all outputs

#### Documentation
- **Jekyll Website** - Comprehensive docs at gno.dev
- **VHS Terminal Demos** - Animated CLI demonstrations
- **Search Pipeline Guide** - Deep dive into HyDE, RRF, reranking
- **API Specifications** - CLI spec, MCP spec, output schemas

### Infrastructure
- **Bun Runtime** - Fast startup, native TypeScript
- **Biome Linting** - Zero-config via Ultracite preset
- **GitHub Actions CI** - Lint, typecheck, test matrix
- **Beads Issue Tracking** - Git-native dependency-aware tracking

---

## Version History

| Version | Date | Highlights |
|---------|------|------------|
| 0.2.0 | 2025-12-30 | MCP server for AI assistant integration |
| 0.1.0 | 2025-12-30 | Initial release with full search pipeline |

[Unreleased]: https://github.com/gmickel/gno/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/gmickel/gno/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/gmickel/gno/releases/tag/v0.1.0
