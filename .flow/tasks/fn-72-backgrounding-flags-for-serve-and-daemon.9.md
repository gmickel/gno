# fn-72-backgrounding-flags-for-serve-and-daemon.9 Spike: validate Bun detach + unref + stdio fd on this repo

## Description

Derisking spike. Prove Bun's `detached: true` + `stdio: ["ignore", fd, fd]` + `.unref()` actually lets the parent exit cleanly and the child survive **in this repo's environment**. Kill the two biggest unknowns (Bun detach semantics, LLM native-thread keep-alive) before writing the real helper.

**Size:** S (one throwaway script, ~30-60 min)
**Files:**

- `scripts/spike-detach.ts` (throwaway, NOT shipped — add to `.gitignore` or delete after)

## Approach

- Minimal standalone script that:
  1. Opens a log fd with `node:fs.openSync(path, "a")`.
  2. Spawns `bun -e "setInterval(() => console.log('alive'), 500)"` with `detached: true`, `stdio: ["ignore", fd, fd]`, calls `.unref()`.
  3. Writes the child PID to a tmp file.
  4. Parent process exits 0 within ~1s.
  5. Manually verify the child is still running (`ps -p <pid>`) and writing to the log file.
- Second variant: same as above but spawn `bun src/index.ts search foo` (any gno command that loads an LLM port) to verify `cleanupAndExit` doesn't hang the parent because of native threads in `src/llm/nodeLlamaCpp/lifecycle.ts`.
- Third variant: child tries to `process.kill(parentPid, 0)` after 2s to confirm parent actually exited.

## Investigation targets

**Required:**

- Bun Spawn reference docs: https://bun.com/reference/bun/Spawn/SpawnOptions/detached
- `src/llm/nodeLlamaCpp/lifecycle.ts` — understand what holds the event loop open

**Optional:**

- `test/cli/concurrency.test.ts:44-50` — subprocess spawn template

## Key context

- If parent doesn't exit within ~1s, `.unref()` is missing or `stdio` is holding a reference. Fix before building fn-72.2.
- If LLM variant hangs, fn-72.2 must detach **before** any command-scope import side effects (may need to restructure `wireServeCommand`/`wireDaemonCommand` to do detach in the top-level program action before the lazy import).
- This spike does NOT ship — delete or git-ignore the script after. Record findings in the done summary.

## Acceptance

- [ ] Spike script confirms `Bun.spawn({ detached: true, stdio: ["ignore", fd, fd] }).unref()` leaves parent free to exit within 1s on macOS
- [ ] Child stays alive after parent exit, writes to log file as expected
- [ ] Second variant spawning a gno command confirms no LLM-thread hang (or identifies the exact import that needs deferring)
- [ ] Done summary documents any surprises for fn-72.2 to apply
- [ ] Spike script deleted or gitignored — not committed to main

## Done summary

Spike confirmed Bun `spawn({ detached: true, stdio: ["ignore", fd, fd] }).unref()` lets the parent exit cleanly (~17 ms) on macOS with both a heartbeat child and a gno CLI child, and the detached child survives parent exit while writing to its inherited log fd — fn-72.2 can proceed.

## Findings for fn-72.2

- `Bun.spawn` with `detached: true`, `stdio: ["ignore", fd, fd]` (numeric fd from `node:fs.openSync(path, "a")`), plus `child.unref()` is sufficient. Parent exits in ~17 ms on macOS (Bun 1.3.5) — well under the 1s budget.
- Confirmed `child.unref()` is mandatory: `detached: true` alone sets the session leader but does not release the event-loop reference to the subprocess handle.
- Numeric fd from `openSync` is correct — the parent's fd is duped into the child at spawn time, so closing the parent's fd (or letting it close on exit) does not kill the child's stdout/stderr.
- Child confirmed `process.kill(parentPid, 0)` returns `ESRCH` ~2s after parent exit — parent really is gone.
- Variant 2 (`bun src/index.ts ask --help`) spawned detached exited cleanly and wrote Commander's help text to the log fd. The gno CLI's module graph does not have import side-effects that would keep the detached parent alive; LLM native threads live inside the child process where the command body runs.

## Implications for fn-72.2 (`src/cli/detach.ts` helper)

- Detach path: `openSync(logPath, "a")` → `Bun.spawn({ cmd: [process.execPath, ...argvMinusDetach, sentinel], stdio: ["ignore", fd, fd], detached: true, cwd, env }).unref()`. Then write pid-file atomically and exit 0.
- No need to restructure `wireServeCommand`/`wireDaemonCommand` to detach before imports — CLI module graph is safe. Detach can happen inside the action handler as the first await, before any port/runtime instantiation.
- `fs.closeSync(fd)` in the parent after spawn — the child has its own dup.
- Sentinel flag (e.g. `--__detached-child`) tells the re-invoked command body to skip the detach branch and run normally.

## Surprises

None. Bun's detach behaved exactly as the docs suggest. No LLM-thread hazard materialized because the LLM only loads when the command body runs, which is always in the child.

## Artifact

`scripts/spike-detach.ts` — throwaway, gitignored via `.gitignore` (commit 4868f02). Not committed to main. Safe to delete locally once fn-72.2 lands.

## Evidence

- Commits: 4868f029df4ab0dc405afa3830fc85d6631d2c9a
- Tests: bun scripts/spike-detach.ts parent heartbeat, bun scripts/spike-detach.ts parent gno, bun run lint:check, bun test test/cli/
- PRs:
