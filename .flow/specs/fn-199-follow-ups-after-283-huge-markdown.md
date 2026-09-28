# Follow-ups after 2.8.3: huge Markdown tables, doctor on empty collections, a Windows update hang, trace-graph similarity

## Goal & Context

Four loose ends from shipping 2.8.3. Each one is small and independent of the others.

- 2.8.3 stopped large spreadsheets from running away and put every file under a per-file budget. A Markdown note that holds one very large table can still take long enough to be stopped at that budget, even though the GFM table extension is left out above `MAX_PARSED_TABLE_CELLS` (`src/ingestion/strip.ts`).
- `gno doctor` reports an empty collection as a retrieval-activation failure (✗) on every run.
- One Windows CI run hung in `test/cli/concurrency.test.ts` ("ls can open while update is running in another process"). The test normally takes about 4 s; this run passed its 20 s timeout and bun killed a dangling process. A rerun passed in 4.0 s. Nothing is known yet about which process hung.
- gno.sh's trace-graph export still gathers similarity edges one document at a time, working around a graph bug that 2.8.1 fixed.

## Acceptance Criteria

- **R1:** A Markdown note consisting mostly of one large pipe table indexes in time and memory roughly linear in its size.
  - **Measure first.** Find which step is superlinear once GFM tables are off: the Markdown parse, code-span detection, chunking, link extraction, or another step. Record it in the spec.
  - **Target.** Doubling the table's rows at least up to 200,000 cells takes no more than about 2.5 times as long.
  - **Real shape.** A note shaped like the 2.8.3 pivot report (23 columns by about 40,000 rows) completes well inside the default 60 s budget.
  - **Unchanged output.** Chunks, links and code-span results for ordinary notes stay the same.
  - **Tests.** A regression test pins the scaling bound at a size CI can afford.
- **R2:** `gno doctor` no longer reports a collection with no documents as a failure.
  - An empty collection, meaning the only activation problem is `no_documents`, is shown as informational with its remediation (`gno update`, or add files). It does not make the retrieval-activation check an error.
  - A collection that has documents but fails the lexical proof is still an error.
  - Check whether other surfaces that present activation health mark empty collections the same way: `gno status`, REST `/api/status`, MCP `gno_status`. Make them consistent with doctor.
  - Keep the JSON output schemas in step (`spec/output-schemas`).
- **R3:** Diagnose the Windows hang in the concurrency test and fix it if a cause is found.
  - **Capture on timeout.** The test records the stdout and stderr of both child processes (`update` and `ls`) and says which one had not exited. A future timeout then names the process that hung.
  - **Review.** Check the per-file worker's shutdown in `update` on Windows (`src/ingestion/file-processor.ts`: worker `unref()`/`terminate()`, the child backend's kill paths) and the lock and busy-timeout interplay between a writing `update` and a reading `ls`.
  - **Fix or record.** Fix any real hang in product code with a regression test. If no cause can be found, record what was ruled out in the spec rather than raising the timeout.
- **R4:** gno.sh's `scripts/export-index-trace-graph.ts` gets similarity edges from `gno graph --include-similar` (with `--threshold` and `--similar-top-k` matching the current `SIMILAR_THRESHOLD` and `SIMILAR_TOP_K`) instead of calling `gno similar` once per node.
  - Remove the stale comment claiming graph similarity is unavailable.
  - The exported figure data keeps the same shape.
  - Compare edge counts before and after on the same index and explain any difference, for example graph similarity being scoped differently from `--cross-collection`.
  - This is a gno.sh repository change, shipped in the release's gno.sh PR.

## Boundaries

- No change to the per-file budget defaults, the xlsx converter, or `MAX_PARSED_TABLE_CELLS` semantics beyond what R1's measurement requires.
- R2 changes how an empty collection is presented, not the activation proof itself.
- R3 must not lengthen test timeouts as its fix.

## Downstream

- User-facing changes (R1 behaviour, R2 doctor output) go in the CHANGELOG and, where they affect docs, gno.sh docs (troubleshooting and doctor pages). R4 ships in the same gno.sh PR.

## Findings

### R1: which step was superlinear

A plain numeric table was already linear once GFM tables were off: 23 x 16,000 rows took 0.8 s in total. The superlinear cost depended on what the rows contained. It was measured per `prepareFile` phase on 23-column notes.

- **Code-region detection (micromark), an unmatched `]` in every row.** Without table rules the table is one paragraph. On every `]`, micromark's `labelEnd` walks back through all of the paragraph's earlier events looking for an opening `[`, and `gfmPotentialFootnoteCall` does the same. 2,000 / 4,000 / 8,000 rows took 1.0 / 7.1 / 66 s. This is only reached when the note contains a backtick or an indented-code line, because otherwise the parser is skipped.
- **Code-region detection, an unclosed `<!--` in every row.** micromark's `htmlText` reads forward from each `<!--` to the paragraph's end: 4,350 / 8,700 rows took 19.7 / 94 s. The `/<!--[\s\S]*?-->/g` regex in `getExcludedRanges` was quadratic the same way even without the parser: 1.3 / 5.1 / 20.7 s.
- **Link extraction and change-journal structure, an unclosed `[[` in every row.** `WIKI_LINK_REGEX` rescanned from every `[[` to the next `]`. It runs twice, in structure extraction and in link extraction: 4,350 / 8,700 / 17,400 rows took 4.1 / 15.4 / 61 s.
- **Link extraction, a code span and a wiki link in every row.** `rangeIntersectsExcluded` scanned the excluded ranges from the start for every link: 18 / 55 / 236 ms. This is mild, but quadratic.
- Chunking, conversion and metadata were linear.

**Fix.** The table-less parse also leaves out `labelEnd`, `gfmPotentialFootnoteCall` and `htmlText`. As a result, a backtick inside a link destination or an inline HTML tag can open a code span in a note over the table budget. The HTML-comment scan, the wiki-link match and `rangeIntersectsExcluded` became single-pass rewrites, each checked against its old definition by a randomized equivalence test.

**Result.** The worst cases took 23 x 2,175 / 4,350 / 8,700 rows = 50k / 100k / 200k cells: 0.16 / 0.30 / 0.64 s, which is 1.9x and 2.2x per doubling. The remaining mild curve beyond 200k cells is inside micromark's own paragraph parse, and a plain table shows it too.

A 23 x 40,000 pivot-shaped note, with a stray `]` in every row and a code span, went through `gno update`. On the base commit it hit `TIMEOUT` during code-region detection after 60.6 s. On this branch it indexed in 3.3 s. The regression tests `test/ingestion/strip.test.ts` "stay linear with ..." compare 1,500 and 3,000 rows and fail on the base commit.

### R3: Windows hang in `test/cli/concurrency.test.ts`

- **Which process hung.** `update` was still alive at the 20 s timeout. Bun's "killed 1 dangling process" count includes `Bun.spawn` children but not `Bun.$` ones, and `update` was the only `Bun.spawn` child. A local probe confirmed this. `init` and the second `ls` are ruled out, because they run before `update` starts or after it exits.
- **It recurs.** The same timeout and dangling line appear in 5 Windows runs since 2026-09-24: 36008818600, 36120603554, 36163135186, 36175323110 and 36357036746, all at 20.2 to 20.7 s. None of the failed runs scanned back to 2026-09-02 show it, and passing runs take 4.0 to 4.3 s.
- **Ruled out:**
  - The fn-198 per-file worker (landed 09-27) and the fn-189 `flushStream` exit flush (09-25), because failures predate both.
  - Write-lease contention, because `ls` never takes the lease.
  - The worker's `unref()` and idle timer, because `update` always ends in an explicit `process.exit`.
  - The child backend's kill paths, because they are only used by compiled executables.
- **Still open, no mechanism proven:**
  - `update` not exiting on Windows while an `ls` overlaps it.
  - A synchronous SQLite busy wait: `busy_timeout` defaults to 60 s, and #247 added read-only index opens (`readIndexBinding`) without a busy timeout.
  - The window points at #245 or #247 (09-24/25).
- **Change.** No product fix is justified yet. The test now captures stdout and stderr of `init`, `update` and both `ls` runs through pipes that are read from the start. A watchdog fires 3 s before bun's timeout: it names each child that has not exited, kills it, and fails with each child's start and exit times and output tails. Timeouts are unchanged. A simulated hung `update` produced `Hung: update`, with its output and the concurrent `ls` exit time.
