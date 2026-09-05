# CUDA cost validation — fingerprint reuse, 9d0b57e3

The fixed candidate completed all 72 serial burst requests at **4.403 requests/s**, versus the original baseline's 72 at **3.720 requests/s**: 18.4% higher throughput in this bounded matched screen. The earlier 57.2% serial regression remains recorded in `../cuda-burst-d0604b0d/`. Actual child instrumentation now observes one full embedding-model hash in the first request and none in three warm requests. Successful full public results remain exact.

This is scoped native cost evidence, not an overall task or release verdict. Baseline native failures prevent an unqualified concurrent speedup claim. Fresh-process startup remains slower in the candidate.

## Frozen identities and protocol

`archive-pins.json` identifies original product `270c3a74`, candidate product `9d0b57e3`, actual npm package SHA256 `1a01daff5030dfbab0492d8d7d76a759e699a3effbd87ede8a40a290e6879342`, and helper `98252a9c`. The package has 902 files and 12,848,715 bytes. Bun 1.3.14, node-llama-cpp 3.19.1, llama.cpp b10068 and CUDA were preserved. No dependency tree, native binary, model, context policy or query input changed. Canonical development helpers were installed separately into capture roots; plain timed processes have no capture preload.

The exact original fn143 request is `query("What is the verified launch code for project Orion?", {collection:"rerank-en-1000-start",limit:2,noExpand:true,noRerank:false,graph:false,explain:true})`. Three alternating paired blocks each execute serial and concurrent strata on both products. Each process retains one SDK client, records its first request, then offers 24 burst requests. Serial sends one at a time; concurrent sends six waves of four. `execution-order.json` and `plans/` retain exact order and parameters. All complete response payloads and offer/settlement times are retained.

Warm30 indexes start from independent SQLite backups of the retained fn143 baseline index. The baseline seed embeds zero missing inputs; the candidate seed embeds two, without errors. Seed receipts are retained. Original143 controls reuse isolated backups of the previously verified 143-document indexes; they do not rebuild or alter the corpus. Config files and original document hash verification are retained. SQLite backup bytes are not claimed identical across files. All state remains on this Linux host.

The host finished its focused CPU check before timed execution and reserved CUDA for this run. Existing user GPU processes were untouched. No cold filesystem-cache or stable p99 claim is made.

## Completed serial and concurrent work

| Stratum | Baseline | Candidate |
| --- | ---: | ---: |
| Serial valid completions | 72/72 | 72/72 |
| Serial measured makespan | 19.356 s | 16.353 s |
| Serial valid throughput | 3.720 req/s | 4.403 req/s |
| Serial p50 / p95 | 269.05 / 279.55 ms | 227.15 / 233.56 ms |
| Median time outside reported pipeline | 46.80 ms | 61.84 ms |
| Concurrent valid completions | 45/48 started burst calls; 24 unstarted | 72/72 |
| Concurrent measured makespan, completed process observations only | 10.433 s | 6.250 s |
| Concurrent valid throughput, same restricted denominator | 4.313 req/s | 11.520 req/s |
| Concurrent valid p50 / p95 | 707.17 / 1038.08 ms | 347.88 / 358.90 ms |

**All 300 declared positions are accounted for:** 275 recorded responses comprise 272 successes and three returned baseline errors; one interrupted baseline cold invocation has no response; its 24 subsequent burst requests were never started. Candidate accounts for all 150 planned responses successfully. No retry or replacement occurred.

`warm30-block1-concurrent-baseline` exited with SIGABRT during its first cold/primer invocation, before any concurrent burst began. Its stderr reports `GGML_ASSERT(bufs.size() == 1) failed` in llama-model.cpp:1708. This does not establish concurrency as the cause. The process receipt records exit code -6; there is deliberately no fabricated result.json. Another baseline concurrent cell returns three context-allocation errors, preserved in its full responses. The analyzer's baseline concurrent aggregate covers only two completed process observations, not all 72 declared burst positions. These failures invalidate an overall matched concurrent speedup conclusion.

Every successful full result array matches the captured original baseline reference exactly, including scores, ordering, snippets and provenance. Every successful whole public payload also matches after excluding only nondeterministic explain timing lines; those lines remain in raw payloads. Separate captured controls do not imply per-call native receipts for the plain concurrent bursts.

## Cold tradeoff and original expanded control

Fresh-process spawn-to-first-response warm30 penalties were baseline **2320.46, 2328.16, 2336.36, 2333.30, 2342.44 ms** for five completed starts and candidate **2714.19, 2838.87, 2743.01, 2759.73, 2798.38, 2734.70 ms** for all six. Medians are **2333.30 versus 2751.37 ms**, a candidate increase of **418.07 ms / 17.9%** among completed starts. The sixth baseline start aborted and is excluded explicitly. These totals include process/package/model acquisition; this is not a filesystem-cache-cold experiment.

Separate captured first/warm controls ran both products for warm30 and the unchanged original query `query("what retry budget did we decide and why", {limit:5,explain:true})`. All eight public calls completed with full native coverage. All four paired fn143 comparisons passed, full result arrays were exact, and a deliberately mutated score was rejected. Canonical helper 98252 completed installation without the earlier helper's missing-module workaround.

Original143 first and warm controls used expansion, vector retrieval and reranking on both products. Actual resolved policy reports candidateLimit 20 and top 20 reranked; raw configuration has no candidateLimit override. Candidate cold expansion took 3864.55 ms in its captured explain record and was used, with no fallback. Capture overhead is excluded from the plain cost table. The earlier three plain cold pairs are retained in the previous artifact; they were not repeated because only short correctness controls were requested for this fix. This CUDA evidence does not erase the separately observed Ivan cold expansion timeout.

## Actual model-read diagnostic

A separate candidate process performs first plus three warm serial requests with a development-only pass-through stream wrapper. Child PID 279860 handles init IDs 1, 6, 11 and 16. Exactly one complete **639,150,592-byte** embedding GGUF stream occurs, at init 1, lasting **416.80 ms**. Warm init IDs 6/11/16 produce no full-file stream. Raw boundaries and caller stacks remain under `observations/hash-diagnostic-candidate/hash-streams/`. The old candidate recorded four full reads in the same diagnostic. No bytes, inputs, model options or public outputs were changed by instrumentation, whose cost is excluded from plain timings.

## Inventory and CPU reproduction

- `cost-analysis.json.gz`: full aggregate, all 275 response summaries, missing-observation accounting, capture comparisons, hash events and original post-run PID observation.
- `observations/`: every seed, timed cell, abort/error, captured control and diagnostic payload/log. Gzip preserves original bytes. Small process receipts remain plain JSON.
- `plans/`, execution receipts and driver sources: exact inputs, ordering, code and bounded supervisors.
- `original143/`, `warm30/`: configuration and fixture verification; no disposable caches or databases.
- `analyze-cost.py`: original scratch analyzer; `analyze-cost-portable.py`: compressed-artifact reader. Run `python3 analyze-cost-portable.py`; compare decoded `cost-analysis.reproduced.json.gz` with `cost-analysis.json.gz`. The PID liveness field is a fresh observation when reproduced; the original absence receipt remains authoritative for run completion.
- `SHA256SUMS`: all other artifact files; verify with `sha256sum -c SHA256SUMS`.

Original raw root: `/home/gordon/.cache/agent-tmp/gno-fn144-burst-9d0b57e3`. All 32 observed owned PIDs were absent at completion; CUDA was released to the next authorized worker. No further native run is required for this bounded cost handover.
