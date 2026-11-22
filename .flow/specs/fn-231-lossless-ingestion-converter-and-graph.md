# Lossless ingestion, converter, and graph sync performance

## Conversation Evidence

> user (turn 1): "This is gno, my amazing product. I want you to go through all and find potential performance gains at no loss in quality"
> user (turn 3, selected): "(Recommended) split-as-proposed (5 independent-outcome no-plan specs; Spec 2 depends on Spec 1; stat-cache excluded for fn-117)"

## Goal & Context
<!-- scope: business -->
<!-- Source: 20% user / 15% [paraphrase] / 65% [inferred] -->

Eliminate memory leaks, redundant filesystem/database work, eager heavy converter imports, and quadratic hot loops across GNO's ingestion, conversion, chunking, and graph-reconciliation pipelines while keeping extracted Markdown, chunk boundaries, metadata, links, typed edges, and security boundaries bit-for-bit identical. Local measurements show `createDefaultRegistry()` takes `68.2 ms` on the first Markdown file due to eager SheetJS (`xlsx`) and record-adapter loading, `file-processor` leaks raw file bytes per file onto its reused worker promise, and body-only single-file edits trigger full-database graph reconciliation scans. [strategy:Local knowledge lifecycle]

## Architecture & Data Models
<!-- scope: technical -->

1. **Worker memory leak fix & zero-copy transfer:**
   - Replace per-file `active.failed.then(...)` subscriptions in the file processor with a single replaceable `onFailed` callback slot cleared in `finish()`, preventing `request.input.bytes` and `previous.markdown` from accumulating in heap across files and triggering spurious worker restarts.
   - Transfer unreferenced `request.input.bytes.buffer` ownership via `postMessage(job, [buf])` when byte offsets align and callers opt in (sync and convert paths do not read `bytes` afterward).
2. **Lazy converter & record-adapter loading:**
   - Wrap `xlsxAdapter` and all 5 record adapters (`jsonl`, `transcript`, `email`, `ical`, `browser-export`) in lazy factories inside the default converter registry so MIME/extension checks never import SheetJS (`xlsx`), `turndown`, `@joplin/turndown-plugin-gfm`, or adapter modules until matched.
   - Dynamically import `turndown` and `@joplin/turndown-plugin-gfm` only when rich-text or external-hyperlink Excel cells require markup conversion.
   - Memoize per-collection configured `recordAdapters` (`transcript`, `jsonl`) once per collection sync instead of re-instantiating and re-validating them per file.
3. **Filesystem walker & macOS `local` availability:**
   - Pre-compile a walk matcher once per `walk()` (single `Bun.Glob`, partitioned bare/prefix/glob/subtree exclusions, lowercase extension `Set`), and simplify compiled-context path checks to `.toLowerCase().includes(".gno-context.")`.
   - In `walkAny`, traverse directories with bounded async `readdir(..., { withFileTypes: true })` pruning excluded subtrees (`.git`, `node_modules`), skipping `realpath()` for regular `dirent.isFile()` entries under canonical `rootReal` (keeping `safeRelPath` for symlinks), and running `file.stat()` with bounded concurrency (32). In `walkLocal`, likewise skip redundant `realpath()` on regular `dirent.isFile()` entries and batch `file.stat()`.
   - In Darwin `local` mode, reuse a module-level 144-byte `stat` buffer + `DataView`, cache `resolve(homedir())`, and preallocate `new Uint8Array(expectedSize)` in native file reads.
4. **Sync I/O, preloaded DB state, and decoupled prepare/persist batching:**
   - Read non-record `any`-mode files once (`bytes()` + `subarray(0, 4096)` / `subarray(0, 512)`) instead of opening and reading twice (`slice(0, 4096)` + `bytes()`).
   - Preload `store.listDocuments(collection.name)` once per `syncCollection` to eliminate 2N per-file `getDocument` + `listRecordDocuments` queries. In `syncPaths`, pass preloaded document/record/stat data into `processFile`, resolve `realpath(collection.path)` once, and skip post-write queries and `collectProjectionSourceIds` when `status === "unchanged"`.
   - Decouple file preparation from SQLite write transactions: run disk reads, hashing, and worker preparation outside `BEGIN IMMEDIATE`, then commit batches of up to 50 prepared writes in one transaction (skipping empty transactions for unchanged batches and fixing unbatched writes when `concurrency > 1`).
