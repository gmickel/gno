# CUDA actual native allocation: final-runtime sizing control

Both declared arms completed once. Sized768 uses **4,650,696,704 fewer GPU bytes (4.3313GiB)** and **41,156,608 fewer CPU bytes (39.25MiB)** for native context+compute buffers than auto40960. All six full prepared inputs, actual formatted tokens, unrounded scores, ranks and duplicate indices compare exactly across cold/warm and both arms. **The sized arm was slower in this single ordered pair**; all timings remain below.

This is the independently declared `final-runtime-native-allocation-cuda-v1` stratum on frozen final product44cf2a1d. The auto arm removes only the contextSize override in a development hook. It is not an unchanged270c baseline, a historical-row rerun, or a Metal result.

## Identity and unchanged workload

- Actual package SHA256 `0a2ace980c340b4f845677a3eadfa894cea3b14ea63017ac9b719a4c7e847b53`; all906 shipped files matched the tarball before execution.
- Source root `/home/gordon/.cache/agent-tmp/gno-fn146-model-residency/candidate/distribution/package`; no product edits.
- Bun1.3.14, node-llama-cpp3.19.1, llama.cpp b10068, actual CUDA.
- Cached reranker SHA256 `22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48`.
- Input is the original six complete Metal short-before prepared strings and ownership query, copied losslessly from the pinned fn145 surface capture. Both CUDA arms receive identical strings/order; no clipping or depth reduction. The CUDA file URI points to the same verified model bytes.
- Both actual models report29 GPU layers for28 Qwen3 blocks plus output layer, train context40960; model allocation identical at633,207,296 GPU bytes and165,015,872 CPU bytes.
- Both resolved batch512, current/ideal threads6, flashAttention auto, KV key/value types1. All context options except declared sizing policy remain equal. Unknown/undefined arguments are explicitly retained.
- Actual loaded addon SHA256 `70e62254f49e75c723bc44332324533204d29d64f8a73062be125c1765452102`; build metadata and native API source hashes are pinned.

## Direct native allocation measurement

The observer calls the actual child LlamaContext's `_ctx.getMemoryBreakdown()`. Installed AddonContext.cpp reports `ctx->memory_breakdown()` context+compute bytes by CPU/GPU backend. This is not the GGUF estimator, serialized stateSize, process RSS or whole-device memory. Model/runtime/driver extras are outside this context measure.

Each context was measured immediately after creation, after complete cold scoring, and after complete warm scoring. Values were stable at all three boundaries. Public `llama.getLlamaMemoryUsage()` increments exactly matched the direct counter; context disposal returned aggregate allocation to the model-only values.

| Native context+compute bytes | Sized768 | Auto40960 |
| --- | ---: | ---: |
| GPU |401,594,496|5,052,291,200|
| CPU |4,995,104|46,151,712|

Both public and native scores remain complete and exact. A mutated score and shortened native token stream are rejected by CPU comparison controls. No comparator fields were normalized to obtain equality.

This is dedicated CUDA evidence. CPU/GPU allocation categories on unified-memory Metal would need careful physical attribution and an actual safely admitted Metal control. No cross-platform saving is inferred.

## Timings and sampled process costs

Ordered execution was **sized first, auto second**. Each uses a fresh parent/native child, one cold call and one identical warm call. No cache purge, hidden primer, retry or favorable-row replacement.

| Observed metric | Sized768 | Auto40960 |
| --- | ---: | ---: |
| Native context creation |181.558ms|165.798ms|
| Cold rankAndSort span |364.527ms|313.637ms|
| Warm rankAndSort span |110.546ms|103.138ms|
| Whole cold port request |1884.793ms|1723.612ms|
| Whole warm port request |118.536ms|107.046ms|
| Whole supervised process |2553.627ms|2234.917ms|
| Peak sampled owned RSS |1355.426MiB|1345.770MiB|
| Peak sampled owned GPU allocation |1436MiB|5870MiB|

Creation timing ends before the post-return metric write. Scoring brackets include pass-through formatted-input evidence writes that occur within scoring. Whole requests include observer and IPC overhead. These are instrumented observations, not pure GPU kernel time, an unbiased latency estimate, throughput/p99, or filesystem-cache-cold measurements. The slower sized times remain explicit.

## Admission, ownership and cleanup

CPU hook tests passed4/4 with21 assertions before launch: exact option intervention, untouched inputs/results, counter fail-closed behavior and exact frozen child launch selection. TypeScript helper builds and Python syntax checks passed. Product/helper pins and full input/model hashes were verified.

Each arm independently required two headroom samples with at least12GiB free GPU and12GiB available system RAM. Observed CUDA free was17,932MiB. Conservative admission used the prior same-model/build CUDA Ask's7004MiB full-workload peak as an empirical reference, with8192MiB workload budget plus4096MiB reserve; it did not turn an estimate into an allocation measurement.

Both arms ran under180s wall,8192MiB owned RSS and8192MiB owned GPU caps, sampled around0.2s. Normal product memory checks, precision, GPU placement and timeouts remained active. Both exited0; no stop, native error or stderr.

- Sized parent1006159/native child1006199; binding probe1006245.
- Auto parent1007309/native child1007343; binding probe1007383.
- Birth-identity checks confirmed all sized PIDs absent before auto admission, and all six observed owned PIDs absent at finish.
- Actual GPU process rows include the native children; neither public parent appears as a GPU owner.
- Protected user PIDs1475083/4007014 retained925/428MiB throughout every resource sample. No unrelated process was signalled.
- Final device-used memory returned6156MiB, identical to preflight. CUDA slot released immediately after native completion.

## Files and reproduction

`analysis.json` is the exact CPU comparator result. `SHA256SUMS.json` maps33 preserved payloads to original path/hash, artifact hash and original length; gzip payloads are lossless. README and checksum manifest are additional files.

Included: full fixtures, requests/results, child token/score/context/byte events, resource samples, preflight headroom, process/cleanup receipts, helper and package hashes, native source/binary pins, CPU tests/log, plans and all actual drivers. No SQLite, model weights, native binaries, dependency trees, disposable runtime caches or live/private corpus payloads are included.

Original scratch: `/home/gordon/.cache/agent-tmp/gno-fn145-native-allocation-cuda-44cf2a1d`.

CPU comparison reproduction: decode the gzip payloads into a **new scratch directory**, preserving sized/auto subdirectories, then run `python3 analyze.py`. It rechecks complete equality and native counter invariants; native binary hashing expects the retained local installed paths. This command never runs inference. Inspect native reproduction plans before using a new root; supervisors refuse an existing arm directory and auto admission requires a successful cleaned-up sized receipt. A new GPU run requires host scheduling and is not needed for this evidence.

No failed native attempts were retried: both executed once successfully. Prior Metal pressure failures and prior slower/error records elsewhere remain unchanged. This closes the **CUDA actual allocation** measurement; it does not close Metal R3 or issue an overall spec/release verdict.
