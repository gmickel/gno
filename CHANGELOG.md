# Changelog

All notable changes to GNO will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.39.0] - 2026-04-06

### Added

- Added a new public multilingual markdown benchmark lane for general collections, with vendored FastAPI docs fixtures, same-language and cross-language relevance cases, and committed benchmark artifacts for `bge-m3` and `Qwen3-Embedding-0.6B-GGUF`.
- Added collection-level embedding cleanup across CLI, Web UI, and API, including stale-vs-all modes and protection for vectors still shared by active documents in other collections.

### Changed

- Switched built-in preset embedding models from `bge-m3` to `Qwen3-Embedding-0.6B-GGUF` after it materially outperformed `bge-m3` on both code and multilingual prose benchmark lanes.
- Status/backlog reporting is now model-aware for the active embedding model across CLI, Web UI, SDK, and MCP, so preset/default embed-model changes immediately surface the need to re-embed.
- Preset switching in CLI/Web/API now explicitly tells users when the embedding model changed and embeddings need to be regenerated.

## [0.38.0] - 2026-04-06

### Added

- Added a collection-level model editor in the web UI, including per-role override editing, inherited-vs-overridden effective model display, and code-collection recommendations for the embedding model.
- Added richer collection API payloads plus `PATCH /api/collections/:name` so clients can inspect and update collection-scoped model overrides without hand-editing YAML.
- Added `gno collection add --embed-model` so collection-specific embedding model overrides can be set directly from the CLI.

### Changed

- Updated CLI, API, configuration, Web UI, troubleshooting, and agent-skill docs to cover collection-scoped model overrides and the follow-up embedding workflow after changing a collection's embedding model.

## [0.37.0] - 2026-04-06

### Added

- Added a retrieval-quality upgrade pass across BM25 lexical handling, code-aware chunking, terminal result hyperlinks, and per-collection model overrides.
- Added a code-embedding benchmark workflow with canonical, real-GNO, and pinned OSS benchmark slices plus a bounded autonomous search harness for comparing alternate embedding models.
- Added benchmark/result pages and documentation that now recommend `Qwen3-Embedding-0.6B-GGUF` as the current code-specialist embedding model for per-collection code overrides.
- Added ADRs for BM25 query semantics, code-aware chunking, and collection-model resolution, plus a follow-up Flow epic for more granular path/file-type model resolution.

### Fixed

- Fixed BM25 lexical search so quoted phrases, negation, hyphenated technical terms, underscores, and filepath/title/body weighting behave intentionally and are protected by regression tests.
- Fixed CLI retrieval output to emit TTY-only OSC 8 hyperlinks without leaking escape sequences into structured or non-TTY output.
- Fixed code-chunking visibility so `gno doctor` now reports the automatic code-aware chunking mode and supported extensions.
- Fixed the embedding autoresearch harness so candidate runtime wiring, dual-fixture scoring, and leaderboard/result loading work correctly in the tracked branch/CI path.

## [0.36.0] - 2026-04-06

### Added

- Added a much stronger note command palette experience in the web workspace, including place-aware creation, section-first query results, keyboard navigation that follows visible ordering, and better help/discoverability around note-native actions.

### Changed

- Rebalanced the desktop document view rails so metadata and outline stay together on the left, while properties/path and relationship panels live on the right with tighter sticky behavior for long-note reading.

### Fixed

- Fixed command palette focus/selection styling so the input no longer inherits the global outline ring and selected items are visually obvious while using arrow keys or narrowing results.
- Fixed command palette result ordering so `cmdk` no longer fights the app's grouped ordering, preventing invisible selection jumps to non-visible items.

## [0.35.0] - 2026-04-05

### Added

- Added workspace-native note authoring flows across the web workspace, including place-aware note creation from Browse, note presets, editor preset insertion, section outline/deep links, and a stronger command palette for note/navigation actions.
- Added reference-aware file operations for editable notes, including move, duplicate, folder creation, refactor warning previews, and shared note/file operation contracts that now span the Web UI, SDK, and MCP surfaces.
- Added new programmatic surfaces for note workflows: REST endpoints for note presets, sections, folder creation, file refactor planning, move, and duplicate; new MCP write tools for folder/note refactors; and SDK parity for note creation, folder creation, sections, rename, move, and duplicate.
- Added the Scholarly Dusk design-system ADR and linked the new note-workspace epics/tasks to it so future UI work stays visually coherent.

