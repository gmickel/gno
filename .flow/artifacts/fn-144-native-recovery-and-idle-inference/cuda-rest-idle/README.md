# CUDA resident idle/reload proof

Candidate: `23ba2c258e2d6c27b03aa7504a7d28f88d1ae2cf` (2026-09-05).
Frozen archive; installed dependency-tree symlink; Bun1.3.14. This is the candidate
before the subsequent lazy-download startup fix. Do not attribute these native
measurements to that later source without rerunning.

The exact retained30-document orchid fixture and request returned20 results in
all eight normal stages. Complete result arrays are identical, including scores,
order, source IDs, snippets, absolute source paths and provenance. Zero
normalizations. DefaultTTL300000 first/warm; separately labeledTTL1200 first/warm,
two metadata-polled real expiry/reload cycles, and fresh-process control.

| Stage | Results | Complete HTTP time (ms) |
|---|---:|---:|
| Default first |20|1734.66|
| Default warm |20|16.14|
| Test first |20|1721.63|
| Test warm |20|14.31|
| Expiry cycle1 |20|1748.22|
| Cycle1 warm |20|16.36|
| Expiry cycle2 |20|1786.14|
| Fresh process |20|1745.86|

Metadata GET `/api/status` continued roughly every150ms during both3-second
expiry waits. Parent12209 remained alive, loaded-model snapshots fell1→0, and
native children12255→12421→12902 retired/reloaded. Owned native worker allocations
peaked1560–1568MiB. Binding-probe grandchildren briefly used386MiB and are included
in ancestry-based samples. Parent never appeared in captured NVIDIA compute rows.
Peak sampled sum of owned RSS1687.43MiB. Other normal parent PIDs:12013,13055.
Default five-minute natural expiry was not awaited; real expiry tests used1200ms.

Separate bounded failure injection killed only owned child16270 during reload,
with `/proc` birth identity and ancestry retained. Same parent15687 returned
HTTP200 lexical fallback:0 matches,`vectorsUsed:false`,`mode:bm25_only` (33.39ms).
Its next request returned the complete identical20 results (1737.31ms).
This is explicit injected-failure containment, not the original crash root cause.

All owned processes/allocations were cleaned up. NVIDIA returned to the original
rows1475083/925MiB and4007014/428MiB. CUDA slot released. Normal server stderr was
empty; raw stdout, stderr, process exit receipts and fault responses are retained.

## Evidence inventory

- `receipt.json`: source commit/archive SHA256, runtime path, isolated environment,
  source-backed corpus path and hashes, pre-existing GPU rows.
- `fixture-verification.json`: all30 bytes match the retained original manifest;
  original serialization subset SHA256 preserved.
- `model-pins.json`: streamed preflight GGUF hashes and sizes.
- `comparison.json`, `fault-comparison.json`: exact array equality, no stripping.
- `full-results.json.gz`: every normal/fault full public response, request,
  parent PID, timing and HTTP status.
- `raw-evidence.tar.gz`: every raw response, config, stdout/stderr, process sample,
  metadata poll, injection receipt and analysis. No native source archive/index.
- `run.py`, `fault.py`: actual isolated runners (machine-local paths explicit).
- `SHA256SUMS`: checksums for all other files in this directory.

## Reproduction

Extract candidate with `git archive <candidate>`, extract into a new source
folder, and link a verified matching dependency tree. Use Bun1.3.14. Recreate the
30-file corpus from the original pinned source-backed fixture, preserving its
path if exact absolute provenance comparison is required. Never copy an index
across hosts; run init/index/embed independently as the runner does.

Copy the runners to a **new unique** outside-/tmp directory, set `S`, `B`, `C` and
model-file paths for that host, and inspect the environment/config receipt before
running. `run.py` initializes its own index, seeds30 vectors under300000TTL and
executes the8-stage REST proof. `fault.py` uses that isolated index and injects
SIGKILL only into the newly reloading native child of its owned serve parent.
Both record full responses and clean up owned process groups with bounded waits.
Never run against a live/private index or modify the pinned baseline directory.

No fn143 comparison record was fabricated from incomplete native capture: this
proof uses direct full REST-array equality. Actual child backend/model transcript
hooks were not enabled; CUDA intent, per-PID NVIDIA allocations, child command
identity and preflight model hashes are separate evidence. Original Ivan3/3,
full native-port equivalence, CLI/MCP coverage and task144.5 child-aware capture
remain separate acceptance gates. No overall spec-complete verdict.

## Bounded fn143 response comparison

`bun .flow/artifacts/fn-144-native-recovery-and-idle-inference/cuda-rest-idle/compare-responses.ts`
replays the existing fn143 comparator against the complete unmodified public
results in these eight stages. Result:8 cases passed; a deliberately changed
first result score is rejected. `fn143-response-comparison.json` is the small
summary; `.json.gz` retains complete manifests and projected records.
`index-pins.json` identifies the post-run synthetic SQLite snapshot files.

This is a posthoc response-only projection, with semantic/native coverage marked
**incomplete**. It is not a preregistered baseline/candidate native-acceptance run.
The first candidate response is the equality reference for subsequent stages;
there is no cross-host provenance normalization or historical-baseline equality
claim. Every original result field is retained in the projected provenance.
