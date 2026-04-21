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
TBD

## Evidence
- Commits:
- Tests:
- PRs:
