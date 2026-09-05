# Metal lifecycle native observations

Actual `scripts/retrieval-acceptance.ts --config ... --native` runs on Ivan; Bun 1.3.14, identical archived product commit 270c3a74f4f7a3aeb8a60462b4c8e1b4adf45462. Independent SQLite backup per run/side; manifests pin checkpointed hashes, full requests, TTL and declared primer/background case IDs. Source archive verification executed by command. All synthetic-corpus data, no live configuration or index changes.

All three reports are **inconclusive**, with one paired block per case/state (<30). All 14 samples error-free; five comparison blocks pass deterministic equality. No speedup or production-readiness claim. Embedding-only native Metal; noRerank=true, noExpand=true, graph=false.

| Run | Evidence |
|---|---|
| warm | Repeated query, novel query after distinct primer, and two owned-session overlap. All six samples complete. Foreground/background overlap: baseline 67.045041 ms, candidate 64.096792 ms. This is two-session contention, not resident scheduler fairness. |
| cold-default | Fresh-process and resident-model-cold observed modelStateBefore=false; post-idle2500ms with default TTL300000ms observed true. All six samples complete. |
| ttl1200 | Explicit TTL1200ms, idle2500ms: both models observed unloaded; subsequent SDK query reacquires and succeeds with native embedding input/output receipts. Both samples complete. |

## Explicit TTL observation

| Side | RSS before idle bytes | RSS after idle bytes | Next query including reacquisition ms |
|---|---:|---:|---:|
| candidate | 976404480 | 364756992 | 661.993417 |
| baseline | 900972544 | 288899072 | 577.493334 |

This successful retained SDK-client path does not supersede the earlier disposed low-level port failure. No product fix was made. Keep that failure failed/incomplete in its original evidence. The observed next-query wall time includes reacquisition; no isolated reload-time subtraction.

## Bounds and retained files

Watchdogs: 480s warm, 480s cold-default, 240s ttl1200; owned-process-group RSS cap6144MiB; macOS pressure level1 required. All finish without timeout/RSS/pressure stop; process exits1 because report status is inconclusive. Peak owned-group RSS KiB: warm2387552, cold-default1285376, ttl12001424064. Swap3063.12MiB unchanged in terminal receipts; not an isolated host. GPU bytes unavailable/sampleGpu=false; never sum RSS and GPU counters.

`completed/`: 370 files including 66 lossless raw `*.reply.json.gz` files. Three report.json, three run.json, six config.json, six manifest.json, three initial-index-hashes.json, three watchdog command.receipt.json plus stdout/stderr, session bootstraps/readiness/logs, independent synthetic indexes. `prepared/` retains pre-execution snapshots. `summary.json` retains per-sample stages, state, errors, overlap and before/after idle resources. `completed.sha256` pins every completed file.

Remote enclosing root: `/private/tmp/fn143-control-metal-01/lifecycle-qa`. GPU slot released after final command. No tracked edits, Git/Flow operations, production mutations, default changes, or model downloads.
