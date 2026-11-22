# Lossless CLI, serve, watcher, Web UI, and MCP performance

## Conversation Evidence

> user (turn 1): "This is gno, my amazing product. I want you to go through all and find potential performance gains at no loss in quality"
> user (turn 3, selected): "(Recommended) split-as-proposed (5 independent-outcome no-plan specs; Spec 2 depends on Spec 1; stat-cache excluded for fn-117)"

## Goal & Context
<!-- scope: business -->
<!-- Source: 20% user / 15% [paraphrase] / 65% [inferred] -->

Eliminate avoidable cold-start module loading, idle resident wakeups, redundant HTTP proxying, full-table REST scans, watcher snapshot copying, browser bundle bloat, and MCP request serialization across GNO's user-facing surfaces without changing any CLI flag, REST payload, UI feature, or MCP protocol contract. Local measurements show `gno --version` takes `51.3 ms` (vs `1.2 ms` bare Bun) from eager static imports (`findings-run-state` `22.9 ms`, `@modelcontextprotocol/client` `32.7 ms`, 11 `mdast`/`micromark` packages `16.7 ms`, `franc` `14.1 ms`, `program.ts` `30+ ms`), `gno serve` wakes up every 2 seconds while idle and proxies in-memory production SPA assets through a second `Bun.serve()`, and the Web UI ships a `13.03 MB` raw SPA snapshot with CodeMirror 6 pulled into read-only document views. [strategy:Coherent agent and application surfaces]

## Architecture & Data Models
<!-- scope: technical -->

1. **CLI cold-start & command efficiency:**
   - Check `IMPORT_CHILD_ENV` and `FILE_PROCESSOR_CHILD_ENV` in the CLI entrypoint before dynamically importing CLI runner or model lifecycle modules (only calling `resetModelManager` if loaded/initialized).
   - Handle `--version`/`-V` (with no subcommand), `--skill`, and no-subcommand concise help before dynamically importing `commander` and the 5,872-line program definition.
   - Extract tiny zero-dependency leaf modules (re-exported for backwards compatibility) for: `getGlobals`/`resetGlobals` (breaking the `mcp/install` -> `program.ts` edge into `serve` and `status`), `BUDGET_ERROR_CODES`, `rangeIntersectsExcluded`, `parseMcpToolProfile`, and connector verification metadata (removing `@modelcontextprotocol/client` from `status` and `serve` startup). Lazy-import `findings-run-state` and `franc` (loading `franc` only for queries `>= 15` chars when `--lang` is unset).
   - Cache loaded `(config, sessionBinding)` per CLI invocation (cleared in `resetGlobals()` and bypassed/invalidated on writes) to eliminate 2x-3x `loadConfig()` YAML/Zod parses per command.
   - Parallelize independent async stages of `gno status` and `runtime-health` target/resident probes via `Promise.all`, and replace `collectBudgetStops`'s N+1 `getDocument` loop with one SQL join.
2. **Resident runtime & production SPA serving:**
   - Initialize `loadedConfigStamp` at startup after initial config load; memoize `staleIndexedCollections` by `(PRAGMA data_version, configRef)`; replace the 2-second idle `setInterval` polling loop with `fs.watch(dirname(configPath))` plus a 60-second safety fallback if `fs.watch` fails.
   - In production (`!isDev`), serve decompressed in-memory `ProductionSpaAssets` directly in-process instead of spawning a second `Bun.serve()` + Unix domain socket proxy; check cached `gzipBodies` before calling `spaBundleSource.fetch`; drop `.slice(0)` in `serveSpaHtml` and answer `304 Not Modified` on matching `If-None-Match`.
3. **REST API routes:**
   - Replace `store.listDocuments()` (full DB load) in `GET /api/doc/:id/similar` with the targeted `json_each(?)` SQL lookup already used by MCP `gno_similar`.
   - Push `GET /api/docs/autocomplete` filtering and `LIMIT` into a targeted SQL query selecting only the minimal autocomplete columns.
   - Rewrite `buildBrowseTree` as a single-pass `Map`-backed O(N x D) build (replacing double-pass O(N x D x W) `.find()`), make `findBrowseNode` O(D) path descent, and parallelize `listCollectionFolders` with bounded concurrency (16) overlapped with SQLite document reads.
   - Deduplicate `buildAppStatus` model cache inspections into one `manifest.json` read and one parallel validation per unique model URI (instead of 3 `ModelCache` instances, 10+ manifest reads, and 8 GGUF header reads), and parallelize suggested-folder `stat` probes.
   - Gzip REST JSON responses `> 2 KiB` when `Accept-Encoding` includes `gzip` (setting `Vary: Accept-Encoding`), cache `getCollectionDateFields` by `(data_version, contentGeneration, collection)`, parallelize independent reads in `GET /api/doc`, and replace repeated dynamic `await import("node:path")` calls with static imports.
