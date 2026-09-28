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
