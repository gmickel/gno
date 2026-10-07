---
satisfies: [R1, R2, R3, R4, R5, R6, R7, R8]
---
# fn-213-resident-crash-on-old-bun-and-mcp.1 Implement Resident crash on an old Bun, and MCP registrations pinned to a versioned Bun

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Implemented fn-213 R1–R8.

- R1/R2: a message the file processor cannot deserialize fails the file with PROCESSOR_MESSAGE_FAILED, replaces the processor, and logs one line (direction, backend, collection/path, phase). Worker: `messageerror` on both sides (Bun 1.4.0+; listener inside the worker). Child: Bun closes the IPC channel on both ends, so a clean child exit while not stopping is reported with direction `unknown`. Real malformed IPC frames tested on the child backend; the worker path cannot be forced from JS (negative result in the spec), so tests dispatch the real event.
- R3: `engines.bun` is `>=1.4.1`; `serve`, `daemon` and `mcp` warn once on an older Bun and keep running; status reports the range from package.json; the CI watcher matrix runs the floor; the desktop app bundles Bun 1.4.2.
- R4: `gno mcp install` (and the Claude Code session hook) writes a version manager's version-independent link (mise `installs/bun/latest`, Homebrew `opt/bun`) when it resolves to the running Bun or GNO package; otherwise the versioned path stays and the output (and `installed.pinnedPaths`) says so. Compiled executables are left alone.
- R5/R8: `gno doctor` (`mcp-runtime`, `resident-runtime`) and `gno status` (`runtimeIssues`, `Bun runtime:`) report registrations whose Bun or entrypoint is missing or below the floor (error) or on another Bun (info), and residents below the floor (error) or older than the current Bun (warn), including residents from another GNO version, read via `/api/status` and never signalled. New pid-files record `bun_version`.
- R6: `--force` over an existing GNO entry rewrites only the launch path and keeps arguments, environment and unknown keys in JSON/JSONC, YAML and TOML; only explicitly passed options override (CLI passes `--index` only when its source is the command line).
- R7: the `gno` launcher is unchanged (verified by running `./src/index.ts`).

Live checks (sandboxed HOME and GNO dirs): warnings on Bun 1.3.11 for serve/daemon/mcp; install writes mise `latest`; `--force` keeps the profile, write flag and a user `timeout`; doctor and status flag a 1.3.14-pinned registration and a 2.9.0-labelled resident on Bun 1.3.11 without signalling it; the printed `kill <pid>` stops it.

stage: impl-review - skipped(config: review.backend=none; repository rule skips review stages)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 9d75f59536757ad511d1685a688e4c03c83d8b03, 3bf26f29b5998cfde7c7f3b721756bf95b98dd24, 0771d7700daef132e73e12f2b3b0ce6284eacd43, 95fa50415f80b5428fbd687d2449adedc3cb1a26, 5bd8b82d140770fe634f8a6cb8ebe0a2d104f1ad, c9c4e44ce212fd8c55f28cc8e93e2714122f2c0a
- Tests: bun run lint:check && bun test, bun test test/ingestion/file-processor-undeliverable.test.ts test/app/bun-runtime.test.ts test/cli/mcp-install-repair.test.ts test/cli/runtime-health.test.ts test/egress/
- PRs: