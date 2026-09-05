# Eligible top-K contract fixture v1

Synthetic, offline contract proof for fn-148.1. `manifest.json` hashes the complete deterministic corpus returned by `fixture.ts`, including vectors and metadata. The frozen fn-143 manifest and generator are unchanged. Do not refresh either identity to conceal a failure.

The 201 documents include 200 strongly matching distractors, one inactive row, duplicate owners of a mirror, and one weak lexical match carrying the approved tags, date, author and category. The target has a nearest German chunk plus a more distant English chunk. At limits 1 and 10 the eligible answer is `scope/target.md`, vector chunk 1. Empty allowlists deny all; caller and query scopes intersect. Paths use the original record source and segment boundaries. Language is exact; exclusion examines all document chunks before selecting a language. Failed metadata resolution denies the candidate.

The lexical oracle enumerates all FTS matches without a candidate limit, using the existing 1.5/4/1 BM25 weights, then selects the independently pinned eligible owner. Current production starvation is asserted separately as a negative characterization. Task 2 must replace that characterization with oracle parity without changing the expected result.

The vector oracle computes cosine distances exhaustively over independently identified eligible owner/chunk pairs; the test also asserts the contract produces exactly those pairs. Deterministic oracle ties use owner then sequence. Duplicate owners remain separate in this evidence domain: it does not redefine production owner collapse, full-result deduplication, minScore, recency or project-affinity ordering. Those ranking policies remain unchanged and need downstream integration coverage.

This fixture's unit vectors exercise the oracle, not the native vector implementation or embedding quality. Real-vector acceptance, fn-143 paired-comparator replay, integration of the internal helper, ranking-policy parity, concurrency and performance remain downstream tasks. Missing native coverage is not a vector acceptance pass.

Validation keeps existing boundaries: invalid lexical syntax returns `INVALID_INPUT`; the internal temporal helper continues ignoring an unparseable date bound (public validation remains at its existing boundary). This task adds an internal contract helper without wiring it into public retrieval; no public output or filter syntax changes ship here.

Run from the repository root:

```sh
TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn148-oracle bun test ./test/store/eligible-top-k.test.ts ./test/pipeline/eligible-top-k.test.ts ./test/store/fts-lexical-regression.test.ts
```
