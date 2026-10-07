# Resident crash on an old Bun, and MCP registrations pinned to a versioned Bun

## Goal & Context
<!-- scope: business; source: user -->

A detached `gno serve` on a macOS host (GNO 2.9.0, started with `--detach`) crashed after about 7 days of uptime. Its `serve.log` ends with 28 lines of `TypeError: Unable to deserialize data.` followed by a Bun panic: `Segmentation fault at address 0x7000610020005F`, Bun v1.3.11 (af24e281), with a macOS crash report written at the same minute. Nothing restarted it, so search fell back to stdio MCP servers and the index stopped embedding for about 15 hours (1,880 pending or stale embeddings at restart). [user]

The crash summary Bun printed: elapsed 606,858 s, peak RSS 0.78 GB, `workers_spawned(160) workers_terminated(159)`, `spawn(1503)`, `yaml_parse(302647)`. The YAML count matches the per-request config re-parse that 2.9.2 removed. [paraphrase]

The host's PATH Bun had since been upgraded to 1.4.2, but the resident kept the 1.3.11 binary it started with. Bun 1.4.1 and later include oven-sh/bun#40272 (the structured-clone deserializer did not keep pooled strings alive for the GC, so a deserialized message could reference a freed cell) and 1.4.0 and later include oven-sh/bun#32796 (serializer and deserializer reference pools out of sync). Both are in the code path a worker `postMessage` uses and fit the symptoms, but neither has been shown to be this crash. [paraphrase]

The process died of a native segfault after the deserialize errors. Handling those errors in GNO (R1, R2) makes the failure visible and recoverable, but it cannot prevent a crash inside Bun; the runtime floor (R3) and the resident-runtime check (R8) are the primary mitigation. [inferred]

While checking which Bun each GNO process uses, a second problem appeared. On the two hosts where Bun is managed by mise, every MCP registration written by `gno mcp install` (Claude Code, Codex, both Claude Desktop instances) names `~/.local/share/mise/installs/bun/1.3.14/bin/bun` as the command, although the machines' Bun is 1.4.2. `install` stores `process.execPath`, which for any version manager is a versioned directory, so a Bun upgrade never reaches the registrations: they keep starting the old runtime until that version is uninstalled, and then they fail to start. On the third host Bun lives at `~/.bun/bin/bun` (upgraded in place), so its registrations followed the upgrade. Nothing in GNO assumes mise; the pin is whatever path the installing Bun resolved to. The registrations were repointed by hand to mise's `latest` alias as a stopgap. [user]

## Acceptance Criteria
<!-- scope: both -->

- **R1:** [paraphrase] A message that fails to deserialize between the main thread and the file processor (worker or child backend) is handled as a processor failure: the current file fails with a recorded error code, the processor is replaced, and the run continues. Today there is no `messageerror` handler, so the failure only surfaces as a bare `TypeError` line in the log. [inferred] First establish how Bun surfaces a deserialize failure on each backend (a `messageerror` event on `Worker`, an error on the IPC child channel, or a throw in the receiving context) and handle it where it actually arrives; the requirement is the outcome above, not a particular event.
- **R2:** [paraphrase] That failure is logged once with context: direction (job or result), backend, collection-relative path of the file and the phase, so the next occurrence can be tied to an input.
- **R3:** [inferred] GNO declares and checks a minimum Bun that includes the structured-clone fixes above (1.4.1 or later, or a later floor if testing points there). `engines.bun` reflects it (today `>=1.3.0` while development runs 1.4.2), and starting `serve`, `daemon` or `mcp` on an older Bun prints a one-line warning naming the running version and the floor; it warns, never refuses to start. The floor's consequences are part of the change: the CI jobs that pin an older Bun (the Watcher matrix runs 1.3.11) either move to the floor or are kept deliberately to cover the warning path, and the Bun bundled with the desktop app is at or above the floor.
- **R4:** [paraphrase] `gno mcp install` does not write a version-manager install directory as the command. When `process.execPath` sits inside a versioned directory (mise or asdf `installs/bun/<version>`, Homebrew `Cellar/bun/<version>`, proto, and similar), it writes a stable path that follows upgrades of the same manager (for example the manager's alias or shim, or the unversioned Homebrew link), or another stable choice the implementation settles on. GUI hosts such as Claude Desktop must keep working, so the command stays an absolute path that does not rely on the host's PATH. [inferred] Specifically:
  - Shims that need the manager's shell environment to pick a version (asdf, proto, mise shims) do not qualify, because GUI hosts do not load that environment; prefer the manager's absolute version-independent link (mise `installs/bun/latest`, `/opt/homebrew/bin/bun` or `/usr/local/bin/bun` for Homebrew).
  - When no stable absolute path exists, keep `process.execPath` and say so in the install output; R5 then reports the pin.
  - The same applies to the entrypoint argument (`run <entrypoint>`): if GNO itself is installed under a versioned directory, prefer a version-independent path to it. A replacement is used only if it exists and resolves (after following links) to the same installed GNO package the install is running from; otherwise keep the working entrypoint, say so in the install output, and let R5 report it. Creating new links, shims or wrapper scripts to manufacture a stable path is out of scope.
  - A standalone compiled executable (the desktop app) is never rewritten: its `process.execPath` is GNO itself, not Bun.
- **R5:** [paraphrase] `gno doctor` (and the connector checks in `gno status`) report a registration whose interpreter is missing or below the floor in R3 as an error, and one whose interpreter resolves (after following links) to a different Bun than the one running the check as information, naming the file and the target, with the command that repairs it. A registration pointing at a version-independent link that resolves to the running Bun is healthy. [inferred] An interpreter's version comes from its path or from `<interpreter> --version` under a short timeout; the check never starts the registered MCP command, and a probe that times out or fails reports the version as unknown rather than failing the whole check. The same applies to the entrypoint: a missing entrypoint is an error.
- **R6:** [inferred] Repairing a registration keeps the rest of the entry. `gno mcp install` without `--force` still refuses when an entry exists (today's behavior). With `--force` it updates the entry in place instead of replacing it wholesale:
  - The launch path (the interpreter and the `run <entrypoint>` prefix of `args`) is always rewritten per R4.
  - Every other setting in the existing entry (remaining arguments such as tool profile and write flags, environment such as the index, config, data and cache locations, and any keys GNO does not write itself) is kept unless the user passed the corresponding option explicitly in this invocation; an explicit option overrides its value (so `--force --tool-profile core` still changes the profile, as today's tests require). Defaults that `installMcp` fills in for omitted options never override existing values, which means the option source has to survive past the CLI adapter to the point where defaults are applied.
  - Preservation holds for every config format GNO writes: JSON/JSONC, YAML and TOML. The TOML writer today emits only the command, args and two environment keys for the GNO section, so other keys in that section must be carried over.
  - The repair command R5 prints is this `--force` form with no other options. [decision: `--force` merges; overrule before implementation if a separate repair command is preferred]
- **R7:** [user] Nothing changes for callers that run the `gno` launcher (`#!/usr/bin/env bun`) from PATH or from a configured path, such as the Omarchy GNO Recall plugin, which resolves `gno` from PATH and never pins Bun.
- **R8:** [inferred] `gno status` and `gno doctor` flag a running resident (`serve` or `daemon`) whose Bun is below the floor or older than the Bun that would start it now, with the command to restart it. The crash host ran 2.9.0 on Bun 1.3.11 for days after PATH had moved to 1.4.2, and nothing said so. This has to work for residents started by an older GNO, not only for ones started after this change:
  - Today a pid file written by a different GNO version is reported as not running and is never queried. A live process whose pid file names the expected command and a port but a different GNO version is instead reported as a resident of that version, and its runtime is read from the existing `/api/status` field `bootstrap.runtime.currentVersion` on that port, with a short timeout. The response must identify itself as GNO before its runtime is trusted; when the probe fails or the field is missing, the runtime is reported as unknown.
  - The existing process-identity protections stay as they are: a resident with an unconfirmed identity is never signalled, and status reporting never changes `running` semantics for the commands that act on it (`--stop`, `--detach` collision checks) unless the identity check passes.
  - The guidance names a command that works for that resident. If the current `--stop` refuses a foreign-version resident, either it learns to stop one whose identity is confirmed (same command, live PID, port answering as GNO), or the guidance gives the PID and the manual stop; the implementation picks one and documents it.
  - New residents record their Bun version in the pid file so the check does not depend on the HTTP probe.

## Verification
<!-- scope: technical -->

- [inferred] R1 and R2 start with a reproduction, not a handler: a test that forces a deserialize failure on each backend (worker and child) in both directions (job to processor, result to main), and records where Bun delivers it. Handlers are written against that observed delivery. The test then checks the outcome: the file fails with a recorded code, the processor is replaced, the next file succeeds, and exactly one log line carries direction, backend, path and phase. If a direction cannot be forced on a backend, that is recorded in the spec as a negative result, not skipped silently.
- [inferred] R3: the warning appears on `serve`, `daemon` and `mcp` under a Bun below the floor and not at or above it; startup continues either way; `engines.bun` and the CI matrix match the chosen floor.
- [inferred] R4: path resolution is covered for mise, asdf, Homebrew (Apple Silicon and Intel prefixes), proto, an in-place `~/.bun/bin/bun`, and the compiled desktop executable, including the fallback when no stable path exists, using temporary directory layouts rather than real installs.
- [inferred] R5: registrations whose interpreter or entrypoint is missing, below the floor, different from the running Bun, or a healthy version-independent link, in each config format; a hanging `--version` probe stays within its timeout.
- [inferred] R6: `--force` repairs in JSON/JSONC, YAML and TOML keep tool profile, write flag, environment and unrelated keys, and an explicit option still overrides its value. Existing filesystem and permission safeguards in the config writers stay in force.
- [inferred] R7: the `gno` launcher from PATH runs unchanged; connector execution policy is not altered.
- [inferred] R8: a live resident with a pid file from another GNO version is reported with its Bun version (probe answers), as unknown (probe fails or field missing), and is never signalled without identity confirmation; a stale pid file is still reported as not running.

## Boundaries
<!-- scope: business -->

- [inferred] No new supervisor: restarting a crashed resident stays the operator's or the service manager's job. Status already reports a dead resident; fn-212 covers the status stall seen right after the restart.
- [inferred] No attempt to work around Bun's deserializer beyond R1 and R2; the runtime floor is the fix if a Bun bug is confirmed.
- [inferred] The floor warns; it does not block `serve`, `daemon`, `mcp` or any CLI command.

## Decision Context

Same family as the unattended-operation hang inventory in fn-180 (closed): long-running GNO processes must be bounded, observable and recoverable. Here the process died instead of hanging, the log could not say which file or message triggered it, and the runtime it ran on was older than the one installed. [paraphrase]

R6 keeps today's refuse-without-`--force` behavior so a plain re-run never silently rewrites a user's entry; `--force` changes from replace to merge so a repair cannot drop a tool profile, write flags or environment. [inferred]

## Resolved via Codebase

- File processor and worker messaging: `src/ingestion/file-processor.ts` (`startWorker`, `startChild` with `serialization: "advanced"`), `src/ingestion/prepare-worker.ts`. Each job posts a `SharedArrayBuffer`-backed phase slot; there is no `onmessageerror`.
- MCP interpreter choice: `src/cli/commands/mcp/paths.ts` (`findBunPath` returns `process.execPath`, `buildMcpServerEntry` writes it with `run <entrypoint>`), used by `src/cli/commands/mcp/install.ts` (refuses an existing entry unless `--force`, which overwrites it).
- `engines.bun` is `>=1.3.0` in `package.json`; CI's Watcher matrix runs Bun 1.3.11.
- Bun version is already surfaced in `src/serve/status.ts` and the embedding identity.
- Related: fn-180-investigate-detached-serve-hot-loop-raw (closed), fn-212-status-stalls-briefly-after-a-crash (open).
