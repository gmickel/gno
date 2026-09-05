# fn146.3 CUDA model residency acceptance

One matched pair completed: reference a30da442 versus frozen44cf2a1d, canonical helper8b45a54d, Bun1.3.14/node-llama-cpp3.19.1/b10068/CUDA. Candidate package SHA256 `0a2ace980c340b4f845677a3eadfa894cea3b14ea63017ac9b719a4c7e847b53`; all751 shipped src files match the44cf archive. No product/dependency changes, retries, private-vault inputs, SSH or other native workload.

## Observed acceptance

Canonical strict comparator passed6/6 complete public cases. Every pair has identical full search results, deterministic evidence/citation record, generated answer, complete native model inputs and complete native outputs. Both verified Ask calls on both sides executed the actual semantic judge: completed, schema enforced, one model call. The verified answer remains the same abstention where the judge cannot establish support; this is unchanged quality, not a new supported-answer claim.

All31 explicit embedding outputs per side succeed and match both their initial vector and their counterpart exactly. Both sides completed68 captured native requests; explicit metadata initialization is not counted as embedding inference. No capture or driver errors. Both process supervisors exited0 without governor intervention.

The candidate retained child PID912975/generation1 throughout. Reranker model2 completed disposal at1788589859752 during the first Ask, before the paced embedding period. Generation model5 completed disposal at1788589863072 during that period. Request30 completed afterward with only embedding model6 resident; subsequent paced completions retained that same model. The30 paced embeddings span2894ms of actual completion timestamps, with100ms planned arrival spacing and no native pause. This proves idle role retirement while embedding activity continues; it does not claim the reranker first expired during the embedding loop.

Post-gap query loaded reranker model7 and post-gap Ask loaded generation model8 in the same child. The embedding model6 then naturally expired during the later Ask; the final call through the same retained parent port loaded model9 and returned the identical vector. The generation-bound canonical file identity and fingerprint entry remains byte-equivalent in every observed embedding file-cache entry throughout the candidate run. No additional wait was added to force this eviction.

Reference child PID910841 retained embedding1/reranker2/generation3 through all30 paced embeddings (2890ms completion span); all three disposed only at normal close. This is the intended operational difference.

Completed JS model.dispose promises, successful manager load returns and post-request actual residency maps are retained in phases.jsonl.gz. They prove disposal completion at the binding API boundary, not a separately timed C++ kernel or per-allocation GPU reclamation measurement. Context receipts retain unchanged reranking buckets and complete model context arguments.

## Scope and caveats

This is a new paired schema29/TTL1200 stratum, not the old143/145 baseline scope. Six original public calls and their full long-query bytes are unchanged. Both stderr logs retain the existing long-query embedding truncation warning (3022→2044 tokens); this driver introduced no clipping or context change. Actual model inputs/outputs match across the pair.

No throughput/allocation ratio,32-chunk background fairness, REST/MCP cancellation or shutdown acceptance is inferred here. Source task4 changes were excluded by packaging the44cf archive. CPU observer tests verified writable JS disposal, receiver/argument/value/error forwarding and no native load; paired CPU SDK preflight verified identical logical index86762c89 and configb5927808 with zero native/spawn/fetch/dlopen attempts.

Owned sampled PIDs910795/910841/910923 and912931/912975 are all absent. User PIDs1475083/4007014 were untouched. CUDA released to the host after the single pair.

## Evidence and reproduction

Curated root: `.flow/artifacts/fn-146-cancellation-and-bounded-background/model-residency/`. Full raw public/native payloads, all child receipts, process samples, stderr, phase logs, source/package/driver hashes, plans, CPU preflight and comparator output are retained. Large raw files are losslessly gzip-compressed; no SQLite/WAL/cache/model/dependency/source archive is copied.

Run `python3 analyze.py` from any extracted artifact location to reproduce residency-analysis.json using retained gzip raw inputs. SHA256SUMS checks every retained file. Run `bun --no-env-file compare.ts` to reproduce comparison.json from retained gzip payloads. The exact frozen CPU comparator modules are retained under comparator/, with source hashes and pinned zod version in comparator-provenance.json; resolve that dependency from the repository install or an isolated matching install. Both portable CPU analysis commands were run successfully after curation. comparison.json retains the6/6 verdict and every individual full-equality boolean. Native rerun needs the declared frozen distributions, shared synthetic fixture/index and model pins; never execute against a live checkout.

Original scratch root: `/home/gordon/.cache/agent-tmp/gno-fn146-model-residency`. No native rerun is required to inspect or reproduce the CPU analysis.

