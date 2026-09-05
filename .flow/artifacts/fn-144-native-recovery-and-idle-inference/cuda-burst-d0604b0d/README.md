# CUDA cold, serial and concurrent cost screen — d0604b0d

**Default promotion remains blocked: the candidate's primed serial throughput regressed by 57.2%.** A separate native-child diagnostic attributes about 400 ms per request to rereading and hashing the entire embedding GGUF on each newly created port. All successful public results remain exactly equal, and the captured first/warm controls pass the fn143 comparator with complete native coverage.

Candidate product: `d0604b0d7b0c888653390618ab498187bf71b397`, executed from npm tarball SHA256 `f42dfdddd6296e527f3c4bf01d21bb8a685a33996edcfd1c7624e60fe13320bd`. Baseline: original `270c3a74f4f7a3aeb8a60462b4c8e1b4adf45462`. Development helper: `9244d715`. Bun 1.3.14, node-llama-cpp 3.19.1, llama.cpp b10068, CUDA; unchanged cached models. `archive-pins.json` identifies the separate product, package, helper and baseline archives. No source archive, dependency tree or disposable cache is copied into this artifact.

## Matched cost results

Three alternating paired blocks used one retained SDK client per process, one fully retained cold/primer request, then 24 requests. Serial offered one at a time; concurrent offered six waves of four simultaneous requests on that same client. No fn143 capture session was used to simulate concurrency: it explicitly serializes calls. The plain timing driver preserves every complete public response and offer/settlement time.

| fn143 warm30 stratum | Baseline | Candidate |
| --- | ---: | ---: |
| Serial valid completions | 72/72 | 72/72 |
| Serial total measured makespan | 19.088 s | 44.564 s |
| Serial valid throughput | 3.772 req/s | 1.616 req/s |
| Serial p50 / p95 | 264.78 / 274.58 ms | 615.97 / 645.63 ms |
| Median time outside reported pipeline | 44.66 ms | 453.33 ms |
| Concurrent valid completions | 68/72 | 72/72 |
| Concurrent total measured makespan | 15.779 s | 13.295 s |
| Concurrent valid throughput | 4.310 req/s | 5.415 req/s |
| Concurrent p50 / p95 of valid requests | 713.35 / 1039.62 ms | 736.47 / 763.04 ms |
| Fresh process to first response, median across six processes | 2326.92 ms | 2750.85 ms |

The baseline concurrent cells returned four errors across three blocks: `A context size of 24 is too large for the available VRAM`. All four remain in the raw responses and completion counts. Because those baseline cells are incomplete, the concurrent numbers do not support a valid matched speedup claim. No failed request was retried or replaced.

The exact fn143 request was `query("What is the verified launch code for project Orion?", {collection:"rerank-en-1000-start",limit:2,noExpand:true,noRerank:false,graph:false,explain:true})`. The existing fn143 adapter already enables explain. Corpus, configuration, query, options and ports were preserved. This fixture exercises query embedding and reranking, with expansion and graph explicitly disabled. The first request includes process/package/model acquisition; no cold OS-cache claim is made.

## Original expanded query cold diagnostic

The shared original143 corpus contains all 143 retained synthetic documents with verified original hashes. Independent baseline/candidate indexes each embedded 143 inputs with zero errors. The same shared absolute corpus paths preserve complete public provenance. `original143/config.json` relocates only corpus and model paths from the retained plain Ivan control to Linux; the four-role slim-tuned policy and 300000-ms TTL remain unchanged.

Exact query: `query("what retry budget did we decide and why", {limit:5,explain:true})`. Three alternating paired blocks each used a fresh process and then three serial requests in the same client, for 24 total requests. Both products completed all three cold and nine primed requests with expansion, vectors and reranking used. No expansion timeout or fallback occurred on CUDA. Actual resolved metadata was `candidateLimit:20`, `top 20 reranked`; raw configuration has no explicit candidateLimit override.

| Original expanded query | Baseline | Candidate |
| --- | ---: | ---: |
| Complete cold penalties, spawn to response | 4609.35, 4697.32, 4582.79 ms | 4974.51, 5006.53, 4954.86 ms |
| Primed completions | 9/9 | 9/9 |
| Primed p50 / p95 | 1338.35 / 1388.29 ms | 1672.09 / 1740.88 ms |

A complete cold request taking slightly over five seconds is not itself an expansion-budget timeout: the raw meta/explain confirms expansion was used. This CUDA result does not resolve the separately observed Ivan cold expansion timeout.

## Equality and actual native evidence

All **324 declared plain calls are recorded**: 320 successful responses and four baseline concurrent errors. Every successful full result array matches its captured baseline reference exactly, including scores, order, snippets and provenance. Every successful whole public payload also matches after excluding only the explicitly identified nondeterministic explain timing line. Raw payloads and timing lines remain unchanged in the compressed results.

Separate captured serial first/warm controls ran both workloads on both products: eight public calls, complete native coverage in all eight. All four paired comparisons passed the fn143 comparator, full result arrays were exact, and a deliberately mutated score was rejected. Baseline capture is in-process because the original product owned native inference there; candidate capture follows its actual child. Candidate controls contain 24 complete child requests in total. The plain burst calls do not acquire synthetic per-request native receipts from those separate controls.

Initial capture setup attempted four controls but failed before native execution because the helper installer omitted `evals/agentic/canonical.ts`. Those four stderr/exit receipts remain under their original observation names. The separately named `*-complete-helpers` controls add only canonical.ts/types.ts from the same pinned 9244d715 helper and complete successfully. Product files are unchanged.

## Hash diagnostic

One separately named candidate process performed a first request plus three primed serial requests. A development-only stream wrapper captured the exact GGUF stream caller without changing bytes, options, model or product code. Its overhead is excluded from the plain cost table.

Child PID 262054 handled init requests 1, 6, 11 and 16. Each read the entire **639,150,592-byte** Qwen embedding file; measured stream durations were **413.66, 416.20, 381.39 and 413.79 ms**. The captured JavaScript stack is `fingerprintModel` → `NativeDispatcher.port` → init dispatch. Thus the repeated full-file read is observed in the real child, not merely inferred from source. The raw stream events and request boundaries are retained under `observations/hash-diagnostic-candidate/hash-streams/`.

This evidence motivates generation-bound reuse of a verified model fingerprint with fail-closed identity checks. That repair is outside this frozen product and must receive a new package and matched rerun. These failed cost results must remain visible.

## Inventory and reproduction boundary

- `cost-analysis.json.gz`: aggregate, all 324 call summaries, per-observation metrics, exact equality checks, capture comparisons, full hash diagnostic and post-run PID check.
- `observations/`: all seed, timing, initial capture-error, completed capture and hash-diagnostic payloads/logs. Gzip preserves original bytes; process receipts remain small plain JSON.
- `plans/`, `execution-order.json`, `PROTOCOL.md`: preregistered cases, exact plans, order and bounded protocol.
- `burst-driver.ts`, supervisors, capture helpers, hash wrappers and analyzers: exact scratch execution code. `analyze-cost.py` uses original machine-local raw paths; `analyze-cost-portable.py` reads this compressed artifact without native execution.
- `original143/`: exact config, 143-file verification and seed hashes; `warm30/config.json` preserves the prior fn143 configuration. Indexes stay in the isolated scratch root; no database is copied across hosts.
- `SHA256SUMS`: every other artifact file. Verify from this directory with `sha256sum -c SHA256SUMS`.

Original raw root: `/home/gordon/.cache/agent-tmp/gno-fn144-burst-preparation`. Every observed owned PID was absent after the run; the CUDA slot was released. User GPU processes and live services were untouched. Resource counters are sampled observations; p99, long-duration throughput, cold filesystem cache and Metal acceptance are not claimed. No overall task/spec completion verdict.