5. **Single-pass Markdown preparation, chunking, language detection & canonicalization:**
   - Parse frontmatter once (not 5-7x), compute line offsets once via `indexOf("\n")` (not 4x char-by-char), and run `parseLinks()` once (not 2x) per prepared Markdown file.
   - Replace `source.split("\n").slice(0, 10)` in `parseFrontmatter` with a 10-newline `indexOf("\n")` scan.
   - Hoist `GFM_WITH_TABLES` extension descriptors to module scope and scan `mayContainCode` without full-file `split("\n")`.
   - Replace O(N^2) `.filter()` in `findStructuralBreakPoint` with binary search, merge each language's code-breakpoint regexes into one alternation regex, and replace `.trim().length === 0` full-string copies with `!/\S/.test(str)`.
   - Optimize chunk `SimpleLanguageDetector` with `charCodeAt` + `cp >= 0x3040` fast-skip in `detectCjk` and a single bitmask `Map` pass in `detectEuropean`.
   - Guard CR normalization (`includes("\r")`) and NFC normalization (`/[^\x00-\x7f]/`) in `canonicalize`, hoist `TextDecoder` singletons in native converters, and scan `extractFirstHeading` via `indexOf("\n")`.
6. **Converter and record-container hot loops:**
   - Excel (`xlsx`): eliminate double `escapeHtml(text)` on plain cells, replace `${row}:${col}` merge map keys with numeric/row-map lookup plus row-range bailout, fast-path single-line cells, and join sheet outputs via array instead of `+=`.
   - iCalendar (`ical`): replace O(N^2) `pending = pending.slice(newline + 1)` with a cursor index.
   - Shared UTF-8 line reader (`utf8-lines`): hoist `TextDecoder`, use `chunk.indexOf(0x0a)`, and avoid `.slice()` copies on intra-chunk lines.
   - Record containers & adapters (`record-adapter-canonical`, `record-adapter`, `record-container`, `jsonl`, `transcript`, `email`, `browser-export`, `ooxml-protection`): pass precomputed adapter fingerprint into `canonicalRecord`, avoid double `canonicalJsonValue` stringification, use one shared deadline timer per container instead of per-record `setTimeout`, cache `Intl.DateTimeFormat` by timezone, precompute `sourceNamespace`/virtual-path prefix once per file, batch `store.markInactive`, use `Buffer` `"latin1"` and single-pass header/base64/HTML scans in email/HTML adapters, and use `Buffer.indexOf` for OOXML protection checks.
7. **Incremental graph reconciliation:**
   - Add a lean scalar identity query (`listGraphDocumentIdentities`) so `projectGraph` avoids `SELECT *` JSON deserialization across untouched documents.
   - Replace 2N `JSON.stringify` identity comparisons with direct 9-field scalar equality.
   - Track `addressableChanged` (`collection, relPath, docid, uri, title`) separately so body-only edits skip `incomingLinkSources`, skip building a second `relationResolver`, and skip scanning all previous inventory rows.
   - Pre-index `contentTypeRules` hints in a `Map` and remove redundant per-document `UPDATE graph_projection_state SET dirty = 1` + nested savepoints inside `writeInventory`.

## API Contracts
<!-- scope: technical -->

- No public CLI, REST, MCP, or SDK contract changes.
- `StorePort` may expose an optional lean `listGraphDocumentIdentities?()` helper with automatic fallback to `listDocuments()` for custom stores.
- Every converted Markdown output, `mirrorHash`, `sourceHash`, chunk offset/line/language, extracted link/tag/metadata, and projected graph edge remains bit-for-bit identical.

## Edge Cases & Constraints
<!-- scope: technical -->

