# Changelog

All notable changes to GNO will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Tag System** - Organize and filter documents by tags
  - Frontmatter tag extraction during sync (`tags:` field in markdown)
  - Hierarchical tags with `/` separator (e.g., `project/web`, `status/draft`)
  - `gno tags` CLI commands: `list`, `add`, `rm` for tag management
  - `--tags-any`/`--tags-all` flags on search/vsearch/query/ask for OR/AND filtering
  - REST API: `GET /api/tags` endpoint, tag filtering params on search endpoints
  - MCP tools: `gno.list_tags` for tag discovery, `gno.tag` for add/remove
  - WebUI: TagInput with autocomplete, TagFacets sidebar for filtering, filter chips display

## [0.9.6] - 2026-01-03

### Fixed

- **SKILL.md frontmatter** - `allowed-tools` now space-delimited per Agent Skills spec

## [0.9.5] - 2026-01-03

### Added

- **`--skill` flag for agent discovery** - `gno --skill` outputs SKILL.md for AI agents to discover capabilities
  - Follows Agent Skills specification format
  - Clean output suitable for piping/parsing

### Fixed

- **SKILL.md refresh** - Updated with ~15 missing CLI commands (serve, models, context, mcp, skill subcommands, doctor, etc.)

## [0.9.4] - 2026-01-03

### Changed

- **Default model preset switched to "slim"** - Better eval scores (69% vs ~50%), faster inference, smaller download (~1GB)
  - Balanced preset still available via `gno models use balanced`
- **Updated model names** - slim: Qwen3-1.7B, balanced: Qwen2.5-3B-Instruct, quality: Qwen3-4B-Instruct

### Internal

- Evalite v1 evaluation harness (local-only quality gates for releases)
- Fixed `--full` flag ranking order bug in search results

## [0.9.3] - 2026-01-03

### Added

- **Shell tab completion** - bash/zsh/fish support with commands, flags, and dynamic collection names
  - `gno completion output <shell>` - Generate completion script
  - `gno completion install` - Auto-install to shell config
- **Automatic pager** - Long output piped through `$PAGER` (less -R / more)
  - `--no-pager` flag to disable
  - Respects TTY detection and structured output modes

## [0.9.2] - 2026-01-03

### Added

- **ThoroughnessSelector on Ask page** - Fast/Balanced/Thorough modes with keyboard shortcut (T)
- **Skills documentation** - New docs/integrations/skills.md with Claude Code, Codex, OpenCode, Amp, VS Code Copilot, and Cursor support
- **noExpand/noRerank API params** - Added to `/api/ask` endpoint for search depth control

### Changed

- **Documentation restructure** - Agent integration (Skills, MCP) now prioritized before Web UI in README and website
- **Screenshot updates** - All webui screenshots updated to .jpg format with new Brandbird styling

### Fixed

- **react-markdown node prop leak** - Prevented `node` prop from leaking to DOM elements
- **Table row striping** - Increased visibility of alternating row colors in markdown tables
- **Em dash removal** - Replaced AI-style em dashes with standard punctuation across all docs

## [0.9.1] - 2026-01-02

### Added

- **Document Editor Sync Scrolling** - Bidirectional scroll sync between CodeMirror editor and markdown preview
  - Toggle button (Link/Unlink icons) in toolbar, enabled by default
  - Percentage-based position mapping with event-based loop prevention
  - Epsilon checks prevent unnecessary updates and jitter

### Fixed

- **Raycast MCP docs** - Fixed deeplinks with correct `mcpServers` wrapper format, added clipboard auto-fill JSON

## [0.9.0] - 2026-01-02

### Added

- **MCP Write Operations** - AI assistants can now manage collections via MCP
  - `gno_capture` - Create new markdown documents in collections
  - `gno_add_collection` - Add folders to the index (async with job tracking)
  - `gno_sync` - Reindex one or all collections
  - `gno_remove_collection` - Remove collection from config
  - `gno_job_status` - Check async job progress
  - `gno_list_jobs` - List active and recent jobs
- **Write Tool Gating** - Disabled by default, enable with `--enable-write` or `GNO_MCP_ENABLE_WRITE=1`
- **Security Protections**
  - Dangerous root rejection (`/`, `~`, `/etc`, `~/.ssh`) with realpath canonicalization
  - Path traversal prevention (rejects `../` escapes)
  - Sensitive subpath blocking (`.ssh`, `.gnupg`, `.git`)
  - Cross-process locking via OS-backed flock/lockf
  - Atomic writes (temp + rename pattern)
- **Core Modules** - Shared utilities for MCP and WebUI
  - `src/core/validation.ts` - Path and collection validation
  - `src/core/file-ops.ts` - Atomic file operations
  - `src/core/file-lock.ts` - Advisory file locking
  - `src/core/config-mutation.ts` - Config change flow
  - `src/core/job-manager.ts` - Async job tracking
- **MCP Documentation** - Updated docs/MCP.md with all new tools, security model, Raycast write-enabled deeplinks
- **Smoke Test Script** - `scripts/mcp-write-smoke-test.ts` for MCP validation

## [0.8.6] - 2026-01-02

### Added

- **Single-key shortcuts** (GitHub/Gmail pattern): `N` new note, `/` search, `T` cycle depth, `?` help
- **HelpButton** with scholarly marginalia design (Old Gold accents)
- **ShortcutHelpModal** redesigned with two-column "Card Catalog" layout
- **ThoroughnessSelector** for search depth control (Fast/Balanced/Thorough)
- **AIModelSelector** with "vacuum tube display" aesthetic for Ask page
- Simplified Search page - Thoroughness now controls BM25 vs hybrid modes

### Fixed

- Keyboard shortcuts no longer fire when Ctrl/Cmd/Alt held (fixes macOS browser conflicts)
- Shortcuts don't fire inside dialogs or text inputs

## [0.8.5] - 2026-01-02

### Fixed

- Pre-build Tailwind CSS for npm distribution - runtime plugin fails for global installs

## [0.8.4] - 2026-01-02

### Fixed

- `bunfig.toml` missing from npm package - broke Tailwind CSS processing in `gno serve`

## [0.8.3] - 2026-01-02

### Fixed

- Web UI shortcuts use Ctrl on all platforms (avoids Cmd+N/K browser conflicts on Mac)
- Missing `minimatch` dependency broke `gno multi-get` on npm install
- Removed unused `rehype-highlight` dependency

## [0.8.2] - 2026-01-02

### Fixed

- `gno serve` broken when installed from npm - moved tailwindcss to dependencies

## [0.8.1] - 2026-01-02

### Added

- AI Answers screenshot in docs (webui-ask-answer.png)

### Fixed

- CI publish workflow: removed obsolete `typecheck` script, use `lint:check`
- Screenshot references updated to PNG format

## [0.8.0] - 2026-01-02

### Added

- **Document Editor** - Split-view markdown editor with live preview
  - CodeMirror 6 with syntax highlighting and word wrap
  - Auto-save with 2s debounce
  - Keyboard shortcuts: ⌘B bold, ⌘I italic, ⌘K link, ⌘S save
  - Unsaved changes warning on navigation
- **Document CRUD** - Full create, read, update, delete via Web UI
  - `PUT /api/docs/:id` - Update document content
  - `DELETE /api/docs/:id` - Delete document and file
  - DocView edit/delete buttons with confirmation dialogs
- **Collections Management** - Add and remove collections from Web UI
  - AddCollectionDialog with folder path input
  - IndexingProgress component with real-time status
  - Re-index action per collection
- **Keyboard Shortcuts** - Global and editor shortcuts
  - ⌘N new note, ⌘K focus search, ⌘/ show help
  - ShortcutHelpModal with tactile keyboard key styling
  - Platform-aware modifier display (⌘ vs Ctrl)
- **Quick Capture** - Floating action button for instant note creation
  - CaptureModal with title, content, collection fields
  - Remembers last used collection
  - Shows indexing progress after creation

### Changed

- **Design Polish** - Enhanced visual refinements
  - Hero Documents card with gradient and glow
  - Card hover lift effects with shadows
  - Enhanced glass effect with saturation
  - Search input with gradient focus border
  - Improved empty states with actionable suggestions
  - CaptureButton with pulse glow animation
- Fixed transparent backgrounds in dialogs, dropdowns, selects
- Changed collection remove icon from Trash to FolderMinus

## [0.7.0] - 2026-01-01

### Added

- **REST API write operations** - Full CRUD for collections and documents
  - `POST /api/collections` - Add new collection
  - `DELETE /api/collections/:name` - Remove collection
  - `POST /api/sync` - Trigger re-index
  - `POST /api/docs` - Create document
  - `POST /api/docs/:id/deactivate` - Unindex document
  - `GET /api/jobs/:id` - Poll job status
- **CSRF protection** - Origin validation for mutating endpoints
- **API token auth** - `X-GNO-Token` header for non-browser clients

### Changed

- Extracted collection CRUD to `src/collection/` for API/CLI parity
- Config sync with mutex serialization (YAML → DB → memory)

## [0.6.1] - 2026-01-01

### Added

- **Auto-download models** - Models download automatically on first use (CLI, MCP, Web UI)
- **Offline mode** - `--offline` flag and `HF_HUB_OFFLINE`/`GNO_OFFLINE` env vars
- **Cross-process locking** - Safe concurrent model downloads with stale lock recovery

## [0.6.0] - 2026-01-01

### Added

- **Tiered search modes** - `--fast` (BM25 only, ~0.7s), default (with reranking, ~2-3s), `--thorough` (full pipeline with expansion, ~5-8s)
- **Chunk-level reranking** - Reranks best chunk per document (4K) instead of full documents, ~25× faster with same quality

### Changed

- Default search now skips LLM query expansion (faster) but keeps reranking (quality)
- Refactored rerank pipeline with extracted helper functions for maintainability

### Fixed

- Properly await `store.close()` in scripts
- Handle `cleanupAndExit` promises to prevent floating promise warnings

## [0.5.1] - 2026-01-01

### Fixed

- Include fts5-snowball binaries in npm package

## [0.5.0] - 2026-01-01

### Added

- **Document-level BM25** - Full documents indexed (not chunks), finds terms across sections
- **Snowball stemmer** - FTS5 with multilingual stemming (20+ languages); "running" matches "run"
- **Contextual chunking** - Chunks embedded with document title prefix for context awareness
- **Strong signal detection** - Skip expensive LLM expansion when BM25 has confident match
- **Tiered top-rank bonus** - +0.05 for #1, +0.02 for #2-3 in RRF fusion
- **Full-document reranking** - Qwen3-Reranker scores complete documents (32K context)
- **Full-document answers** - Answer generation receives complete document content

### Changed

- Original query now gets **2× weight** in RRF fusion (prevents dilution by variants)
- Switched to Qwen3-Reranker-0.6B (Apache 2.0 license, 32K context)

## [0.4.0] - 2026-01-01

### Added

- **Web UI** - Local web dashboard via `gno serve`
  - Dashboard with index stats and collection overview
  - Search page with BM25/hybrid search modes
  - Ask page with AI-powered answers and citations
  - Document viewer with syntax highlighting
  - Browse collections and documents
  - Model preset selector with hot-reload
  - Model download with progress polling
- **REST API** - Full HTTP API for programmatic access
  - `/api/search` - BM25 keyword search
  - `/api/query` - Hybrid search (BM25 + vector)
  - `/api/ask` - AI answers with citations
  - `/api/docs`, `/api/doc` - Document listing and retrieval
  - `/api/presets` - Model preset management
  - `/api/models/pull` - Model download with progress
- **Convenience scripts** - `bun run serve` and `bun run serve:dev`

### Changed

- Extracted answer generation to shared `src/pipeline/answer.ts` module
- API and CLI now share identical pipeline code

## [0.3.5] - 2025-12-31

### Changed

- README: Comprehensive rewrite with full MCP install commands, feature tables, doc links
- README: Added footer attribution

### Fixed

- License badge spacing

## [0.3.4] - 2025-12-31

### Fixed

- CI: Use Node.js 24 for npm OIDC trusted publishing support

## [0.3.3] - 2025-12-31

### Fixed

- CI: Use npm for tarball install test (bun has issues with local tarballs)

## [0.3.2] - 2025-12-31

### Fixed

- CI: Add TTY workarounds to publish workflow

## [0.3.1] - 2025-12-31

### Fixed

- CI: Serial test execution on Windows fixes exit code issue
- CI: TTY workaround for macOS/Ubuntu test output
- CI: Use native Bun ecosystem for Dependabot

### Changed

- Use npm trusted publishing (OIDC) instead of tokens

## [0.3.0] - 2025-12-31

### Added

- 10 MCP installation targets (Claude Desktop, Claude Code, Cursor, Zed, Windsurf, etc.)
- LibreChat YAML config support
- Incremental sync (only new/modified files re-indexed)

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

- **Jekyll Website** - Comprehensive docs at gno.sh
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

| Version | Date       | Highlights                                 |
| ------- | ---------- | ------------------------------------------ |
| 0.3.5   | 2025-12-31 | README rewrite with comprehensive MCP docs |
| 0.3.0   | 2025-12-31 | 10 MCP installation targets                |
| 0.2.0   | 2025-12-30 | MCP server for AI assistant integration    |
| 0.1.0   | 2025-12-30 | Initial release with full search pipeline  |

[Unreleased]: https://github.com/gmickel/gno/compare/v0.3.5...HEAD
[0.3.5]: https://github.com/gmickel/gno/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/gmickel/gno/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/gmickel/gno/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/gmickel/gno/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/gmickel/gno/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/gmickel/gno/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/gmickel/gno/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/gmickel/gno/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/gmickel/gno/releases/tag/v0.1.0