4. **File watcher & SSE event bus:**
   - Shallow-copy only the outer `directories` `Map` in `cloneDirectoryMaps` (inner maps are immutable `ReadonlyMap`s) and return `state.directories` directly in `freezeSnapshot` (reducing per-flush allocations from O(total_files) to O(total_dirs)).
   - Construct `#eventHost`, `#queueHost`, and `#lifecycleHost` once in `CollectionWatchService`'s constructor and cache per-collection `WalkConfig` updated only in `updateCollections()`.
   - Run `widenVanishedExactPaths`, `storeOnlyRemovals`, and `provenRemovals` `lstat`/`inspectNoFollowPresence` loops with bounded concurrency (32), preserving deterministic output order.
   - Early-return in `DocumentEventBus.emit()` when `#subscribers.size === 0` and reuse the already-formatted sync timestamp.
5. **Web UI frontend:**
   - Import `MarkdownPreview` directly in `DocView` (removing ~600 KB+ CodeMirror 6 pulled through the `editor` barrel) and lazy-load `PublishExportDialog` and `RefactorImpactPreview`.
   - Extract the 4 pure wiki-link string helpers from `core/links` into a zero-dependency leaf module so browser bundles drop 11 `mdast`/`micromark` packages; hoist `remarkPlugins`/`rehypePlugins` arrays and keep `h1`-`h6`/`img` component identities stable in `MarkdownPreview` to stop DOM unmount/remount thrash during live editing.
   - Dynamically import Shiki (loading only `one-light` and `one-dark-pro` themes) and switch `CodeBlock` to dual-theme CSS variables (`themes: { light, dark }`) so every code block tokenizes once and renders one DOM tree instead of two.
   - Mount `QuickSwitcher`, `ShortcutHelpModal`, `CaptureModal`, and `ClipperPairing` lazily on first open/route; memoize `WorkspaceProvider` context value.
   - Debounce `document-changed` SSE refreshes in `Browse` (250 ms trailing debounce) with `AbortController` / request sequence guards, avoid stale-offset double fetches on folder switch, switch `CaptureModal` and `GraphView` from `/api/status` to `/api/collections`, replace recursive spread flattening and linear `favoriteCollections.includes` in `BrowseTreeSidebar` (with list virtualization past 100 visible rows), and replace client-side `zod` pre-validation in `metadata-filter` with a lightweight pure validator.
6. **MCP server:**
   - Memoize `rejectUnknownKeys` via `WeakMap<z.ZodObject, z.ZodObject>` and precompute static tool definition tables per `(toolProfile, enableWrite)` so sessionless 2026-07-28 HTTP MCP requests do not deep-clone 45 Zod schemas on every request.
   - Upgrade `toolMutex` to an async Reader-Writer lock so read-only tools (`READ_CONNECTION_TOOLS` and other read-only tools) run concurrently on the WAL read connection while write tools and `shutdown()` retain exclusive access.
   - Cache warm `VectorIndexPort` and LLM ports on `ToolContext` (invalidated on config change / `disposeModels`), remove redundant `request.clone()` in HTTP MCP transport, cache `deriveRequestIdentity` in a bounded `Map`, and reuse the `data_version`-cached `staleIndexedCollections` check.

## API Contracts
<!-- scope: technical -->

- Zero changes to CLI flags, exit codes, stdout/stderr formats, REST JSON schemas, Web UI visual rendering/shortcuts, or MCP tool schemas/annotations.
- HTTP responses using `Content-Encoding: gzip` honor `Accept-Encoding` negotiation and include `Vary: Accept-Encoding`.
- `spa-production.json.gz` is rebuilt via `bun run build:spa` after frontend bundle optimizations.

## Edge Cases & Constraints
<!-- scope: technical -->

