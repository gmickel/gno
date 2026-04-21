# fn-72-backgrounding-flags-for-serve-and-daemon.7 Update docs/ (CLI, DAEMON, WEB-UI, QUICKSTART, TROUBLESHOOTING, README, CHANGELOG)

## Description

Update user-facing documentation in the gno repo's `docs/` tree and the root README/CHANGELOG. (The separate website at `~/work/gno.sh` is handled in fn-72.8.)

The in-repo `website/` directory is legacy and not actively published — do NOT update it.

**Size:** M
**Files:**

- `docs/CLI.md` (serve section ~L953-1000, daemon section ~L908-951 — replace `nohup` example at L947)
- `docs/DAEMON.md` (remove/replace "Foreground-only in v0.30" note at L28; add "Managing the daemon" section; replace `nohup gno daemon > /tmp/gno-daemon.log 2>&1 &` pattern)
- `docs/WEB-UI.md` (synopsis block ~L563; start examples ~L56-57)
- `docs/QUICKSTART.md` (~L158 — replace `nohup` with `--detach`)
- `docs/TROUBLESHOOTING.md` (~L205 — update "Stop the daemon" section)
- `README.md` (quickstart if it mentions serve/daemon)
- `CHANGELOG.md` (add under `## [Unreleased]` → `### Added`)

## Approach

- Grep for `nohup gno` across `docs/` and replace every hit with the new `--detach` equivalent.
- Each `docs/*.md` file that documents `gno serve` or `gno daemon` gets: full flag list updated, a "Managing the process" subsection with `--status`/`--stop` examples.
- Add a troubleshooting entry: "pid-file exists but `--status` says not running" → stale detection / `--detach` auto-cleans.
- Add a troubleshooting entry for the **live-foreign case**: pid-file records a running process whose gno version doesn't match the current binary (e.g. user upgraded gno while the old detached process is still running). `--stop` will refuse to signal; guide the operator to `kill <pid>` manually and delete the pid-file. <!-- Updated by plan-sync: fn-72.2 shipped the live-foreign refuse-to-signal behavior; operators need docs for it -->
- Add a troubleshooting entry for the **start-lock error**: "another serve/daemon start is in progress (lock-file ...startlock)". Explain that stale locks (>30s) auto-recover; for locks stuck inside the 30s window the operator can delete the `.startlock` sidecar manually. <!-- Updated by plan-sync: fn-72.2 shipped an atomic start-lock; operators need to know the lock-file is real and how to recover it -->
- CHANGELOG entry: one line each for the five new flags, plus a note about the new exit code 3.

## Investigation targets

**Required:**

- `docs/CLI.md` — current serve + daemon sections
- `docs/DAEMON.md` — full file (it's the canonical daemon guide)
- `docs/WEB-UI.md` — serve synopsis
- `docs/QUICKSTART.md`, `docs/TROUBLESHOOTING.md` — stale `nohup` references

## Key context

- Version bump + CHANGELOG is MANDATORY on every merge to main (per root `CLAUDE.md`).
- `assets/skill/cli-reference.md` is covered in fn-72.8 along with the external website.

## Approach

- Grep for `nohup gno` across `docs/` and replace every hit with the new `--detach` equivalent. At least 6 hits expected.
- Each `docs/*.md` file that documents `gno serve` or `gno daemon` gets: full flag list updated, a "Managing the process" subsection with `--status`/`--stop` examples.
- Add a troubleshooting entry: "pid-file exists but `--status` says not running" → stale detection / `--detach` auto-cleans.
- Add a troubleshooting entry for the **live-foreign case**: pid-file records a running process whose gno version doesn't match the current binary (e.g. user upgraded gno while the old detached process is still running). `--stop` will refuse to signal; guide the operator to `kill <pid>` manually and delete the pid-file. <!-- Updated by plan-sync: fn-72.2 shipped the live-foreign refuse-to-signal behavior; operators need docs for it -->
- Add a troubleshooting entry for the **start-lock error**: "another serve/daemon start is in progress (lock-file ...startlock)". Explain that stale locks (>30s) auto-recover; for locks stuck inside the 30s window the operator can delete the `.startlock` sidecar manually. <!-- Updated by plan-sync: fn-72.2 shipped an atomic start-lock; operators need to know the lock-file is real and how to recover it -->
- CHANGELOG entry: one line each for the five new flags, plus a note about the new exit code 3.
- Run `bun run website:build` locally and verify rendered output in `website/_site/` is correct.

## Investigation targets

**Required:**

- `docs/CLI.md` — current serve + daemon sections
- `docs/DAEMON.md` — full file (it's the canonical daemon guide)
- `docs/WEB-UI.md` — serve synopsis

**Optional:**

- `website/Makefile` — sync-docs target mechanics
- `docs/QUICKSTART.md`, `docs/TROUBLESHOOTING.md` — stale `nohup` references

## Key context

- The `website/docs/` tree is auto-populated — do NOT edit there. Source of truth is `docs/`.
- Version bump + CHANGELOG is MANDATORY on every merge to main (per root `CLAUDE.md`).

## Acceptance

- [ ] Grep for `nohup gno` in `docs/` returns zero hits
- [ ] `docs/CLI.md`, `docs/DAEMON.md`, `docs/WEB-UI.md`, `docs/QUICKSTART.md`, `docs/TROUBLESHOOTING.md` each reflect new flag surface
- [ ] `README.md` quickstart updated if it mentions serve/daemon
- [ ] `CHANGELOG.md` `[Unreleased] → Added` lists the five new flags + `NOT_RUNNING` exit code
- [ ] In-repo `website/` is untouched (legacy, not actively published)

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
