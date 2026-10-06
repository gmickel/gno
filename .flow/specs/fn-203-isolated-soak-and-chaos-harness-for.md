# Isolated soak and chaos harness for resident GNO

## Problem

GNO runs for weeks as `gno serve`, `gno daemon`, the desktop app's resident, and many short-lived `gno mcp` / CLI processes, all sharing one index. Field reports show what goes wrong when one of these misbehaves over time: a resident that spun at ~82% of a core for days (fn-202), processes left running for weeks after their parent went away, and status requests that time out while the event loop is busy. Unit and integration tests prove individual contracts in seconds; nothing exercises the whole system for hours under realistic churn, faults and lifecycle abuse, and nothing measures what users feel: idle CPU, wakeups, memory, leftover processes, held locks.

A read-only survey of the code (2026-10-05) found these concrete gaps to target first:

- Session import child (`src/sessions/import-child.ts:96-128`): no timeout, no kill on shutdown, no parent-death signal, so it survives a killed resident.
- Collection `updateCmd` and `git pull` (`src/ingestion/sync.ts:209-239`): no timeout, no abort, not in its own process group.
- Desktop shell (`desktop/electrobun-shell/src/bun/index.ts:318-360`): sends SIGTERM to serve without waiting or escalating, and if the shell is SIGKILLed, serve is orphaned while still holding the owner lock and port.
- Embed scheduler: a pass deferred by the writer lease reschedules every 30 s with no limit, and its timer is not unref'd (`src/serve/embed-scheduler.ts:225, 295, 338-358`).
- Watcher: while the lease is held it retries every 5 s indefinitely (`src/serve/watch-service-run-flush.ts:97-111`).
- No SIGHUP handler anywhere.
- Unbounded growth: `ingest_errors` is never pruned; detached-mode logs are never rotated; expired `llm_cache` rows are only removed by `gno cleanup`.
- `/api/events` has no subscriber cap and ignores backpressure (`src/serve/doc-events.ts:82-134`).
- On macOS, per-file conversion spawns `ps` every 200 ms to sample memory (`src/ingestion/file-processor.ts:221-238`).
- `tags.ts` takes its own O_EXCL lock with no stale-lock recovery (`src/cli/commands/tags.ts:84-124`).
- fn-202 follow-ups: `SOURCE_AVAILABILITY_UNSUPPORTED` is still retried (now with backoff) although retrying cannot fix a config problem, and status does not surface it as a config error.

Field observation on thor (2026-10-06): five stdio `gno mcp` servers were running under live Claude Code and Codex sessions, the oldest for 12 days. None were orphans. Each used 3-10 CPU-minutes over 3-12 days and about 10 MB RSS. This shape (long-lived, mostly idle MCP children of agent sessions) is the common one in practice and needs its own idle budget.

## Approach

Build a standalone harness under `scripts/soak/` (Bun/TypeScript, run with `bun run soak`). It starts real GNO processes in a sealed sandbox, drives them with seeded actors and a fault schedule, samples every process continuously, and checks a fixed set of invariants. It writes a JSON and Markdown report with a replay seed. It is not part of `bun test`; a short tier can later become a CI job.

### Sandbox and process accounting

- Each run gets a temp root with its own `HOME`, `XDG_*`, `GNO_CONFIG_DIR`, `GNO_DATA_DIR` and `GNO_CACHE_DIR`. It sets `GNO_OFFLINE=1` / `HF_HUB_OFFLINE=1` and binds to loopback only. It never reads the user's config, collections or models; the optional real-model tier copies a cached GGUF into the sandbox cache.
- Every process the harness starts carries a `GNO_SOAK_RUN=<id>` environment marker, and children inherit it. Orphan detection scans `/proc/*/environ` (Linux) or `ps -E` (macOS) for that marker, so a leftover process is found whatever its parent or process group.
- On Linux the whole run can additionally be wrapped in `systemd-run --user --scope` (CPU and memory accounting plus a hard cap) or `unshare --pid --fork --kill-child`, so a harness crash cannot leave anything behind.
- Teardown kills every marked process, reports each one as a violation, and verifies the sandbox locks are free.