### Fixed

- Fixed Windows/macOS path normalization issues so note/file workflows and desktop runtime-layout helpers keep POSIX-stable relpaths/URIs across platforms, unblocking green Windows CI again.

## [0.34.1] - 2026-04-04

### Fixed

- Fixed the desktop release workflows to stop uploading redundant proof-only artifacts, preventing transient GitHub artifact `ENOTFOUND` failures from sinking otherwise successful macOS packaging runs.

## [0.34.0] - 2026-04-04

### Added

- Added a cross-collection Browse 2.0 workspace with a real tree sidebar, folder detail panes, and tab-scoped browse state restoration.
- Added richer document rendering in the web workspace, including clickable frontmatter links, clickable resolved wiki links in note content, and denser document metadata/frontmatter presentation.
- Added a broad website/content refresh across the homepage, feature pages, docs metadata, FAQ, and comparison pages to better position GNO as a local knowledge workspace for humans and agents.

### Fixed

- Improved graph loading by reducing redundant server-side graph work and tuning the client-side graph defaults for faster initial render.
- Improved browser smoke coverage for Browse flows and stabilized the direct-child browse API assertion in tests.

## [0.33.4] - 2026-04-03

### Fixed

- Improved web UI regression coverage with Bun-first DOM interaction tests and a repo-local browser smoke path for search, capture, and document flows.

## [0.33.3] - 2026-04-03

### Fixed

- Fixed the macOS desktop packaging workflow artifact handling so the release-manifest JSON is uploaded from the generated release directory instead of the wrong artifact root.

## [0.33.2] - 2026-04-03

### Fixed

- Fixed the macOS desktop packaging workflow to execute the release script directly in CI and validate the artifact directory in the same step, reducing ambiguity around artifact discovery failures.

## [0.33.1] - 2026-04-02

### Fixed

- Fixed the macOS desktop release workflow so notarized desktop beta artifacts are uploaded from the correct runner paths and can be attached to GitHub releases.

## [0.33.0] - 2026-04-02

### Added

- Added a packaging matrix for CLI vs desktop support on macOS and Linux, including support tiers, artifact guidance, and runtime bundling assumptions.
- Added a repo-local macOS desktop release command for the Electrobun shell that signs, notarizes, staples, and verifies versioned desktop beta zip/DMG artifacts.
- Added a macOS desktop packaging job to the release workflow so tagged releases can build notarized desktop beta artifacts in CI once the release environment is configured.

### Changed

- Installation and desktop rollout docs now describe Linux desktop as experimental and macOS desktop as the primary beta target.

## [0.32.0] - 2026-04-02

### Added

- Added `GET /api/jobs/active` so clients can discover the currently running background job without scraping a `409` error message.

### Changed

- Job-conflict `409` API responses now include structured `error.details.activeJobId` metadata.

## [0.31.2] - 2026-04-02

### Fixed

- Browse now uses the available table space more effectively for long note titles, paths, and collection names. Document titles/paths wrap cleanly, and collection chips no longer truncate similarly named collections into unreadable slivers.

## [0.31.1] - 2026-04-01

### Fixed

- Relaxed Windows-only CI assumptions in the desktop runtime-layout tests so path separator differences no longer fail the test suite on `win32`.
- Increased the Windows timeout budget for the concurrent CLI access regression test, avoiding false negatives from slower process startup on GitHub Actions runners.

## [0.31.0] - 2026-04-01

### Added

- Added first packaged `windows-x64` desktop beta build plumbing, including packaged-runtime validation, Windows packaging workflow coverage, and release-asset support for the Windows desktop zip.
- Added explicit Windows support docs covering current target scope, packaged-runtime validation, and manual validation guidance for the desktop beta.

### Changed

- `gno index <collection>` now scopes the embedding phase to that collection instead of consuming unrelated global backlog from other collections.
- Release automation now publishes the packaged Windows desktop beta zip alongside the normal npm/GitHub release flow.

### Fixed

- CLI index summaries no longer divide embed duration by `1000` twice, so long embedding runs report realistic times instead of bogus sub-second output.

## [0.30.0] - 2026-03-27

### Added

- Added `gno daemon`, a headless continuous-indexing mode that reuses GNO's existing watcher/sync/embed pipeline without starting the Web UI server.

### Changed

- Elevated the in-app workspace presentation across the web/desktop shell path with stronger visual hierarchy, cleaner tabs/footer treatment, and a more intentional dashboard/search/ask aesthetic.
- Clarified product docs around when to use the desktop app, `gno serve`, and the new headless daemon mode.

### Fixed

- Read-only CLI commands no longer take unnecessary write locks on startup, avoiding transient `database is locked` failures when they overlap with `gno update`.
- `gno daemon --no-sync-on-start` now behaves correctly and skips the initial sync pass.

## [0.29.2] - 2026-03-27

### Changed

- Refined the `gno serve` workspace presentation with a more distinctive visual language across the dashboard, tabs, search, ask, footer, and global styling, while keeping the UI fully offline-safe.

## [0.29.1] - 2026-03-27

### Fixed

- Desktop/Web document trashing no longer depends on a separately installed global `trash` CLI. GNO now uses built-in platform-aware trash behavior instead.
- Trashing a document now reports failure if the document cannot be marked inactive in the index, avoiding false-success UI states that could leave stale search results behind.

## [0.29.0] - 2026-03-27

### Added

- First public `GNO Desktop Beta` shell naming and rollout surfaces for the mac-first desktop app path.
- Full desktop-beta onboarding flow in the Web UI and desktop shell, including folder setup, plain-language preset selection, health checks, bootstrap/runtime visibility, connector center, import preview, app tabs, file lifecycle actions, and recovery history.
- Explicit in-wizard sync progress plus clearer blocked-state handling for first indexing and embedding completion.

### Changed

- `slim-tuned` is now the built-in default preset, using the fine-tuned expansion model while keeping the same embed, rerank, and answer models as `slim`.
- Fresh onboarding now skips the model-prep step when the active preset is already ready.
- Desktop shell now exposes standard edit menu actions so paste/select-all work like a normal app.

### Fixed

- Collection add no longer throws a false “Collection not found after add” error after successful mixed-case name normalization.
- Fresh sandboxes and alternate runtime launches no longer mis-detect model readiness when `GNO_CACHE_DIR` already points at a `models` directory.
- No-op `Update All` runs now report a stable up-to-date result instead of flashing away.
- Onboarding sync/add flows now trigger embedding immediately when models are ready, preventing the final step from looking stuck after indexing starts.

## [0.28.2] - 2026-03-23

### Fixed

- Updated the validated dev-tooling dependency batch: `@biomejs/biome`, `@types/react`, `lefthook`, `oxlint-tsgolint`, `playwright`, and `ultracite`.

## [0.28.1] - 2026-03-23

### Fixed

- Updated `@modelcontextprotocol/sdk` to `1.27.1` in a narrow follow-up security/maintenance bump after the stale grouped dependency PR failed local validation.

## [0.28.0] - 2026-03-23

### Fixed

- `gno embed` now requests full embedding threads from `node-llama-cpp` and uses an adaptive embedding-context pool on CPU-only machines, with graceful fallback when extra contexts cannot be created. Thanks @riyadist for the report and repro details.

## [0.27.3] - 2026-03-23

### Fixed

- Excluded the archived `desktop/electrobun-spike` workspace from root type-aware lint/typecheck so CI and patch publishes no longer fail on unresolved spike-only Electrobun imports.

## [0.27.2] - 2026-03-23

### Fixed

- Fell back gracefully for unsupported markdown fence languages in the Web UI, including Obsidian-style ````tasks` blocks that previously crashed document rendering with a frontend ShikiError. Thanks @almino for the report.

## [0.27.1] - 2026-03-22

### Fixed

- Normalized created `gno://` document URIs to POSIX-style forward slashes on Windows so editable-copy responses and related create flows no longer return backslash-separated URIs.

## [0.27.0] - 2026-03-22

### Added

- Safe document capability metadata across the API, CLI `gno get`, SDK, and MCP so callers can distinguish editable markdown/plaintext documents from read-only converted source files.
- Read-only handling plus editable-copy creation for converted PDF/DOCX-style documents in the Web UI.
- Deep links for document view/edit routes with source-view line targeting and exact-hit navigation from search results.
- Watch-driven document event streaming for live refresh and external-change awareness in Search, Browse, Doc View, and the editor.
- Wiki-link autocomplete and linked-note creation in both the full editor and Quick Capture.
- A fast `Cmd/Ctrl+K` quick switcher with recent-document tracking and note-creation handoff.
- Local editor snapshot history with restore support after save conflicts or mistaken edits.
- Updated skill guidance for editable vs read-only document handling and richer `gno get --json` capability metadata.

### Changed

- Web/docs/website positioning now describe GNO as a safer markdown-first local workspace for agent-centric teams rather than only a retrieval layer alongside Obsidian.
- `gno_get` / `GET /api/doc` / related docs now return richer source metadata and capability metadata.

### Fixed

- Preserved deep-link line targets when navigating from document view into edit mode.
- Avoided editable-copy navigation races by waiting for the copied markdown document to become queryable before opening it.
- Removed the ugly quick-switcher focus ring/outline clash from the command input.

## [0.26.0] - 2026-03-22

### Added

- OpenCode and OpenClaw as skill install targets (`--target opencode`, `--target openclaw`).
- `--target all` now installs to all 4 targets (`claude`, `codex`, `opencode`, `openclaw`).
- MCP parameter descriptions on all 19 tools, including clearer usage guidance across roughly 60 parameters.
- MCP tool descriptions with improved usage guidance, async/job polling hints, and ref-format examples.
- Skill documentation for `--since`, `--until`, `--exclude`, `--intent`, and `--query-mode`.
- Skill sections for Document Retrieval, Links & Similarity, and search-then-get JSON pipelines.

### Fixed

- `--target all` for skill install/uninstall was previously hardcoded to `claude` + `codex` only.

## [0.25.1] - 2026-03-22

### Changed

- Expanded the bundled GNO agent skill with missing CLI retrieval flags, structured query mode guidance, `get`/`multi-get` retrieval examples, search-then-get JSON pipelines, and document links/similarity commands for better agent usability.

## [0.25.0] - 2026-03-21

### Added

- Preset-aware retrieval depth policy across Web, CLI, and MCP: `Balanced` now enables expansion on `slim` / `slim-tuned`, while `Thorough` widens the rerank candidate pool for best recall.
- Explicit model-role split for presets and runtime: `expand` now controls query expansion separately from `gen` answer generation, with updated config/docs, model management UX, and CLI output.
- Collection management discoverability and actions across the web UI, including direct `/collections` navigation, inline reindex affordances, and clickable collection surfaces that lead into filtered Browse views.

### Changed

- Ask/Search preset UI now presents the active preset as a bundle and shows separate expansion vs answer roles instead of implying the retrieval-tuned model is the answer model.
- The live `slim-tuned` preset guidance now pairs the promoted retrieval expansion model with a separate larger answer model.

## [0.24.0] - 2026-03-10

### Added

- First-class structured multi-line query documents using `term:`, `intent:`, and `hyde:` across CLI `query`/`ask`, REST `/api/query` and `/api/ask`, MCP `gno_query`, SDK `query`/`ask`, and Web Search/Ask text boxes.
- Dedicated structured syntax reference doc plus updated CLI/API/MCP/SDK/Web docs.

## [0.23.0] - 2026-03-10

### Added

- First stable SDK / library mode at the package root via `createGnoClient(...)`, with inline-config and file-backed startup, direct retrieval/document methods, and programmatic `update` / `embed` / `index` flows.

### Changed

- Package root now resolves to the SDK surface; the CLI remains available through the `gno` binary and `./cli` export.
- Added full SDK docs, README coverage, architecture notes, website nav, homepage copy, and a dedicated SDK feature page.

## [0.22.6] - 2026-03-10

### Fixed

- Stabilized cross-platform research tests by replacing one remaining generated-artifact assertion with direct filtering logic checks.

## [0.22.5] - 2026-03-10

### Changed

- Updated the main README, CLI examples, docs page, homepage bento, and fine-tuned model feature page to point at the current promoted `slim-tuned` retrieval model and Hugging Face install flow.

## [0.22.4] - 2026-03-10

### Changed

- Updated the public fine-tuned model docs and feature pages to point at the published Hugging Face model, the current promoted slim retrieval preset, and the canonical HF-backed install flow instead of local-only paths.

## [0.22.3] - 2026-03-10

### Fixed

- Relaxed the autonomous confirmation test so release CI no longer depends on a locally generated repeat-benchmark artifact being committed.

## [0.22.2] - 2026-03-10

### Fixed

- Made retrieval research tests portable in CI by removing machine-specific absolute paths and using repo-root-relative fixture resolution.

## [0.22.1] - 2026-03-10

### Fixed

- Included fine-tuning helper libraries and benchmark fixture JSON used by the retrieval research scripts/tests so release CI can resolve the research sandbox correctly on clean machines.

## [0.22.0] - 2026-03-10

### Added

- Retrieval fine-tuning sandbox now supports real local MLX LoRA training, portable GGUF export, automatic checkpoint selection, promotion bundles, and repeatable benchmark comparisons.
- Autonomous retrieval search harness now supports bounded candidate search, early-stop guards, repeated incumbent confirmation, promotion target checks, and recorded experiment history.
- Published promoted slim retrieval model `gno-expansion-slim-retrieval-v1` on Hugging Face, plus canonical release bundle, install snippet, and user-facing fine-tuned model documentation.

## [0.21.1] - 2026-03-09

### Added

- Reproducible retrieval candidate benchmark harness for local generation bases, including Qwen3.5 comparisons, raw artifacts, and recommendation memo for expansion fine-tuning.
- Manual benchmark scripts/docs for full-path model evaluation across expansion reliability, hybrid retrieval quality, latency, memory, and ask-style smoke tests.

## [0.21.0] - 2026-03-08

### Added

- CLI `gno ask --query-mode` parity with existing Ask API and Web support, including structured mode validation and JSON metadata output.

## [0.20.0] - 2026-03-08

### Changed

- Upgraded `node-llama-cpp` to `3.17.1` and switched runtime initialization to `build: "autoAttempt"` for improved backend selection and fallback behavior.

## [0.19.0] - 2026-03-08

### Added

- Explicit exclusion filters across CLI, API, Web, and MCP retrieval surfaces for hard-pruning docs by title/path/body terms.
- Ask-side structured query mode parity across API and Web, including validated `queryModes` pass-through and Ask UI chips.

### Changed

- Ask responses now surface structured query mode summary metadata for retrieval debugging and UX confirmation.

## [0.18.0] - 2026-03-08

### Added

- Explicit `intent` steering for ambiguous retrieval across CLI, API, Web, and MCP query flows.
- `candidateLimit` controls for hybrid retrieval and ask flows to tune rerank cost vs. recall.

### Changed

- Query expansion now uses a bounded configurable generation context (`models.expandContextSize`, default `2048`).
- Reranking now deduplicates identical chunk texts before scoring and fans scores back out deterministically.
- Search and Ask web advanced retrieval controls now expose intent and rerank candidate limit.

## [0.17.0] - 2026-02-23

### Added

- Structured query mode inputs across CLI/API/MCP (`term`, `intent`, `hyde`) with validation and explain metadata.
- Temporal retrieval upgrades: query recency intent detection, explicit/relative date range parsing, and recency sorting with frontmatter-date fallback.
- Frontmatter date-field extraction and date-aware browse sorting (`sortField`/`sortOrder`) in web API and UI.
- Logseq link compatibility for alias links (`[text]([[Target]])`) and block embeds (`&#123;&#123;embed ((block-id))&#125;&#125;`).

### Changed

- Ingestion now stores richer metadata/date materialization in `documents` for retrieval-time filtering and sorting.
- Web routing now remounts pages on URL changes to keep Browse/Doc views reactive without custom navigation events.
- Documentation/specs refreshed for query modes, temporal filters, API sorting, and retrieval behavior.

### Fixed

- Max-bytes enforcement now re-checks file size before read/convert to prevent stale-walker oversize ingestion.
- Link extraction no longer double-counts alias inner wiki syntax in Logseq-style links.

### Migrations

- Added migration `006-document-metadata` (`documents.metadata_json`).
- Added migration `007-document-date-fields` (`documents.document_date`, `documents.date_fields_json`) with backfill support.

## [0.16.0] - 2026-02-03

### Changed

- **Improved batch embedding performance** - `embedBatch()` now processes embeddings concurrently (up to 16 at a time) instead of sequentially, with proper error handling and dispose safety ([#64](https://github.com/gmickel/gno/pull/64))

## [0.15.1] - 2026-02-01

### Changed

- Upgrade officeparser 5.2.2 → 6.0.4 (v6 API: `parseOffice().toText()`)
- Upgrade 23 dependencies including oxlint 1.42.0, oxfmt 0.27.0, node-llama-cpp 3.15.1

### Fixed

- Await pager stdin write (caught by new oxlint rule)

## [0.15.0] - 2026-02-01

### Added

- **HTTP backends for remote model servers** - Offload embedding, reranking, and generation to remote llama-server instances via OpenAI-compatible APIs ([#62](https://github.com/gmickel/gno/pull/62)) - thanks [@Whamp](https://github.com/Whamp)!
  - Configure with URI format: `http://host:port/path#modelname`
  - Supports embedding (`/v1/embeddings`), reranking (`/v1/completions`), and generation (`/v1/chat/completions`)
  - Enables running GNO on lightweight machines while GPU inference runs on separate servers

## [0.14.3] - 2026-01-14

### Changed

- CLI embed verbose errors now include batch titles and root cause

## [0.14.2] - 2026-01-14

### Added

- Frontmatter metadata grid in doc view and edit preview

### Fixed

- Strip frontmatter from markdown preview rendering
- Prevent frontmatter URL overflow in UI
- Stop dev CSS flicker by relying on built stylesheet

## [0.14.1] - 2026-01-14

### Added

- **Verbose embedding errors** - `--verbose` flag now logs embedding failures to stderr
  - `gno index --verbose` and `gno embed --verbose` show batch failures, count mismatches, and store errors
  - Helps debug when `gno index` reports errors without details

## [0.14.0] - 2026-01-10

### Changed

- **Walker include fallback** - Empty `include` now defaults to supported document types (.md, .txt, .pdf, .docx, .pptx, .xlsx) instead of all files
  - Prevents "No converter for application/octet-stream" errors when indexing repos with source code
  - Extensionless files (Makefile, LICENSE) and dotfiles (.env, .gitignore) are always excluded
  - Explicit `include` still overrides the default

### Fixed

- Documentation now accurately describes exclude patterns as component-based matching (not globs)

## [0.13.2] - 2026-01-07

### Fixed

- Disable pager in tests and when NO_PAGER/GNO_NO_PAGER is set

### Changed

- Clarify release workflow changelog handling

## [0.13.1] - 2026-01-07

### Fixed

- Escape backslashes in markdown table cell output

## [0.13.0] - 2026-01-06

### Added

- **Knowledge Graph** - Interactive visualization of document connections
  - `gno graph` - CLI command with `--json`, `--dot`, `--mermaid` output formats
  - `--collection` filter, `--similar` for similarity edges, `--threshold` control
  - REST API: `GET /api/graph` with full query parameters
  - MCP tool: `gno_graph` for AI agents to explore relationships
  - WebUI: `/graph` page with force-directed layout, zoom/pan, collection filter
  - Similarity edges shown as golden connections (semantic relatedness)
  - Click any node to navigate to that document

- **Document Viewer** - Enhanced document reading experience
  - Outgoing links panel showing wiki and markdown links
  - Backlinks panel showing documents linking to current doc
  - Related notes sidebar with AI-powered similarity suggestions
  - Tooltips for truncated titles in all panels

### Fixed

- Wiki link resolution for path-based references
- Right panel title truncation with tooltip on hover

## [0.12.0] - 2026-01-05

### Added

- **Note Linking** - Wiki-style links, backlinks, and semantic similarity
  - `[[Target]]` wiki link syntax with cross-collection support (`[[collection:Target]]`)
  - `gno links <docid>` - List outgoing links from a document
  - `gno backlinks <docid>` - Find documents linking TO a target
  - `gno similar <docid>` - Semantic similarity search using embeddings
  - REST API: `/api/doc/:id/links`, `/api/doc/:id/backlinks`, `/api/doc/:id/similar`
  - MCP tools: `gno_links`, `gno_backlinks`, `gno_similar`
  - WebUI: OutgoingLinksPanel, BacklinksPanel, RelatedNotesSidebar
  - WikiLinkAutocomplete: `[[` trigger, fuzzy search, keyboard nav, broken link detection

- **Vector Index Maintenance** - Fix empty results from `gno similar`
  - `gno vec sync` - Fast incremental sync when vec0 drifts
  - `gno vec rebuild` - Full rebuild of vec0 index
  - Auto-sync after embed batches when drift detected
  - Transaction-wrapped sync for atomicity

### Fixed

- **vec0 index sync** - Vector inserts silently failing no longer leaves index out of sync
- **inferDimensions** - Filter by model and validate byte alignment

## [0.11.0] - 2026-01-05

### Added

- **MCP `gno_embed` tool** - Generate embeddings for unembedded chunks via MCP
  - Runs as async background job, poll with `gno_job_status`
  - Offline-only: fails fast if embedding model not cached (no auto-download)
  - Returns `{ jobId, status, model }` on start

- **MCP `gno_index` tool** - Full reindex (sync + embed) in single job
  - Syncs all collections then embeds new chunks
  - Optional `collection` param to limit scope
  - Optional `gitPull` to pull before sync
  - Returns `{ jobId, collections, phases, status }`

- **Typed job results** - Job status now includes discriminated `typedResult` union
  - `{ kind: "sync", value: SyncResult }`
  - `{ kind: "embed", value: { embedded, errors } }`
  - `{ kind: "index", value: { sync, embed } }`

- **Server-side embed scheduler** - Auto-embed after sync in web UI
  - 30s debounce to batch rapid syncs
  - Background embedding with progress in `/api/embed/status`
  - Manual trigger via `POST /api/embed`

### Fixed

- **Embed scheduler notification** - Sync/add jobs now properly trigger auto-embed
- **Job schemas** - Updated `mcp-job-status.schema.json` and `mcp-job-list.schema.json` for new job types

## [0.10.4] - 2026-01-04

### Changed

- **Skill progressive discovery** - Concise SKILL.md overview with links to reference docs (cli-reference.md, mcp-reference.md, examples.md) for reduced context bloat

## [0.10.3] - 2026-01-04

### Fixed

- **Markdown title extraction** - Files without `# heading` now fall back to filename instead of showing URL-encoded path in UI

## [0.10.1] - 2026-01-04

### Fixed

- **Tailwind v4 semantic colors** - Add `@theme` directive to generate `bg-card`, `bg-muted`, `text-foreground` etc. utilities (previously silently failing)
- **Tag autocomplete** - Substring matching (typing "fix" now finds "fixtures"), retry on fetch failure, re-filter when tags load
- **POST /api/docs URI** - Return `gno://` URI instead of `file://` for correct navigation
- **CodeMirrorEditor** - Migrate to React 19 ref-as-prop pattern

## [0.10.0] - 2026-01-04

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

| Version | Date       | Highlights                                |
| ------- | ---------- | ----------------------------------------- |
| 0.12.0  | 2026-01-05 | Note linking, backlinks, related notes    |
| 0.11.0  | 2026-01-05 | MCP embed/index tools, server embed sched |
| 0.10.0  | 2026-01-04 | Tag system with filtering                 |
| 0.9.0   | 2026-01-02 | MCP write operations                      |
| 0.8.0   | 2026-01-02 | Document editor, collections management   |
| 0.4.0   | 2026-01-01 | Web UI and REST API                       |
| 0.1.0   | 2025-12-30 | Initial release with full search pipeline |

[Unreleased]: https://github.com/gmickel/gno/compare/v0.36.0...HEAD
[0.36.0]: https://github.com/gmickel/gno/compare/v0.35.0...v0.36.0
[0.35.0]: https://github.com/gmickel/gno/compare/v0.34.1...v0.35.0
[0.34.1]: https://github.com/gmickel/gno/compare/v0.34.0...v0.34.1
[0.34.0]: https://github.com/gmickel/gno/compare/v0.33.4...v0.34.0
[0.33.4]: https://github.com/gmickel/gno/compare/v0.33.3...v0.33.4
[0.33.3]: https://github.com/gmickel/gno/compare/v0.33.2...v0.33.3
[0.33.2]: https://github.com/gmickel/gno/compare/v0.33.1...v0.33.2
[0.33.1]: https://github.com/gmickel/gno/compare/v0.33.0...v0.33.1
[0.33.0]: https://github.com/gmickel/gno/compare/v0.32.0...v0.33.0
[0.32.0]: https://github.com/gmickel/gno/compare/v0.31.2...v0.32.0
[0.31.2]: https://github.com/gmickel/gno/compare/v0.31.1...v0.31.2
[0.31.1]: https://github.com/gmickel/gno/compare/v0.31.0...v0.31.1
[0.30.0]: https://github.com/gmickel/gno/compare/v0.29.2...v0.30.0
[0.29.2]: https://github.com/gmickel/gno/compare/v0.29.1...v0.29.2
[0.29.1]: https://github.com/gmickel/gno/compare/v0.29.0...v0.29.1
[0.29.0]: https://github.com/gmickel/gno/compare/v0.28.2...v0.29.0
[0.28.2]: https://github.com/gmickel/gno/compare/v0.28.1...v0.28.2
[0.28.1]: https://github.com/gmickel/gno/compare/v0.28.0...v0.28.1
[0.28.0]: https://github.com/gmickel/gno/compare/v0.27.3...v0.28.0
[0.27.3]: https://github.com/gmickel/gno/compare/v0.27.2...v0.27.3
[0.27.2]: https://github.com/gmickel/gno/compare/v0.27.1...v0.27.2
[0.27.1]: https://github.com/gmickel/gno/compare/v0.27.0...v0.27.1
[0.27.0]: https://github.com/gmickel/gno/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/gmickel/gno/compare/v0.25.1...v0.26.0
[0.25.1]: https://github.com/gmickel/gno/compare/v0.25.0...v0.25.1
[0.13.2]: https://github.com/gmickel/gno/compare/v0.13.1...v0.13.2
[0.13.1]: https://github.com/gmickel/gno/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/gmickel/gno/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/gmickel/gno/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/gmickel/gno/compare/v0.10.4...v0.11.0
[0.10.4]: https://github.com/gmickel/gno/compare/v0.10.3...v0.10.4
[0.10.3]: https://github.com/gmickel/gno/compare/v0.10.1...v0.10.3
[0.10.1]: https://github.com/gmickel/gno/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/gmickel/gno/compare/v0.9.6...v0.10.0
[0.9.6]: https://github.com/gmickel/gno/compare/v0.9.5...v0.9.6
[0.9.5]: https://github.com/gmickel/gno/compare/v0.9.4...v0.9.5
[0.9.4]: https://github.com/gmickel/gno/compare/v0.9.3...v0.9.4
[0.9.3]: https://github.com/gmickel/gno/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/gmickel/gno/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/gmickel/gno/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/gmickel/gno/compare/v0.8.6...v0.9.0
[0.8.6]: https://github.com/gmickel/gno/compare/v0.8.5...v0.8.6
[0.8.5]: https://github.com/gmickel/gno/compare/v0.8.4...v0.8.5
[0.8.4]: https://github.com/gmickel/gno/compare/v0.8.3...v0.8.4
[0.8.3]: https://github.com/gmickel/gno/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/gmickel/gno/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/gmickel/gno/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/gmickel/gno/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/gmickel/gno/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/gmickel/gno/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/gmickel/gno/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/gmickel/gno/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/gmickel/gno/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/gmickel/gno/compare/v0.3.5...v0.4.0
[0.3.5]: https://github.com/gmickel/gno/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/gmickel/gno/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/gmickel/gno/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/gmickel/gno/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/gmickel/gno/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/gmickel/gno/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/gmickel/gno/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/gmickel/gno/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/gmickel/gno/releases/tag/v0.1.0