- **Security headers & CSP:** Serving production SPA assets in-process must preserve every existing response header (CSP, security envelope, `Cache-Control`, `Vary`, `ETag`, `Content-Encoding`) identically; dev mode (`--dev`) retains its private `HTMLBundle` source.
- **Resident config hot-reload:** `fs.watch` on the config parent directory must handle both in-place edits and atomic temp-file renames, and every incoming request still validates `(configStamp, data_version)` so stale config is never served.
- **MCP concurrency & shutdown safety:** Reader-writer locking must drain all in-flight read tools before `shutdown()` closes SQLite or before any write tool mutates config/collections/documents, and keep stdio transport behavior unchanged.
- **Soak invariants:** Resident idle wakeups, status p99 latency, and shutdown budgets in `scripts/soak/config.ts` must improve or stay well within existing limits.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** CLI startup dispatches child workers (`IMPORT_CHILD_ENV`, `FILE_PROCESSOR_CHILD_ENV`) and fast-path flags (`--version`, `--skill`, bare `gno`) before importing `commander`/`program` or model lifecycle modules; leaf-module extractions eliminate eager imports of `findings-run-state`, `program.ts` (from `serve`/`status`), `@modelcontextprotocol/client` (from `status`/`serve`), 11 `mdast`/`micromark` packages (from read CLI/SDK), and `franc` (for `< 15`-char queries or `--lang`); per-invocation config caching eliminates duplicate `loadConfig()` calls; `gno status` runs independent stages in parallel with a single-query `collectBudgetStops`. Errors: invalid flags, invalid index names, missing config, and session-binding failures exit with identical codes and messages. [inferred]
- **R2:** `ResidentRuntime` initializes `loadedConfigStamp` at startup, memoizes `staleIndexedCollections` by `(data_version, configRef)`, replaces 2s idle polling with `fs.watch` + 60s fallback, and serves production SPA assets in-process with direct gzip cache hits and `304 Not Modified` HTML ETag handling. Errors: config reload failures, watcher errors, missing SPA assets, and non-gzip clients degrade gracefully with identical status codes and security headers. [inferred]
- **R3:** `GET /api/doc/:id/similar` queries only hit documents via `json_each(?)`; `GET /api/docs/autocomplete` filters and limits in SQL; `buildBrowseTree` runs in single-pass O(N x D) with O(D) `findBrowseNode` and concurrent `listCollectionFolders`; `buildAppStatus` reads `manifest.json` and validates each unique model URI once; REST JSON responses `> 2 KiB` support gzip compression; `getCollectionDateFields` is cached by `data_version`; `GET /api/doc` parallelizes independent reads. Errors: 400/404/409/500 responses, non-ASCII autocomplete, and invalid paths match existing REST contracts identically. [inferred]
- **R4:** Watcher snapshot diffing shallow-copies only the outer `directories` map, `CollectionWatchService` allocates host wrappers once and caches `WalkConfig` per collection, watcher `lstat` loops run with bounded concurrency preserving deterministic order, and `DocumentEventBus.emit()` short-circuits with zero subscribers. Errors: snapshot overflow, vanished directories, permissions errors, and disposal mid-flush preserve existing reconciliation invariants. [inferred]
- **R5:** Web UI removes CodeMirror 6 and 11 `mdast`/`micromark` packages from read-only `DocView`, stabilizes `MarkdownPreview` heading/image components, switches `CodeBlock` to lazy-loaded dual-theme single-pass Shiki, lazy-mounts modals and `ClipperPairing`, debounces `Browse` SSE refreshes with `AbortController`, switches `CaptureModal`/`GraphView` to `/api/collections`, optimizes `BrowseTreeSidebar`, and removes `zod` from client `metadata-filter`. Errors: light/dark code highlighting, live editing, keyboard shortcuts (`Cmd+K`, `?`, `n`), and `bun run test:web` / `bun run test:e2e` pass with identical visual and functional behavior. [inferred]
- **R6:** MCP server caches `.strict()` schemas in `rejectUnknownKeys` and precomputes static tool tables, upgrades `toolMutex` to a reader-writer lock for concurrent read-only HTTP MCP tools, caches warm `VectorIndexPort` and LLM ports on `ToolContext` until config change/disposal, drops `request.clone()`, and caches `deriveRequestIdentity`. Errors: unknown tool arguments, write contention, read-during-write blocking, and graceful shutdown drain pass all MCP contract tests identically. [inferred]

## Boundaries
<!-- scope: business -->

- No visual redesign, new UI features, new CLI flags, or MCP protocol version changes.
- No changes to SQLite PRAGMAs/indexes (Spec 1), retrieval pipeline algorithms (Spec 2), ingestion/converters (Spec 3), or native LLM worker internals (Spec 5).

## Decision Context
<!-- scope: both -->

Part of a 5-spec lossless performance series from the v2.15.0 full-codebase performance audit (independent of Specs 1, 2, 3, and 5). Grouping all runtime-surface wins (CLI cold start, resident/serve, watcher, Web UI bundle/rendering, MCP server) keeps cross-surface dependency cuts aligned (for instance, extracting `rangeIntersectsExcluded` and wiki-link syntax simultaneously speeds up CLI startup, SDK startup, and shrinks the Web UI production bundle). [paraphrase]
