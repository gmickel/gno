# fn148.4 consolidated evidence

Status: in progress; host owns final acceptance and Flow closure. This receipt consolidates observed results without replacing the original reports or declaring unrestricted performance/native acceptance. No source changes, native runs, gate reruns, or formal reviews were performed during consolidation.

## Retrieval evidence

| Stratum | Captured proof | Identity and limits |
| --- | --- | --- |
| Public lexical | 96 actual CLI, stdio MCP, HTTP MCP and REST requests; 80 result-bearing ordered cross-surface comparisons; independent broad ordering; restrictive K=1/10 and valid zero | Candidate 23ba2c25; synthetic 201-owner fixture. Browser desktop/mobile observed separately, UI result limit 20. |
| Legacy known vectors | 144 groups, 1,800 requests, all exact; 201/2,001/10,001 documents, four workloads, lexical/vector/hybrid, K=1/10, one/four readers | Real SQLite/sqlite-vec with fixed vectors; captured 2d65bedbc5a28fb15231c010f7c071b9081cf7bf. |
| Activated owner variants | 120 groups, 1,500 requests per full run, all exact; two complete runs retained; broad/rare/title-owner/exclusion/empty cases | Captured 803463374075a9f20049cb0cef547dfc33656200; measured source unchanged from requested 9d6c73a9 freeze. Base sizes plus two owners: 203/2,003/10,003. Different titles intentionally change semantic inputs. |
| Explicit vector state | 60 supplemental vector/hybrid calls, all `meta.vectorsUsed: true`, including zero results; full results retained | Retained activated snapshots after stale-title mutation. Stale owner rejected before K; valid same-content owner retained; missing input identity fails explicitly. |
| Skill | 20/20 scenarios, 47/47 checks, 100%; unchanged scorer and parser self-tests | Native GPT-6-Astra medium transport, one response per scenario. Generated commands were not executed; this is command-generation evidence. |

The scaling oracles compare complete ordered public result fields, including score, snippets/ranges and provenance. Eligible selection is independently enumerated; pipeline result assembly/scoring is shared. They establish the deterministic SQL and owner-binding domain, not independent equivalence of every ranking implementation or native model transcript.

Public evidence reconciliation: the original 88/96 driver score expected malformed date bounds to fail. All eight captured responses instead match the existing broad-query ignored-bound contract; `date-contract-reconciliation.json` preserves this correction without changing outputs. The observed REST malformed-query HTTP 500 was fixed and physically retested as HTTP 400/VALIDATION. Actual browser date entry persisted and emitted both bounds in a successful request. Initial failed browser attempts remain retained. Default lexical resident startup was separately observed with zero model loads; missing-local-model vsearch failed explicitly, and is not counted as vector success.

## Cost evidence and failures

The original 10,001-document broad FTS `IN` shape stalled for about five seconds. The identical broad SQL existed before this work: frozen baseline 5,071.5 ms versus then-current 5,060.4 ms. An exact-output correlated `EXISTS` comparison took 7.50 ms and motivated the host-approved fix. The rare selective one-shot comparison became slower, 1.81 to 3.38 ms; retain that tradeoff. The interrupted pre-fix four-reader group is incomplete, not passed. The first serialization-fingerprint harness failure also remains in its original report.

Post-fix legacy 10,001 broad K=10 four-reader p95 response/max timer delay: lexical 40.89/39.98 ms, vector 73.70/76.64 ms, hybrid 135.96/135.08 ms. The worst remaining measured legacy timer delay was 246.28 ms for concurrent hybrid whole-document exclusion. The 97 completed overlapping old/new groups compare exactly after the declared synthetic collection-root projection; original full rows remain available.

Activated-owner measurements overlapped unrelated host CPU tests. They are a separate semantic and load stratum, not a direct legacy speed comparison. At base size 10,001, hashing 9,899 valid owners and 2,354,956 formatted UTF-8 bytes took median 8.14 ms, maximum 10.85 ms in the isolated hash stage. This excludes binding SQL and allocation and cannot be subtracted as complete attribution. Broad K=10 vector p95 was 76.04 ms with one reader and about 295 ms with four; hybrid four-reader p95 was 362.27 ms. The final split-run broad timer reached about 361 ms; the earlier run reached about 365 ms. Even the single Beta-owner case incurred about 20.16 ms vector response despite a 0.016 ms hash stage. Every sample remains available. Warm-up, scheduling noise, five-wave samples and synchronous SQLite constrain interpretation; no universal latency or throughput acceptance is asserted.

## Final integrated gates

Host-observed command exits were green in the isolated 6e25153f gate archive. Log content was inspected during consolidation; these commands were not rerun.

- Bare `bun test`: 5,132 passed, two existing skips, zero failed, 41,089 assertions across 601 files, 276.17 seconds.
- Final lint/Oxfmt: zero errors, 23 warnings, all formatting correct. The original lint failure from artifact files is retained beside the successful final lint log.
- TypeScript: no errors. Documentation verification: 15 passed, zero failed, two skipped.
- Package smoke passed; seven-file sentinel SHA256/stat/count remained unchanged. Raw package logs remain in the isolated cache because they contain machine-local paths.
- Selected memory evaluation: 100% at unchanged 100% threshold. Hybrid: 86% at unchanged 70%. Vsearch-named BM25 evaluation: 88% at unchanged 70%; this is not native-vector inference evidence.

`evidence-manifest.json` hashes the actual reports and gate logs. The captures span explicitly named source checkpoints; they are not represented as one simultaneous final-candidate run.

## Requirement boundary and next receipt

R1/R2/R3 deterministic eligible-domain proof is complete for the captured real-SQLite known-vector and activated-owner cases. Public lexical behavior, valid zero, invalid input, provenance and scope evidence are captured. R4 measurement is complete for the declared increasing-size/concurrent workloads; the measured tails and selective penalty remain explicit inputs to host promotion judgment. R5 repository guidance and gates are owned by the host/docs workers; hosted gno.sh guidance and driven-page QA are queued until AFTER the PR under the user's explicit sequencing override. This worker did not edit or claim to drive the hosted site.

The focused fn148 physical bridge is now captured on CUDA against actual package SHA256 `1a01daff5030dfbab0492d8d7d76a759e699a3effbd87ede8a40a290e6879342` (product 9d0b57e3, helpers f8a278ef). It embedded all 198 active chunks in the unchanged 201-owner fixture. The eligible owner ranked behind 197 excluded owners globally, yet filtered K=1/10 vector rows exactly matched the exhaustive eligible reference; hybrid returned the same owner and every query reported `vectorsUsed: true`. The activated native partition and all current owner input hashes were verified. Both attempts and the initial driver serialization failure are retained in `../native-bridge/cuda-receipt.json` and its 72-file manifest; a separate corrected continuation reused the native embeddings and captured all five final queries. There was no fixture or threshold tuning. All 32 native requests completed, CUDA only, with no parent native loads and all four owned PIDs absent afterward.

The requested matching Metal bridge is now captured and locally verified in `../native-bridge/metal/verification.json`. It reconstructed the same pinned 201-owner fixture locally without index transport, embedded all 198 active inputs natively, and returned exact filtered vector rows at K=1/10 with the expected hybrid owner and vectorsUsed true. All 198 formatted owner inputs occur in the native capture. The 24 Metal requests completed with no capture errors; the governor exited 0 in 8.204 seconds with zero warning time. Parent bindings/modules are empty, while mapped-model evidence is explicitly unavailable on macOS. All 50 transferred files and runner pins were verified. The local model URI/partition identity is retained separately; no cross-backend numeric equality is claimed.

This closes the requested CUDA/Metal filtered bridge evidence. The fixed-vector matrices already establish exhaustive large-domain ordering; no new platform × corpus × surface Cartesian matrix is imposed. Hybrid score assembly is not independently reimplemented by this native bridge. Prior gates remain evidence at their named checkpoints; the host owns the latest integrated gate after fn146.4, promotion judgment and task closure.

Separate native context: the 3d9c0ec4 CUDA restoration matrix completed all 12 incremental-versus-clean mutation pairs and 138 child requests, superseding older incomplete pairs. It also captured equal CLI/MCP vsearch objects with vectors used. That is valuable native proof, but not this filtered-domain scenario. Its capture-classification caveat remains in its own receipt. Broader platform lifecycle, five-minute idle, generation, reranking and aggregate native performance belong to their owning tasks and are not silently made additional fn148 requirements.

stage: impl-review - skipped(policy: user disabled formal reviews; host owns acceptance)
