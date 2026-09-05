# fn144.5 simulator lifetime repair: frozen CUDA validation

Frozen candidate `3d9c0ec49c502ab0c3470c7df14ddac8123ad8d9` completed the original 12-case CUDA SDK restoration matrix with all embedding pairs complete and exact incremental-versus-clean active owner, input hash, vector hash, keyword-result and semantic-result equality. The matrix ran once, exited 0 in 70.99 seconds, and produced no stderr. All 138 captured child requests completed across 24 native children, with CUDA as the only observed backend. The SDK parent capture has no native binding loads, native modules or mapped models.

This is bounded physical evidence for the portable simulator guard. It does not establish that every historical C++ abort had the same cause, or establish Metal, five-minute idle, generation, reranking or performance acceptance.

## Source and runtime identity

- Candidate archive: `/home/gordon/.cache/agent-tmp/gno-native-candidate-3d9c0ec4.tar`, SHA256 `8ee665f35df83c46aa11f8726d394e6364e6d961e83f8916a3684261791bb4ac`.
- Fresh isolated run: `/home/gordon/.cache/agent-tmp/gno-simulator-native-3d9c0ec4-y0wz09qr`.
- Preserved unmodified dependencies: `/home/gordon/.cache/agent-tmp/gno-native-baseline-dependencies/node_modules`; Bun 1.3.14, node-llama-cpp 3.19.1, llama.cpp b10068, CUDA.
- Cached Qwen3-Embedding-0.6B-Q8_0 model SHA256: `06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439`.
- Original matrix source is unchanged: SHA256 `b63d7857fac2ebaf705e8ce6f9b248ae1b19de3e99a9eb5da8b421f844fd9634`. Corpus bytes, query, context settings and predictive scoring remain unchanged. Private run paths differ by design.

The shipping change vendors the guarded simulator session/handle in GNO and installs its factory in memory after exact dependency version/source verification. It does not alter package pins, dependency files, native binaries or estimator selection algorithms. Implementation and CPU/package-portability proof are documented in `notes/fn144.5-simulator-summary.md` and its evidence JSON. Parent committed the implementation; this worker made no Git or Flow mutations.

## Deterministic proof and physical phases

The immutable original-versus-backport fake-binding experiment remains in `notes/fn144-simulator-patch`. Its original 3.19.1 class fails the paused-context regression because session disposal frees the model before the context's memory read and disposal. The guarded version passes all five tests and 19 assertions, covering speculative context use, asynchronous model creation, LRU eviction/backend disposal, initialization failure and late ownership-handle rejection. The upstream source, MIT license, original and patched modules, unified patch proposal and exact hashes are retained. The chosen shipping method is the portable factory, not a dependency patch.

The repair follows [upstream PR 636](https://github.com/withcatai/node-llama-cpp/pull/636), commit `3f686d75aa9cda1b20b80465883f5f7358e42880`. The upstream model/backend disposal guards address the concrete lifetime race. GNO retains installed lifecycle-utils 3.1.1 through its local finalizer compatibility implementation.

Scratch phase preloads recorded actual model/backend load and disposal, simulator estimates and session/handle disposal. The combined successful probe trace contains 25 session-disposal starts while estimates were active; every recorded phase settled. This confirms the relevant overlap occurs with the real workload. These hooks do not identify an individual C++ GetMemoryBreakdown caller. No C++ abort occurred in this replay.

## Observable results and retained failures

All 12 cases passed the frozen repository's observable-state comparator: initial, whitespace, unchanged, absent-1, restored-1, absent-2, restored-2, same-title-duplicate, title-rename, force, materialization-repair and collection-global-catchup. Across the nine complete pairs in the original failing `2beb8aae` run, active owner/input/vector hashes also match this candidate exactly. Differences in the three incomplete original pairs are missing old counterpart state; they are not evidence of numeric drift.

Fresh direct CLI and MCP vsearch returned exactly equal public objects with `vectorsUsed: true`. The captured actual embedding context uses contextSize 2048 and threads 6; raw strings, token arrays, outputs and context arguments are retained. The frozen capture classifier flags the CLI/MCP parent's pure JavaScript `lifecycle.ts` import from `src/index.ts` as a native artifact. Their bindingLoads and mappedModels are empty. These flagged captures are not claimed as clean native-parent acceptance receipts; the harness owner is correcting that classification separately.

The first setup embed exited 2 before inference because worker-only capture preloads propagated into node-llama-cpp's binding-test fork, which has different argv. Both CUDA and the product's automatic CPU binding probe failed; no CPU model inference occurred. That attempt's stdout, stderr, process samples and capture remain intact. The scratch phase preload then removed only its own and the child capture's paired preload arguments from process.execArgv before internal forks. The worker remained instrumented. The explicitly named `cli-embed-capture-scope-fixed` attempt embedded 2 documents with 0 errors. Only then did the single matrix run begin. `attempt-ledger.json` records the correction and all attempts; final helper hashes are in `analysis.json`, while initial helper hashes remain in `provenance.json`.

All observed owned PIDs were absent after the CLI/MCP checks. Post-run GPU state and process IDs are recorded; preexisting user GPU processes were untouched. CUDA slot was released to the host. The matrix's peak sampled owned RSS was 1,989,532 KiB. Instrumented timing and sampled RSS are descriptive, not a performance threshold comparison.

## Evidence handover

- Raw live-run evidence: `/home/gordon/.cache/agent-tmp/gno-simulator-native-3d9c0ec4-y0wz09qr/evidence/`.
- Curated deterministic proof: `notes/fn144-native-artifacts/simulator-lifetime-proof/`, 18 files, with sibling `simulator-lifetime-proof.sha256.json`.
- Curated CUDA evidence and exact scratch helpers: `notes/fn144-native-artifacts/cuda-3d9c0ec4/`, 295 files, with sibling `cuda-3d9c0ec4.sha256.json`.
- Primary result files: `evidence/analysis.json`, `matrix-summary.json`, `comparator-summary.json`, `sdk-matrix.capture.json`, `sdk-matrix.receipt.json`, `sdk-matrix.process.jsonl`, `phases/*.jsonl`, `cli-vsearch.stdout`, `mcp-gno_vsearch.json`, and `attempt-ledger.json`.

The SDK child capture uses one case scope for the whole sequential matrix. Per-case public results and request ordering are retained, but automatic per-case native transcript grouping was not added. The observable-state comparator does not consume the separate native transcript. Parent retains full-suite, integration, Flow and final acceptance ownership.

stage: impl-review - skipped(policy: user disabled formal reviews; host owns acceptance)
