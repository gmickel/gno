---
satisfies: [R1, R2, R3, R4, R5, R6, R7]
---
# fn-231-lossless-ingestion-converter-and-graph.1 Implement lossless ingestion, converter, and graph sync optimizations

## Description
TBD

## Acceptance
- [ ] TBD

## Done summary
Implemented all seven lossless ingestion, converter, and graph reconciliation performance improvements (R1–R7) with bit-for-bit output parity:

- **R1 (file-processor):** Replaced per-file `active.failed.then(...)` subscriptions with a single replaceable `onFailed` callback slot cleared in `finish()`, cached the startup handshake (`readyProcessors`/`startupRaces`) so reused workers accumulate zero failure reactions per file, and added zero-copy `ArrayBuffer` transfer (`transferInputBytes: true`) for unshared full-buffer input bytes in `sync.ts` and `convert-file.ts`.
- **R2 (lazy converters & record adapters):** Wrapped `xlsxAdapter` and all 5 record adapters (`ical`, `email`, `browser-export`, `jsonl`, `transcript`) in lazy registry factories with exact metadata and `configurationFingerprint` preservation, deferred `turndown` and `@joplin/turndown-plugin-gfm` to rich-text/external-hyperlink Excel cells, and memoized dynamically imported configured record adapters once per collection sync. Cold `createDefaultRegistry()` + Markdown conversion dropped from `68.2 ms` to `2.63 ms`.
- **R3 (walker & Darwin local availability):** Pre-compiled walk matchers once per walk, replaced `Bun.Glob.scan` in `walkAny` with bounded async `readdir` + strict subtree pruning + per-branch/per-segment dotfile matching (delegating slash-spanning brace unions to `Bun.Glob.scan` for exact parity), switched regular-file stat batches to bounded `lstat()` (`32` concurrency) in both `walkAny` and `walkLocal`, and reused Darwin stat/homedir/read buffers.
- **R4 (sync I/O, preloading & decoupled batching):** Eliminated double reads on non-record `any`-mode files, preloaded collection documents once per `syncCollection` (reusing for missing-path inactivation), decoupled file preparation from batched `TX_BATCH_SIZE` (50) SQLite commits (skipping empty transactions and batching `concurrency > 1` with per-file savepoint rollback isolation), and preserved pre-write backlink checks before persisting changes while skipping backlink/post-write queries on unchanged `syncPaths` entries.
- **R5 (Markdown prep, chunking, language & canonicalize):** Single frontmatter parse (`parseFrontmatterDetails` with 10-line `indexOf("\n")` Logseq window), single `buildLineOffsets` shared across `parseLinks`, `extractSections`, and `MarkdownChunker`, single `parseLinks` pass, hoisted `GFM_WITH_TABLES` + zero-split `mayContainCode`, binary search in `findStructuralBreakPoint` (preserving independent per-pattern scans for exact multiline breakpoint parity), `charCodeAt`/bitmask `SimpleLanguageDetector`, ASCII/CR-guarded `canonicalize`, and hoisted `TextDecoder` + `indexOf("\n")` heading scan in native converters.
- **R6 (converter & record-container hot loops):** Eliminated double `escapeHtml` and string merge keys in `xlsx`, cursor-indexed `ical` line reading, hoisted `TextDecoder` + zero-copy intra-chunk lines in `utf8-lines`, `Buffer.indexOf` in `ooxml-protection`, single-pass `indexOf` scans in `html-text`, precomputed adapter identity/fingerprint + single `canonicalJsonValue` walk in `record-adapter-canonical`, single shared deadline timer + wall-clock check in `record-adapter`, cached `Intl.DateTimeFormat` + precomputed virtual-path prefix + batched `markInactive` in `record-container`, precomputed `sourceNamespace` in `jsonl`/`transcript`, and `Buffer("latin1")`/single-pass scans in `email` and `browser-export`.
- **R7 (incremental graph reconciliation):** Added lean `listGraphDocumentIdentities` SQL query and `docidReferenceSources` lookup, replaced 2N `JSON.stringify` comparisons with 9-field scalar equality, skipped `incomingLinkSources` and `resolveOld` on body-only edits while still re-resolving explicit `#docid` relations, pre-indexed first-occurrence `contentTypeRules` hints, and eliminated redundant per-doc dirty updates and nested savepoints in `writeInventory`.

Codex `impl-review` (`codex:gpt-6.2-sol:medium`) converged to `SHIP` in Round 3 after resolving all Round 1 (12 findings) and Round 2 (4 findings) feedback with dedicated regression coverage.

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 29dbb505bd4c6ed0489b9d7e0812819e332ef060, 1f844a28d9f7a052c6f8ff90789108744fd4e533, 522f2c6d2458bc0cd902b34bbf22d0da872392e6
- Tests: bun run typecheck, oxlint --type-aware --type-check <changed files>, bun test test/ingestion/ test/converters/ test/store/, bun test test/ingestion/ingestion-converter-graph-performance.test.ts, bun run eval:memory, bun run eval:sessions
- PRs: