# Resident crash on an old Bun, and MCP registrations pinned to a versioned Bun

## Goal & Context
<!-- scope: business; source: user -->

A detached `gno serve` on a macOS host (GNO 2.9.0, started with `--detach`) crashed after about 7 days of uptime. Its `serve.log` ends with 28 lines of `TypeError: Unable to deserialize data.` followed by a Bun panic: `Segmentation fault at address 0x7000610020005F`, Bun v1.3.11 (af24e281), with a macOS crash report written at the same minute. Nothing restarted it, so search fell back to stdio MCP servers and the index stopped embedding for about 15 hours (1,880 pending or stale embeddings at restart). [user]

The crash summary Bun printed: elapsed 606,858 s, peak RSS 0.78 GB, `workers_spawned(160) workers_terminated(159)`, `spawn(1503)`, `yaml_parse(302647)`. The YAML count matches the per-request config re-parse that 2.9.2 removed. [paraphrase]

The host's PATH Bun had since been upgraded to 1.4.2, but the resident kept the 1.3.11 binary it started with. Bun 1.4.1 and later include oven-sh/bun#40272 (the structured-clone deserializer did not keep pooled strings alive for the GC, so a deserialized message could reference a freed cell) and 1.4.0 and later include oven-sh/bun#32796 (serializer and deserializer reference pools out of sync). Both are in the code path a worker `postMessage` uses and fit the symptoms, but neither has been shown to be this crash. [paraphrase]

While checking which Bun each GNO process uses, a second problem appeared. On the two hosts where Bun is managed by mise, every MCP registration written by `gno mcp install` (Claude Code, Codex, both Claude Desktop instances) names `~/.local/share/mise/installs/bun/1.3.14/bin/bun` as the command, although the machines' Bun is 1.4.2. `install` stores `process.execPath`, which for any version manager is a versioned directory, so a Bun upgrade never reaches the registrations: they keep starting the old runtime until that version is uninstalled, and then they fail to start. On the third host Bun lives at `~/.bun/bin/bun` (upgraded in place), so its registrations followed the upgrade. Nothing in GNO assumes mise; the pin is whatever path the installing Bun resolved to. The registrations were repointed by hand to mise's `latest` alias as a stopgap. [user]

## Acceptance Criteria
<!-- scope: both -->

- **R1:** [paraphrase] A message that fails to deserialize between the main thread and the file processor (worker or child backend) is handled as a processor failure: the current file fails with a recorded error code, the processor is replaced, and the run continues. Today there is no `messageerror` handler, so the failure only surfaces as a bare `TypeError` line in the log.
- **R2:** [paraphrase] That failure is logged once with context: direction (job or result), backend, collection-relative path of the file and the phase, so the next occurrence can be tied to an input.
- **R3:** [inferred] GNO declares and checks a minimum Bun that includes the structured-clone fixes above (1.4.1 or later, or a later floor if testing points there). `engines.bun` reflects it (today `>=1.3.0` while development runs 1.4.2), and starting `serve`, `daemon` or `mcp` on an older Bun prints a one-line warning naming the running version and the floor.
- **R4:** [paraphrase] `gno mcp install` does not write a version-manager install directory as the command. When `process.execPath` sits inside a versioned directory (mise or asdf `installs/bun/<version>`, Homebrew `Cellar/bun/<version>`, proto, and similar), it writes a stable path that follows upgrades of the same manager (for example the manager's alias or shim, or the unversioned Homebrew link), or another stable choice the implementation settles on. GUI hosts such as Claude Desktop must keep working, so the command stays an absolute path that does not rely on the host's PATH.
- **R5:** [paraphrase] `gno doctor` (and the connector checks in `gno status`) report a registration whose interpreter is missing, is a different Bun than the one running the check, or is below the floor in R3, naming the file and the target, with the command that repairs it.
- **R6:** [inferred] Re-running `gno mcp install` for a target that already has a GNO entry updates its command in place and keeps the rest of the entry (tool profile, write flags, environment, config path).
- **R7:** [user] Nothing changes for callers that run the `gno` launcher (`#!/usr/bin/env bun`) from PATH or from a configured path, such as the Omarchy GNO Recall plugin, which resolves `gno` from PATH and never pins Bun.

## Boundaries
<!-- scope: business -->

- [inferred] No new supervisor: restarting a crashed resident stays the operator's or the service manager's job. Status already reports a dead resident; fn-212 covers the status stall seen right after the restart.
- [inferred] No attempt to work around Bun's deserializer beyond R1 and R2; the runtime floor is the fix if a Bun bug is confirmed.

## Decision Context

Same family as the unattended-operation hang inventory in fn-180 (closed): long-running GNO processes must be bounded, observable and recoverable. Here the process died instead of hanging, the log could not say which file or message triggered it, and the runtime it ran on was older than the one installed. [paraphrase]

## Resolved via Codebase

- File processor and worker messaging: `src/ingestion/file-processor.ts` (`startWorker`, `startChild` with `serialization: "advanced"`), `src/ingestion/prepare-worker.ts`. Each job posts a `SharedArrayBuffer`-backed phase slot; there is no `onmessageerror`.
- MCP interpreter choice: `src/cli/commands/mcp/paths.ts` (`findBunPath` returns `process.execPath`), used by `src/cli/commands/mcp/install.ts`.
- Bun version is already surfaced in `src/serve/status.ts` and the embedding identity.
- Related: fn-180-investigate-detached-serve-hot-loop-raw (closed), fn-212-status-stalls-briefly-after-a-crash (open).