- **Symlink containment:** Regular files (`dirent.isFile()`) inside canonical `rootReal` never follow symlinks because directory symlinks are never descended; symlinks (`dirent.isSymbolicLink()`) must still run `safeRelPath` / `lstat` containment and refusal checks identically.
- **Per-file failure isolation:** Decoupling prepare from batch persist must preserve exact per-file error recording (`recordFailure`, `INGEST_VERSION`, `preserveDocumentWithError`) and deterministic `FileSyncResult[]` ordering matching `entries`.
- **Budget enforcement:** Worker timeout and RSS memory checks must continue firing while a single slow/huge file runs, with `onFailed` still delivering `undeliverableFailure` when a worker crashes mid-file.
- **Unicode and canonicalization:** Skipping `normalize("NFC")` is valid strictly for pure ASCII (`/[^\x00-\x7f]/` false); any non-ASCII code unit must still run `normalize("NFC")`.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** File processor replaces per-file `active.failed.then(...)` chaining with a single replaceable `onFailed` slot cleared on completion, and transfers unreferenced input `ArrayBuffer`s without copying. Errors: worker crashes, timeouts, and memory budget overruns still terminate the worker and return identical failure codes/messages. [inferred]
- **R2:** Default converter registry loads `xlsx`, `turndown`, `@joplin/turndown-plugin-gfm`, and all 5 record adapters lazily only when matched by MIME/extension, and sync memoizes per-collection configured record adapters. Errors: unsupported, corrupt, and oversized files route and fail identically to eager registration. [inferred]
- **R3:** File walker pre-compiles glob/exclude/extension matchers once per walk, prunes excluded subtrees in `walkAny`, avoids redundant `realpath()` on regular non-symlink files inside canonical directories, runs `stat` with bounded concurrency, and reuses Darwin `local` stat/read buffers. Errors: invalid glob patterns, escaping symlinks, broken symlinks, unreadable roots, and dataless cloud entries produce identical skip/error outcomes. [inferred]
- **R4:** Sync reads non-record `any`-mode files once, preloads collection documents once in `syncCollection` (and reuses preloaded doc/stat data while skipping post-write queries on unchanged paths in `syncPaths`), and decouples CPU preparation from batched SQLite commit transactions. Errors: store write failures, conversion failures, and `TOO_LARGE` skips leave identical DB state and `CollectionSyncResult` summaries. [inferred]
- **R5:** Markdown preparation parses frontmatter once (with 10-line `indexOf("\n")` scan for non-frontmatter files), builds line offsets once via `indexOf("\n")`, runs `parseLinks` once, hoists `GFM_WITH_TABLES`, uses binary search + combined regexes in chunking, uses fast-path `charCodeAt`/bitmask language detection, and guards CR/NFC passes in canonicalization. Errors: malformed frontmatter, oversized Markdown tables, empty/whitespace documents, and non-ASCII inputs produce bit-identical outputs and hashes. [inferred]
- **R6:** Converter hot paths eliminate double `escapeHtml` and string merge keys in `xlsx`, O(N^2) line slicing in `ical`, per-line `TextDecoder`/`.slice()` in `utf8-lines`, redundant hashing/timers/`Intl.DateTimeFormat` in record containers/JSONL/transcripts, and char-by-char/double-parse loops in email/HTML/browser-export/OOXML helpers. Errors: malformed UTF-8, over-limit lines/records, invalid JSONL, and protected OOXML files return identical errors and diagnostics. [inferred]
- **R7:** Graph reconciliation uses scalar identity comparison and lean identity queries, skips `incomingLinkSources` and `resolveOld` full-inventory scans when no addressable target field (`collection, relPath, docid, uri, title`) changed, and avoids redundant per-doc dirty updates/savepoints. Errors: renames, title edits, deletions, config/version changes, and direct parsed-link edits still trigger exact incremental or full reconciliation identically. [inferred]

## Boundaries
<!-- scope: business -->

- Excludes stat-cache short-circuiting of unchanged files without hashing (already tracked separately on branch spec `fn-117-short-circuit-unchanged-files-in-sync`).
- No changes to chunk sizing, overlap math, language-detection heuristics, Markdown canonicalization rules, or extracted link grammar.
- No changes to SQLite PRAGMAs or schema migrations (owned by Spec 1) or CLI/serve/watcher layers (owned by Spec 4).

## Decision Context
<!-- scope: both -->

Part of a 5-spec lossless performance series from the v2.15.0 full-codebase performance audit (independent of Specs 1, 2, 4, and 5). The racy-safe stat fast-path from the audit was deliberately excluded here after duplicate detection surfaced branch-only open spec `fn-117-short-circuit-unchanged-files-in-sync`, keeping this spec strictly zero-migration and conflict-free. [paraphrase]
