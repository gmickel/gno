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

Spike confirmed Bun `spawn({ detached: true, stdio: ["ignore", fd, fd] }).unref()` lets the parent exit cleanly (~17 ms) on macOS with a heartbeat child, and the detached child survives parent exit while writing to its inherited log fd. **The LLM-thread hazard was NOT retired by this spike** (see below) — fn-72.2 must still treat it as an open risk.

## Findings for fn-72.2

- `Bun.spawn` with `detached: true`, `stdio: ["ignore", fd, fd]` (numeric fd from `node:fs.openSync(path, "a")`), plus `child.unref()` is sufficient for a trivial child. Parent exits in ~17 ms on macOS (Bun 1.3.5) — well under the 1s budget.
- Confirmed `child.unref()` is mandatory: `detached: true` alone sets the session leader but does not release the event-loop reference to the subprocess handle.
- Numeric fd from `openSync` is correct — the parent's fd is duped into the child at spawn time, so closing the parent's fd (or letting it close on exit) does not kill the child's stdout/stderr.
- Child confirmed `process.kill(parentPid, 0)` returns `ESRCH` ~2s after parent exit — parent really is gone.

## LLM-thread hazard — still open

**Variant 2 did NOT validate this risk.** Running `bun src/index.ts ask --help` returns from Commander before the lazy LLM imports fire, so the spike never actually loaded `node-llama-cpp` in the parent. The "parent exit" measurement for variant 2 is only meaningful for help-path code; it says nothing about whether native threads from `src/llm/nodeLlamaCpp/lifecycle.ts` would hold the event loop open.

fn-72.2 must still:

- Detach **before** any code path that touches an LLM port. This is enforced by the overall design anyway (detach is the first await in the action handler, before any port/runtime instantiation), but the spike did not prove that constraint is forgiving.
- If, during fn-72.2 implementation, detach ends up sequenced after any module load that reaches `lifecycle.ts`, run an ad-hoc test with a real LLM-loading path (e.g. `gno ask "x" --detach` once wired) to confirm parent still exits. Either outcome is acceptable; the hazard being unproven only means fn-72.2 cannot assume immunity.

## Implications for fn-72.2 (`src/cli/detach.ts` helper)

- Detach path: `openSync(logPath, "a")` → `Bun.spawn({ cmd: [process.execPath, ...argvMinusDetach, sentinel], stdio: ["ignore", fd, fd], detached: true, cwd, env }).unref()`. Then write pid-file atomically and exit 0.
- Detach happens inside the action handler as the first await, before any port/runtime instantiation. If that ordering proves insufficient under a real LLM-loading path, restructure to detach at the top-level program action.
- `fs.closeSync(fd)` in the parent after spawn — the child has its own dup.
- Sentinel flag (e.g. `--__detached-child`) tells the re-invoked command body to skip the detach branch and run normally.

## Surprises

None on the Bun side; detach behaved exactly as docs suggest. The only correction from a post-spike review: variant 2's LLM-thread claim was overstated (see above).

## Artifact

`scripts/spike-detach.ts` — throwaway, gitignored via `.gitignore` (commit 4868f02). Not committed to main. Safe to delete locally once fn-72.2 lands.

## Evidence

- Commits: 4868f029df4ab0dc405afa3830fc85d6631d2c9a
- Tests: bun scripts/spike-detach.ts parent heartbeat, bun scripts/spike-detach.ts parent gno, bun run lint:check, bun test test/cli/
- PRs:
