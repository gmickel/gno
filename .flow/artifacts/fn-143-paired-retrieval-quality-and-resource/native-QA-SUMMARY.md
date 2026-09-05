# fn143 native harness control evidence

Same-source controls only: baseline and candidate product source both archived commit `270c3a74f4f7a3aeb8a60462b4c8e1b4adf45462`. No optimized candidate or default-platform promotion demonstrated. Native failures remain incomplete; no success-subset timing summaries.

## Reproducibility

Archive SHA256 `ca991b29e0e23451290b82f8999fbca8725f20e4ac684e2acbc09ead9fd86d73`; local archive `/tmp/gno-native-baseline-20260905-gmyi58ts/source.tar`, local selected source `snapshot-source/` beside this document. Ivan archive `/tmp/gno-native-baseline-20260905.VQtXt5/source.tar`, selected source its `source/` directory. Only development acceptance helpers supplement snapshots; command verifies archived product bytes and links. Both Bun 1.3.14, node-llama-cpp 3.19.1. Ivan scratch Bun `/tmp/gno-native-tools-1314.KrONBb/bun-darwin-aarch64/bun`; live installation untouched.

Each pair has independently built SQLite indexes and one shared physical synthetic corpus root, preserving absolute source paths, mtimes and hashes. No private documents. Model hashes and role URIs are in each manifest. Cached models only, native build disabled, explicit CUDA or Metal. Native watchdog preserves stdout/stderr, owned process-group RSS, timeout and Metal pressure. No live config/index/service mutations.

Primary fixture has 296 documents and 51 declared scenarios, but this native control selects the two-document `rerank-en-1000-start` collection and embeds only those two documents. This is scoped scenario coverage, not complete fixture coverage. Supplementary orchid fixture has 30 independently indexed documents and default answer/context budgets.

## Controls and failures

Paths below relative to this directory.

| Evidence | Result |
|---|---|
| `runs/cuda-control-01/control-v2-comparison.json` | SDK real CUDA embedding + rerank, complete 2/2; exact equality and mutated-score negative rejection |
| `runs/cuda-control-01/surface-comparison-final.json` | CLI, stdio MCP, resident HTTP MCP and REST each complete 2/2, exact equality |
| `runs/metal-control-01/embedding-only-comparison.json` | Explicit noRerank/noExpand/graph:false SDK control complete 2/2; equality + negative rejection; limited configuration |
| `runs/metal-control-01/surface-comparison-final.json` | Same limited Metal configuration: stdio MCP, resident MCP and REST complete 2/2; CLI baseline complete, candidate Bun native panic, incomplete |
| `runs/cuda-orchid-01/orchid-verified-comparison.json` | Default-budget verified Ask with true rerank: complete 2/2, actual semantic judge modelCalls=1 each; uncertain claim/abstention equal, evidence mutation rejected |
| `runs/metal-orchid-01/orchid-verified-comparison.json` | Default-budget verified Ask with explicit noRerank: complete 2/2, actual semantic judge modelCalls=1 each; uncertain claim/abstention equal, evidence mutation rejected |
| `runs/cuda-control-01/warm30/report.json` | 30 paired observations / 60 samples; 10 native child failures, incomplete, zero performance summaries |
| `runs/metal-control-01/warm30-embedding-only/report.json` | 30 paired observations / 60 samples; 3 native child failures, incomplete, zero performance summaries |
| `runs/cuda-control-01/uninstrumented-10/` | Matched diagnostic without capture/preload: 10 fresh owned SDK sessions, 20 retained-client queries and all closes completed; no failure reproduced |

Warm30 failures occurred before a completed primer/measurement record. CUDA stderr includes pure virtual method calls, Bun segmentation fault, and `GGML_ASSERT(bufs.size() == 1)` in native memory accounting. The native GetMemoryBreakdown stack does not establish its JavaScript caller: it can be internal context construction. Instrumented-session failure root cause remains unresolved; the uninstrumented diagnostic narrows hypotheses but does not prove capture caused failures. Metal failures report `GGML_ASSERT(buft)`. No automatic rerun to select successful observations.

Earlier rows remain immutable: CUDA control v1 optional-stage classification incomplete; Vulkan CLI v1 launch policy failure; stdio v2 transient development-driver receiver recursion; corrected control/surface revisions have distinct filenames. Default Metal true-rerank two-document workload pressure watchdog failure remains separate and incomplete. Historical 143-document expanded/reranked workload pressure failure also remains incomplete; no shrinking its configuration to claim success.

Warm30 started after host full CPU gate completed; ordinary shared-host background work remains uncontrolled. Small quality controls and lifecycle screens are not percentile claims. Metal lifecycle receipts are in `lifecycle/LIFECYCLE-SUMMARY.md`: repeated/novel/two-session-overlap warm cases all six samples complete; one comparison block compares three cases and passes; fresh/model-cold/default-TTL postidle all six complete and three comparisons pass. Each has one observation, therefore inconclusive. Separate TTL1200/postidle2500 retained SDK case successfully reacquired models on both sides, with observed unload/RSS drop and next-query cost. This does not invalidate the earlier stale retained-port/API failure: the SDK reacquisition path differs. CUDA lifecycle evidence belongs to sibling `state-screens/`.

A separately pinned orchid expanded-semantic Metal case enabled expansion with noRerank:true and graph:false, unchanged cached expansion model/context2048. Baseline pressure watchdog stopped at 5.80 seconds with pressure2, exit-15; no completed record. Candidate was not launched under pressure. Evidence `runs/metal-orchid-01/baseline-expanded-semantic.*`; expansion input/output coverage remains unmet. Original 143-document failure remains a separate row.

Final CUDA orchid expanded-semantic pair retained true rerank, enabled expansion, and left cached models/context unchanged. Both completed native execution in approximately 9.65 seconds without watchdog stop. Actual expansion generation prompt and output are captured: temperature0, seed42, maxTokens512, contextSize2048. Both raw generation outputs end mid-JSON string; query_expansion capability reports failed/expansion_error. Therefore both records remain incomplete/native_fallback. Exact paired comparison passes and mutated-score negative rejects. Evidence `runs/cuda-orchid-01/{baseline,candidate}/expanded-semantic.json.gz` and `expanded-semantic-comparison.json`. This proves actual expansion input/output capture, not successful expansion behavior. All native slots released; no further probes scheduled before successor implementation.

Full raw responses are compressed side-level `*.json.gz`; surface directories retain capture, response, stdout, stderr and process diagnostics. Copied remote evidence excludes SQLite databases and corpus duplicates; remote scratch retains originals. Helpers in this directory reproduce setup and execution; all native entrypoints require explicit opt-in. `command-plan.ts` creates immutable command configurations and manifests; final invocation is `bun scripts/retrieval-acceptance.ts --config ABSOLUTE_RUN_JSON --native`.

Harness evidence supports exact comparison, negative rejection, actual model/input/citation capture and honest incomplete reporting. Default Metal reranking, original expanded workload and stable repeated-session timing remain HOLD for successor fixes and reruns.
