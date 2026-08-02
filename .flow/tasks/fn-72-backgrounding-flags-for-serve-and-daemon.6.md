# fn-72-backgrounding-flags-for-serve-and-daemon.6 Windows behavior: taskkill fallback + Windows CI

## Description

Ship Windows support for the new flags. Bun's `detached: true` on Windows maps to libuv's `UV_PROCESS_DETACHED`; signals behave differently (SIGTERM == force-terminate on Windows).

**Size:** M
**Files:**

- `src/cli/detach.ts` (platform branch for stop)
- `test/cli/detach.integration.test.ts` (Windows-specific cases)
- `docs/WINDOWS.md` (add a note on detach behavior)

## Approach

- On Windows, graceful shutdown is best-effort. Try `process.kill(pid, "SIGTERM")` first (Bun translates via libuv, though it's effectively force-terminate); if the child doesn't exit within timeout, fall back to `Bun.spawn(["taskkill", "/PID", String(pid), "/F", "/T"])` (`/T` reaps the tree, `/F` forces).
- Log a single-line warning when running on Windows: "graceful shutdown is limited on Windows; use `--stop` with patience or `taskkill /F` manually".
- Use `join` from `node:path` for all pid/log paths — no hardcoded `/` separators (see ff7f0c4 regressions).
- Path assertions in tests: use `.toEndWith(join("gno", "serve.pid"))` not `.toContain("/gno/serve.pid")`.
- Windows CI must be green. Recent commits (ff7f0c4, 6ff5df5) set the bar — don't regress.
- `ensureDirectories()` must be called before opening any SqliteAdapter on Windows paths.

## Investigation targets

**Required:**

- Recent commit ff7f0c4 — Windows path fixes (reference for pitfalls)
- `test/cli/concurrency.test.ts` — 20s timeout for win32
- `docs/WINDOWS.md` — existing Windows caveats section

**Optional:**

- `.github/workflows/` — Windows CI job layout

## Key context

- `taskkill /PID <pid> /F /T` is the Windows equivalent of SIGKILL+tree-kill.
- Bun's Windows `detached` has known quirks with `.cmd`/`.ps1` wrappers — always spawn `process.execPath` (bun.exe) directly, never a shim.
- SIGTERM on Windows via libuv is effectively immediate termination; document this as a platform limitation.

## Acceptance

- [ ] Windows `--stop` uses `taskkill /PID /F /T` fallback when SIGTERM doesn't complete
- [ ] Warning printed once on Windows about graceful-shutdown limitations
- [ ] `docs/WINDOWS.md` documents the platform caveat
- [ ] All paths use `node:path join` — no hardcoded forward slashes
- [ ] Windows CI green across `bun run lint:check && bun test`
- [ ] Integration test for `--stop` passes on Windows (using `taskkill` path)

## Done summary
Closed by the documented scope decision: native Windows detach remains unsupported; Windows users receive validation guidance to use WSL. The task explicitly said not to reopen without a new scope decision.
## Evidence
- Commits:
- Tests: bun test test/cli/detach.integration.test.ts (Windows validation case retained; platform case skipped on macOS), v1.30.4 publish workflow 30750726932: Windows matrix success
- PRs: