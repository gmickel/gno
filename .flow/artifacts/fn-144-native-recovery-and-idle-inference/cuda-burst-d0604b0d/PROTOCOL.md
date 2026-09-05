# Prepared CUDA cost comparison — not run

Product baseline: original `270c3a74f4f7a3aeb8a60462b4c8e1b4adf45462`, unmodified node-llama-cpp 3.19.1/b10068. Candidate execution must use the extracted npm package SHA256 `f42dfdddd6296e527f3c4bf01d21bb8a685a33996edcfd1c7624e60fe13320bd`, built from `d0604b0d7b0c888653390618ab498187bf71b397`. Helper source is separately pinned at `9244d715`; helpers do not change the product identity. Full archive paths, sizes and hashes are in `archive-pins.json`. Use Bun 1.3.14 and the preserved unmodified dependency tree.

## Shared original fixture and configuration

`original143/corpus/` contains the 143 retained original synthetic documents, each verified against `/tmp/gno-native-baseline-20260905-gmyi58ts/fixtures-manifest.json`. No private vault is involved. `original143/config.json` preserves the exact plain Ivan control configuration except corpus/model path relocation to this Linux host. All four slim-tuned role models remain pinned; TTL is 300000. Existing default context and rerank candidate settings are not adjusted. Hashes and origin are in `original143/fixture-verification.json`.

The retained Linux baseline root has no SQLite index. After the host grants native execution, create independent baseline/candidate indexes from this one shared corpus path. Never copy a database across hosts. Keep each source's schema/identity behavior; record index file and logical owner/input/vector hashes after preparation. `native_package` will reuse the same corpus and seed state for its surfaces, with separate writable run copies as needed. Do not duplicate corpus preparation or overwrite a completed observation.

The separate throughput fixture is the exact fn143 warm30 `rerank-en-1000-start` case. Its original corpus, init/config and source manifest are retained under `notes/fn143-native-tmp/qa-prep/runs/cuda-control-01/`; the original bootstrap is `warm30/baseline/protocol/session-NKEtKI/bootstrap.json`. Preserve its actual document bytes, preset, collection, query and options. The full warm30 run had failures; historical durations are not a clean performance baseline. Rerun both frozen products in the matched experiment.

## A. Primed serial and concurrent bursts

Exact request: SDK `query("What is the verified launch code for project Orion?", {collection:"rerank-en-1000-start",limit:2,noExpand:true,noRerank:false,graph:false,explain:true})`. `explain:true` is the existing native adapter's public-call behavior. This exercises the same query embedding and reranking ports as the retained fn143 warm30 case. Generation is not silently introduced into this fixture.

Use `burst-driver.ts` with one retained SDK client per process. Every process performs one fully recorded first request, followed by 24 measured requests. Serial mode offers one at a time. Concurrent mode offers six waves of four simultaneous public calls via Promise.all. Do not route concurrent calls through `createNativeAcceptanceSession`: it intentionally rejects overlapping runs, as does the original session driver. Do not substitute two independent processes for same-client concurrent admission.

Three paired blocks per mode. Side order is baseline/candidate, candidate/baseline, baseline/candidate. Mode order is serial/concurrent in blocks 1 and 3, concurrent/serial in block 2. Run only one role/process workload at a time on the reserved CUDA GPU. Each mode therefore has 72 measured requests per role; retain every first request and all failures. There are 12 processes and 300 offered requests including primers.

`burst-driver.ts` records full public responses without capture preloads, each invocation's offer/settlement timestamps, first response from driver start, phase makespan, offered/settled/transport-completed counts and process-close duration. An external owned-process supervisor must measure spawn-to-first-response delivery as the complete fresh-process penalty, and retain total process duration. Do not subtract model setup, IPC or package startup from cold cost. These are fresh-process measurements, not cold OS page-cache claims.

Report throughput as valid completed requests per phase makespan, plus the raw transport-completed throughput. A fallback, failed request, missing stage or result mismatch is not a valid completion or a speedup. Report p50/p95 request latency, makespan and all three per-block ratios; do not claim stable p99 from 72 requests. Native stage durations and explain fields are diagnostic, not replacements for complete request timing.

## B. Original expanded query cold behavior

Exact request: SDK `query("what retry budget did we decide and why", {limit:5,explain:true})` against the shared original143 corpus and exact slim-tuned four-role configuration. No `noExpand`, altered timeout, context truncation, candidate reduction or input shortening. The raw config has no explicit candidateLimit. Observed effective policy is candidateLimit20/top20 reranked on both roles; preserve that resolved balanced policy and existing context2048 semantics.

For each of three alternating paired blocks, start a fresh process per role, retain the first request and then three serial requests in that same client. Total 24 requests. Compare baseline and candidate actual `meta`/`explain`: expansion attempted, completed or timed out; whether expanded output was used; vectors/reranking used; warnings/fallbacks; complete returned result objects. Preserve raw generated expansion when captured, but do not assume independently generated text is deterministic. The observed Ivan 5-second cold expansion timeout is a finding to compare against original baseline behavior, not justification to change the budget. A timeout in both products is not a newly introduced candidate regression; a candidate-only timeout remains a regression finding requiring investigation.

## Equality and capture controls

Before interpreting timing, perform separate captured serial first/warm controls for both requests and roles using the pinned fn143 helper. Validate complete result objects, actual model/port inputs and outputs, backend and context arguments with the existing paired comparator. One session per process; no overlap under its single-scope capture contract. Keep model hash preflight and serialized capture out of the plain burst timer; record their own time rather than subtracting guessed overhead. The candidate capture must enter actual child workers; in-process parent hooks are not a substitute.

Retain every full public payload from the plain driver. Compare complete result arrays and stage/fallback state, preserving score/order/provenance. Raw explain timing fields remain available but naturally differ; the existing acceptance projection separates nondeterministic timing/transport from deterministic result/input fields. Never erase result fields to obtain equality. If plain timing has no native transcript, label its native coverage unavailable and link the separate matched captured control rather than manufacturing per-request native evidence.

## Execution boundary and open preparation

Nothing here has run native inference. Host must confirm the exact package/helper freeze and grant the CUDA slot before seed generation, captured controls or timing. Source/dependency/corpus hashes are frozen first. Native_package shares the prepared original143 source paths. The per-role indexes and final absolute plan files are created only after seed authorization.

Launch shape after plans exist: `python3 run-observation.py <plan.json>`. The supervisor must enforce a 180-second per-process bound and 8192-MiB sampled sum of owned RSS, retain stdout/stderr and all observed owned lineage, and clean only its own process group. No automatic reruns. A native abort remains an incomplete cell; do not replace it with a successful sample. Compare pressure/background GPU rows without touching user processes. CUDA-only; no Ivan workload.

Promotion remains blocked by unexplained steady-state degradation. This preparation establishes no acceptance verdict and makes no claim from unexecuted code.
