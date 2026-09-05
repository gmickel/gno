---
satisfies: [R5, R6]
---
# fn-146-cancellation-and-bounded-background.5 Exercise cancellation fairness and restart in live QA

## Description
Exercise cancellation fairness and restart in live QA. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** docs/DAEMON.md, docs/API.md, docs/MCP.md, docs/SDK.md, ../gno.sh/src/lib/gno-docs.tsx, .flow/artifacts/fn-146-cancellation-and-bounded-background/
**Touches:** [docs/DAEMON.md, docs/API.md, docs/MCP.md, docs/SDK.md, ../gno.sh/src/lib/gno-docs.tsx, .flow/artifacts/fn-146-cancellation-and-bounded-background/]

### Approach

- Run real client disconnects, queued/deadline cancellation, background backlog with incoming foreground requests and isolated daemon shutdown/restart.
- Use fn-143 complete results/citation equality against idle baseline; report request latency, cancellation settlement, queue occupancy and native memory with raw samples.
- Reconcile docs already updated in behavior tasks, run full gates and drive any changed hosted pages. Coordinate fn-151 gate fix without reimplementing ReaderGate here.

### Investigation targets

**Required:**
- `docs/DAEMON.md:107`
- `docs/API.md:1031`
- `docs/MCP.md:1569`
- `docs/SDK.md:571`
- `scripts/serve-shutdown-smoke.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun run lint:check
bun run typecheck
bun test
bun run docs:verify
bun run smoke:serve-shutdown
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] No dropped/duplicated backlog, stale publication, false success or unexplained foreground quality loss.
- [ ] Finite shutdown and resumed backlog observed through actual processes on CUDA and Metal for native paths; missing acceptance remains explicit.
- [ ] Warm/concurrent cost of single-active admission/fairness is evaluated before promotion, not assumed acceptable.

## Done summary
# fn146.5 physical native handover

Physical CUDA and Metal evidence ready for host acceptance. Product, Git and Flow unchanged by this worker. Both GPU slots released; all exercised phase boundaries contain owned descendant absence receipts. Host owns task completion and final project gates.

### Frozen inputs

Actual npm-shaped GNO 2.0.0 package from `f64c41c97e196e3bffdba23bc1c006bca7489b28`, archive SHA256 `56587f10c9969a795d6aa527c29fe8a057720a97d9f9e5de335daa996e706655`. Canonical helper commit `8b45a54d9fab684fddb69175e8c836dad4b935b2`, helper archive SHA256 `22db88f0d50558da2cb957950a56d791adae81f1865fc76841c70579f39cae04`. All shipped product files matched the frozen package manifest. Bun 1.3.14; existing compatible node-llama-cpp 3.19.1 dependencies; no install or model download.

Original synthetic foreground corpus and query `Who owns the meadow migration?` retained. CUDA uses original `noRerank:false`; Metal uses original `noRerank:true`. Both use `noExpand:true`, `graph:false`, collection `probe`, limit3 and default model/context budgets/300000ms TTL. MCP receives its supported original schema (no unsupported noExpand field). New background fixture and synthetic write permissions are explicitly pinned.

### Captured acceptance evidence

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

### Scope limits and retained negatives

CUDA revisionsv1–v5 retain every failed run and its actual outputs. Failures came from scratch capture-scope misuse, a redundant pending-phase read, raw MCP caller/session lifecycle mistakes, and waiting for sync embedding to finish before attempting the shutdown case. Corrected scenarios use new run/config identities; no product changes, silent retries, threshold reductions, or omitted raw rows. Revisionv1's stdout/stderr drain produced an object string; its native sidecars/HTTP bodies remain intact and that stdout limitation is explicit.

The exact fn143 response projection removes only `verification.semantic.durationMs` telemetry. No public result, citation, vector flag, fallback or error is harmonized. The earlier scratch adapter contradictory `vectorsUsed:true`/`vectorStatus:unavailable` mapping remains in the failed receipt; corrected mapping preserves the public-reported flag while declaring native coverage separately.

Actual model inputs and outputs compare exactly. Whole capture payloads do not: accumulated model-load inventories differ between cold and resident calls. Full inventories and context events remain recorded; selected model hashes are validated independently. Ask abstention parity with an executed judge is not evidence of a supported generated answer.

The physical tests do not claim a stuck GPU kernel, a forced native kill branch, queue saturation at64, historical original143-query acceptance, or default Metal reranking coverage. Task4's focused noncooperative owned-child tests remain separate. No performance promotion claim is made.

The separate exact signal observer provides additional CUDA MCP notification evidence: successor rerank request22 was native-active when its signal aborted, and that same child/PID/generation/request ended168ms later. This is recorded in `fn146.5-cuda-notification-settlement.json`; it does not overwrite the stale pre-trigger embedding stage's negative retention field.

### Durable artifacts and reproduction

- `.flow/artifacts/fn-146-cancellation-and-bounded-background/final-native-cuda/`
- `.flow/artifacts/fn-146-cancellation-and-bounded-background/final-native-metal/`

Each directory has `SHA256SUMS` and an `inventory.json`: every archived source file has its byte length and SHA256; each archive has its compressed SHA256. Raw evidence is losslessly gzip-compressed with gzip mtime0. No model binaries, SQLite files, or cache payloads are included. CUDA contains all eight revisions/strata; Metal contains the full corrected run and fairness supplement. Original task-cache evidence remains untouched.

CUDA repro after a new GPU grant: regenerate a new configuration with the curated `fn146.5-configure.ts`, retain the separately declared scenarioPhase/backgroundDocumentCount/shutdownDocumentCount from the archived pinned configuration, then run `TMPDIR=/home/gordon/.cache/agent-tmp python3 notes/fn146.5-supervise.py NEW_CONFIG --native`. A used root is rejected. All physical driver revisions/configs and archive identities are retained for exact reproduction; model caches and same-host index preparation remain host-local.

Metal frozen tools root: `/private/tmp/fn1465-tools-f64.u1aa76`. Original commands: `python3 notes/fn146.5-ivan-transport.py --run /private/tmp/fn1465-tools-f64.u1aa76/metal-run.json --native` and the separate `metal-fairness-run.json`. Reproduction requires new roots/configs. Policy remains capacity-warning30-v1: pressure1 start, warning2 cumulative≤30seconds, critical4 immediate stop,6144MiB,120seconds per isolated phase. Both runs observed zero warning seconds and ended at pressure1. Existing SSH master was reused; live Bun/config/index/services were untouched.

Analysis drivers are included. Authoritative detail: `fn146.5-{cuda,metal}-native-summary.json`, `-native-inputs.json.gz`, `-fairness.json`, and `-durable.json`. These preserve the distinctions above and point to the full raw receipts.

stage: impl-review - skipped(config: no formal review requested; host owns acceptance)
## Evidence
- Commits: 24ec121764b7477f0dd5bddce8c023957c630c92, f64c41c97e196e3bffdba23bc1c006bca7489b28, 76743bd616cbe723b0adab87da9f380cad1513ad
- Tests: CPU transport mock, transparent shutdown/dispatch forwarding and actual final-package observer installation passed; notes/fn146.5-final-cpu-preflight.log and final-binding-preflight.json, CUDA eight declared physical revisions/strata retained: v1-v5 incomplete harness revisions; v6 six phases exit0, partial1024 exit0, fairness1024 exit0; inventory.json contains exact commands/exits, Metal original-policy full corrected driver exit0/48.738872s; fairness supplement exit0/40.079785s; pressure1,zero warning seconds, Both platforms: full query+verified Ask idle/background response equality; actual unmodified child model inputs/outputs and selected model hashes exact; generation and semantic judge executed, Both platforms: 12/12 concurrent foreground results exact, queued-background dispatch at8 credits after actual ACK, native batch sizes<=32 totaling1024, CUDA418 committed background owners+670missing; Metal98committed+30missing; all committed rows retained; resumed actual native passage IDs exactly missing once; final coverage no missing/duplicates, Portable gzip mtime0/source byte-length+SHA256+compressedSHA verification PASS: CUDA1242 archived source files,Metal5046, Host independently verified all93checksum targets and6288 archived files with notes/fn146.5-host-verify.py; exit0
- PRs: