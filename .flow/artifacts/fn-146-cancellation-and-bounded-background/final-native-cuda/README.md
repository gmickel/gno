# fn146.5 physical native handover

Physical CUDA and Metal evidence ready for host acceptance. Product, Git and Flow unchanged by this worker. Both GPU slots released; all exercised phase boundaries contain owned descendant absence receipts. Host owns task completion and final project gates.

## Frozen inputs

Actual npm-shaped GNO 2.0.0 package from `f64c41c97e196e3bffdba23bc1c006bca7489b28`, archive SHA256 `56587f10c9969a795d6aa527c29fe8a057720a97d9f9e5de335daa996e706655`. Canonical helper commit `8b45a54d9fab684fddb69175e8c836dad4b935b2`, helper archive SHA256 `22db88f0d50558da2cb957950a56d791adae81f1865fc76841c70579f39cae04`. All shipped product files matched the frozen package manifest. Bun 1.3.14; existing compatible node-llama-cpp 3.19.1 dependencies; no install or model download.

Original synthetic foreground corpus and query `Who owns the meadow migration?` retained. CUDA uses original `noRerank:false`; Metal uses original `noRerank:true`. Both use `noExpand:true`, `graph:false`, collection `probe`, limit3 and default model/context budgets/300000ms TTL. MCP receives its supported original schema (no unsupported noExpand field). New background fixture and synthetic write permissions are explicitly pinned.

## Captured acceptance evidence

| Evidence | CUDA | Metal |
| --- | --- | --- |
| Idle/background full query and verified Ask response equality | Both exact | Both exact |
| Actual child model inputs/outputs | Embedding/rerank; Ask also two generation calls; exact | Embedding; Ask also two generation calls; exact |
| Selected model hashes and actual backend | Valid / CUDA | Valid / Metal |
| Verified Ask outcome, idle and background | Abstention; one unresolved claim, one semantic judge call each | Same outcome and counts |
| Twelve concurrent foreground query comparisons | 12/12 exact | 12/12 exact |
| Actual background demand at eight foreground completions | Three observed selections, two with competing foreground | Observed selection with competing foreground |
| ACK before earned dispatch; observed maximum queue | Confirmed;8 | Confirmed;8 |
| Native background batch cap | 33 batches,1024 chunks, each≤32 | 1024 chunks, each≤32 |
| Durable partial backlog | 418 committed background owners,670 physically unfinished | 98 committed background owners,30 physically unfinished |
| Native resumed passage inputs | Exactly670 missing IDs, once each | Exactly30 missing IDs, once each |
| Final active background coverage | 1088/1088,0missing,0duplicate | 128/128,0missing,0duplicate |
| Actual CLI daemon initial-sync / serve in-flight SIGTERM | 781ms /789ms | 1450ms /1452ms |

The CUDA partial-backlog stratum retained448 total committed shadow owners (30foreground+418background); Metal retained128 (30foreground+98background). Every committed row survived restart exactly and all30 legacy vectors were unchanged. Active eligibility was missing for the whole shadow partition at exit; that count is deliberately distinguished from physically unembedded background chunks. The real native resumed inputs match only the physical missing set, not already committed rows.

Actual REST disconnect, queued REST cancellation, HTTP MCP cancellation notification/disconnect, accepted MCP background job after originating session DELETE, and separate stdio notification/disconnect were exercised. Caller completion and actual dispatcher settlement are distinct receipts. CUDA REST retained native ownership126ms after caller abort; Metal REST/notification/disconnect retained11/11/6ms. CUDA's notification-selected embedding stage had already ended2ms before notification; its negative retention value stays raw and is not claimed as active-native cancellation. The Metal notification and CUDA REST cases provide the active-native evidence.

All six API/restart/stdio/CLI phases enforce prior owned-PID absence before launching the next model owner. CUDA partial-backlog shutdown took5404ms; Metal took5097ms under the unchanged shared5+5+1second budget. Actual CLI cases use the packaged CLI entry. The API observation stratum uses the real startServer factory seam transparently and is labelled separately.

## Scope limits and retained negatives

CUDA revisionsv1–v5 retain every failed run and its actual outputs. Failures came from scratch capture-scope misuse, a redundant pending-phase read, raw MCP caller/session lifecycle mistakes, and waiting for sync embedding to finish before attempting the shutdown case. Corrected scenarios use new run/config identities; no product changes, silent retries, threshold reductions, or omitted raw rows. Revisionv1's stdout/stderr drain produced an object string; its native sidecars/HTTP bodies remain intact and that stdout limitation is explicit.

The exact fn143 response projection removes only `verification.semantic.durationMs` telemetry. No public result, citation, vector flag, fallback or error is harmonized. The earlier scratch adapter contradictory `vectorsUsed:true`/`vectorStatus:unavailable` mapping remains in the failed receipt; corrected mapping preserves the public-reported flag while declaring native coverage separately.

Actual model inputs and outputs compare exactly. Whole capture payloads do not: accumulated model-load inventories differ between cold and resident calls. Full inventories and context events remain recorded; selected model hashes are validated independently. Ask abstention parity with an executed judge is not evidence of a supported generated answer.

The physical tests do not claim a stuck GPU kernel, a forced native kill branch, queue saturation at64, historical original143-query acceptance, or default Metal reranking coverage. Task4's focused noncooperative owned-child tests remain separate. No performance promotion claim is made.

The separate exact signal observer provides additional CUDA MCP notification evidence: successor rerank request22 was native-active when its signal aborted, and that same child/PID/generation/request ended168ms later. This is recorded in `fn146.5-cuda-notification-settlement.json`; it does not overwrite the stale pre-trigger embedding stage's negative retention field.

## Durable artifacts and reproduction

- `.flow/artifacts/fn-146-cancellation-and-bounded-background/final-native-cuda/`
- `.flow/artifacts/fn-146-cancellation-and-bounded-background/final-native-metal/`

Each directory has `SHA256SUMS` and an `inventory.json`: every archived source file has its byte length and SHA256; each archive has its compressed SHA256. Raw evidence is losslessly gzip-compressed with gzip mtime0. No model binaries, SQLite files, or cache payloads are included. CUDA contains all eight revisions/strata; Metal contains the full corrected run and fairness supplement. Original task-cache evidence remains untouched.

CUDA repro after a new GPU grant: regenerate a new configuration with the curated `fn146.5-configure.ts`, retain the separately declared scenarioPhase/backgroundDocumentCount/shutdownDocumentCount from the archived pinned configuration, then run `TMPDIR=/home/gordon/.cache/agent-tmp python3 notes/fn146.5-supervise.py NEW_CONFIG --native`. A used root is rejected. All physical driver revisions/configs and archive identities are retained for exact reproduction; model caches and same-host index preparation remain host-local.

Metal frozen tools root: `/private/tmp/fn1465-tools-f64.u1aa76`. Original commands: `python3 notes/fn146.5-ivan-transport.py --run /private/tmp/fn1465-tools-f64.u1aa76/metal-run.json --native` and the separate `metal-fairness-run.json`. Reproduction requires new roots/configs. Policy remains capacity-warning30-v1: pressure1 start, warning2 cumulative≤30seconds, critical4 immediate stop,6144MiB,120seconds per isolated phase. Both runs observed zero warning seconds and ended at pressure1. Existing SSH master was reused; live Bun/config/index/services were untouched.

Analysis drivers are included. Authoritative detail: `fn146.5-{cuda,metal}-native-summary.json`, `-native-inputs.json.gz`, `-fairness.json`, and `-durable.json`. These preserve the distinctions above and point to the full raw receipts.

stage: impl-review - skipped(config: no formal review requested; host owns acceptance)