### Embedding and models

- Default: a loopback fake OpenAI-compatible embedding server (the pattern used by `test/cli/index-resume.test.ts`) with controllable latency, error rate, hangs, malformed responses and crashes. This makes faults deterministic and keeps runs cheap.
- Optional `--real-model` tier: the native node-llama-cpp worker with the cached Qwen3 embedding GGUF, to exercise the model process, its idle unload, its deadlines and its death.

### Corpus

A seeded generator builds Markdown notes with wiki links, plus PDF, DOCX, XLSX and PPTX from existing fixtures and `scripts/generate-large-workbook.ts`. It adds pathological entries:

- unreadable files and huge files
- binary files with text extensions, deep trees, unicode and very long names
- symlink loops, and files rewritten while they are being read
- collections with `sourceAvailability: local` on unsupported paths
- empty and missing collection roots

Sizes: small (300 docs), medium (10k), large (50k).

### Actors

Actors run concurrently; each mix is chosen by seed.

- **File-system churn:** steady trickle, bursts (1k files in 1 s), editor atomic saves, renames, directory moves and deletes, and permission flips (readable to unreadable and back).
- **Readers:** REST search/query/get/ask at a configurable QPS, and web UI SSE subscribers that connect, idle and disconnect, including abandoned connections.
- **MCP:** many short-lived stdio `gno mcp` processes (spawn, call a tool, exit, or get killed mid-call), stdio servers kept open for the whole run with sparse calls (the agent-session shape), parents that die without closing stdin, and HTTP MCP sessions that never close.
- **CLI writers:** `gno update`, `index`, `embed`, `tags` and `capture` running against the resident, so the writer lease is contended.
- **Config and lifecycle:** collection add/remove, config edits, model preset change, and session archive import with automation profiles on.

### Faults and lifecycle chaos

- SIGTERM, SIGINT, SIGHUP and SIGKILL at random moments: mid-sync, mid-embed, mid-model-load, mid-conversion, mid-import. They target the resident, the native model worker, the file-processor child and the lock-holder processes.
- `--detach`, `--stop` and `--status` cycles; double start; stale pid, startlock and owner-lock files; a foreign process on the port.
- A desktop-shell stand-in that spawns serve the way the shell does and is then SIGKILLed.
- Laptop sleep: SIGSTOP the resident for minutes, then SIGCONT, and jump the clock where possible. This exercises timers, deadlines and leases that expire while suspended.
- Disk pressure: the data dir on a small tmpfs or loop device that fills up; a read-only DB file; ENOSPC during a WAL checkpoint.
- Embedding server faults (above), and the network denied outright.

### Invariants

Sampled every second per process; each violation is recorded with a snapshot.

1. **Idle settles.** After a quiet window (no actor activity for 2 min and convergence reached), the resident's process tree averages under 1% CPU over 60 s. It also makes no SQLite writes (WAL size and `ingest_errors` count stay flat), spawns no new processes, and keeps wakeups under a set budget (context switches on Linux). This is the battery invariant.
2. **No orphans or zombies.** After every stop, kill and teardown, no process with the run marker remains and no zombie child is left under a live GNO process. After a parent SIGKILL, every child exits within its documented bound (lock holder: immediately; model worker: ~1 s; file child: one step).
3. **Locks and files released.** After a stop, `.mcp-write.lock` and `.resident-owner.lock` can be taken with no wait, pid, startlock and holder sidecar files are gone, and the port is free. A stale leftover is recovered on the next start.
4. **Responsiveness.** `/api/resident/status` p99 stays under 250 ms (target, tunable) the whole run, including during large indexing passes and model loads. No request exceeds the 8 s timeout seen in the field.
5. **Shutdown bound.** SIGTERM in any state exits within the shutdown budget (drain 5 s + abort 5 s + 1 s); `--stop` escalation is never needed against a healthy process.
6. **Bounded resources.** Over a multi-hour soak, RSS, fd count, thread count, child count, timer count, SSE subscriber count and HTTP session count have no upward slope. Growth of `ingest_errors`, `llm_cache`, retrieval traces and log files stays within declared budgets.
7. **Retries are bounded.** For each fault class, retries back off or park within a declared schedule. The harness counts attempts from logs, `ingest_errors` and status, and fails on a fixed-rate loop.
8. **Convergence.** Once churn stops and faults clear, within T the index matches a ground-truth walk of the corpus (document set and content hashes). Search finds the latest marker in every edited file, the embedding backlog is 0, `nextRunAt` is null, and status shows no stuck job.
9. **No data loss under kill.** After a SIGKILL at any point, a restart converges (invariant 8) without a manual `gno doctor` repair, and SQLite integrity checks pass.

### Tiers

| Tier | Duration | Embeddings | Purpose |
| --- | --- | --- | --- |
| `smoke` | ~5 min | fake | Lifecycle cycle, idle settle, convergence, orphan scan. Candidate CI job (Linux). |
| `torture` | ~30 min | fake | Each fault class in isolation, with a pass/fail per class. |
| `soak` | 4-24 h | fake or real | Random actor mix plus a fault schedule from a seed. Nightly on a spare machine (thor). |
| `platform` | varies | fake | The same smoke and torture on macOS and Windows. macOS File Provider behaviour can only be checked on a Mac with a real cloud folder, so it is reported as manual. |

### Report

The report is `report.json` plus `report.md` in the run directory. It contains the seed and exact versions, a pass/fail per invariant, and a timeline of actor phases and faults.

For each violation it records the time, the scenario step, the process tree, `/api/resident/status`, the embed and watcher status, and the tail of `GNO_PHASE_TRACE` and the logs. It also adds a CPU profile or stack sample of the offender: `bun --cpu-prof` when the resident is started under the harness, otherwise `/proc/<pid>/stack` or `sample` on macOS.

`bun run soak --replay <report.json>` re-runs the same seed and schedule.

## Acceptance Criteria

- **R1:** `bun run soak --tier smoke|torture|soak --seed <n> --duration <d>` runs fully sandboxed. It touches nothing outside its temp root and never contacts the network, and a run on a machine with a live user GNO leaves that GNO untouched.
- **R2:** Every spawned process is tagged and accounted for. A process left at teardown is reported as a violation and then killed. The harness itself can be SIGKILLed without leaving GNO processes behind (Linux scope or PID namespace; best-effort sweep on macOS).
- **R3:** Invariants 1-9 are implemented as independent checks, with thresholds in one config block and pass/fail reported per invariant.
- **R4:** Actors and faults are seeded and replayable from the report.
- **R5:** Every gap in the Problem section is reachable by at least one torture scenario, so the first runs either prove it harmless or produce a finding.
- **R6:** The smoke tier finishes in under 10 minutes on a Linux CI runner and passes on a healthy build. Wiring it into CI is a separate decision.
- **R7:** Findings are filed as bug memory and specs; the harness never lowers a threshold to make a run pass.

## Boundaries

- This spec designs and builds the harness. Fixing what it finds is follow-up specs, one per root cause.
- No changes to GNO runtime code except test seams the harness needs (for example an env var to start the resident with `--cpu-prof`), each justified in its task.
- Not a replacement for the unit, watcher and resident suites or the memory and sessions eval gates.
- macOS File Provider and Windows ACL paths are covered only on real hardware.

## Open decisions

- Whether the smoke tier becomes a required CI check, and on which runner.
- The idle CPU and wakeup thresholds, to be set from a baseline run on a healthy build rather than guessed.
