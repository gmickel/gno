---
satisfies: [R1, R2, R3]
---
# fn-198-large-pivot-table-workbook-makes-282.1 Implement Large pivot-table workbook makes 2.8.2 indexing run away in memory

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
The large pivot-table workbook now indexes in seconds, and every file is processed under a per-file budget that stops it mid-step. Two causes, both measured:

1. The markitdown-ts xlsx chain (SheetJS `sheet_to_html` -> jsdom -> turndown + Joplin GFM) is O(columns x rows^2) in the GFM plugin's column-alignment scan and costs about 20 KB per cell. This was pre-existing; the real file (one 23 x 40,439 sheet) blew past memory on 2.8.1 too.
2. 2.8.2's code-span detection ran the GFM table parser, which is quadratic in cells, over converted documents.

What changed:
- **R1 conversion.** New `adapter/xlsx` renders each sheet's Markdown table directly from SheetJS cell data. It reproduces `sheet_to_html` cell text, turndown whitespace and escaping, the GFM cell, empty-header, colspan and single-cell rules, and markitdown's normalization. Markup cells (rich text, links) still go through turndown, cached. Output is byte-identical to markitdown-ts on the fixtures, an edge-case workbook and generated pivot-report workbooks, and tests pin this.
  - Documented change: an unreadable .xlsx is now CORRUPT instead of a retryable ADAPTER_FAILURE.
- **R1 code regions.** Converted documents and records never reach the Markdown parser. A Markdown note with a table over 5,000 cells parses without GFM tables; the only difference is that a code span crossing a table-cell pipe stays whole. The fallback scanner is gone.
- **R2.** Conversion, metadata, tags, memory scopes, code regions, journal structure (previous and next), chunking and link parsing run as one step in a reused, unref'd, terminable file worker, for every file.
  - The main thread stops it mid-step at `conversion.timeoutMs` / `conversion.maxMemoryMb`. The file is recorded as TIMEOUT / MEMORY_LIMIT naming the running step, stays pending, the worker is replaced, and the next file continues.
  - Database reads and writes stay on the main thread.
  - Compiled executables and injected test doubles prepare in-process with checks between steps (documented).
- **R2, compiled builds (round 4).** One file-processor abstraction has two backends: the Bun Worker, and, where a TypeScript worker cannot start (bun build --compile), a child process of the same executable (the internal env flag, as the session-import child uses). It is reused, and killed and replaced mid-step at the deadline or memory limit. The child's RSS counts toward the memory budget (/proc on Linux, ps elsewhere, time only on Windows). A processor that cannot start fails closed with ISOLATION_UNAVAILABLE. The file's clock starts when the processor is ready.
  - Compiled `gno update` was broken for every file before this change (pdf.js `DOMMatrix`, node-llama-cpp resolution). Now PDF/Word/PowerPoint fail on their own with ADAPTER_FAILURE in such builds, while Markdown, text and Excel index.
  - A real compiled smoke stops an 80k-row Markdown table at about 1000 ms (15,322 ms on 0dd0eb01) and indexes the note.
- **R2, child shutdown (round 5).** A child busy in a synchronous step cannot run its disconnect handler.
  - The parent now SIGKILLs every child processor on exit (which the CLI's SIGINT path reaches through process.exit), on SIGTERM (re-raised when unowned, so the exit status is unchanged), on SIGINT when nothing else owns it, on disposeFileProcessor(), and in the resident runtime's dispose.
  - On Linux the child arms PR_SET_PDEATHSIG through Bun's built-in bun:ffi (libc prctl), so it also dies with a SIGKILLed or crashed parent. Elsewhere it exits between steps once its parent is gone; the documented gap is a parent SIGKILLed on macOS or Windows.
  - Tests (red on 5f7c5fa6): compiled CLI parent sent SIGTERM, SIGINT and SIGKILL mid-step leaves the child gone within 1 s; dispose kills a busy child within 1 s.
- **R3.** The slow-file notice fires while a step runs. Budget stops are listed in update output, `gno status` and the audit.

Live QA (evidence in `.flow/tmp/qa-fn-198-large-pivot-table-workbook-makes-282/round3/`):
- Real-shape workbook (23 x 40,439, ~770k shared-string refs, pivot records 16.4/14.7 MB): fixed 5.9 s / 1674 MB. v2.8.1 and origin/main were killed at the 6 GB cap (12.6 s / 15.1 s, 0 docs).
- Earlier default workbook: fixed 2.1 s / 1024 MB; v2.8.1 8.8 s / 3120 MB; origin/main killed at 300 s.
- 40k- and 80k-row Markdown tables under a 1 s budget: TIMEOUT at 1000 ms during code-region detection, 1.8 s total, and the notice fired.
- 1,000 small notes: 2257 ms vs 2148 ms before round 3 (+5.1%, 5 interleaved runs); round 4 left the worker path unchanged (2257 vs 2310 ms on 0dd0eb01).
- Heimdall, real workbook at 0dd0eb01 (coordinator): 3 s, 1.1 GB peak, 1 doc / 4,931 chunks (v2.8.2 killed at 6 GB, v2.8.1 at 34 GB).

Tier: session model (in-host worker)

stage: impl-review - ran (conductor-owned codex reviews: NEEDS_WORK rounds 1-4; findings addressed in c53774e2, 2a65ba89, f64cfbfa, 07480f5b, 99088a8b)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: f68f7ab82f1ee47f5c01985e39b1ec1cef831a58, 787bad2e317ca7179097060201c7a2632eb5c12c, ae2c795d47b7324325caff5f9a61179c2683f726, c53774e2087c29429dd2baee8216572d29abd3ac, 42eb83e200eef8a0d7606d00f633dc2f97964f6c, 1a3eeeb1282ea151dd08366ec6993c7e2cc2123b, 2a65ba89aa6b2372473753804a12898bab14eba6, f64cfbfa9d6c9148f97af2991711963b0939e5e1, 0dd0eb014355225e7c58c2c984184c2fbe895937, 07480f5b940674825715e620fca41f11e803d2bd, 5f7c5fa6d88da367e137889a8cb3d620b538054d, 99088a8b2c07d4e7549a03a38af865c4ba7f9493
- Tests: mise exec bun@1.4.2 -- bun run lint:check (0 errors, 45 pre-existing warnings), mise exec bun@1.4.2 -- bun run docs:verify, mise exec bun@1.4.2 -- bun test: 5990 pass, 0 fail, compiled CLI SIGTERM/SIGINT/SIGKILL mid-step: child gone < 1 s (fails on 5f7c5fa6: child alive, reparented, 130% CPU at 3 s), disposeFileProcessor kills a busy child < 1 s and fails its file (red on 5f7c5fa6), compiled smoke: 80k-row table stopped at 1000 ms, note added, 2.3 s, 1000 small notes: 2124 ms vs 2138 ms on 5f7c5fa6, gno.sh gno-sh-fn198 ca6dd0f: check, typecheck, test (431), build
- PRs: