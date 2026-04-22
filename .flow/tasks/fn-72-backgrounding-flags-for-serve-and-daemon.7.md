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
- **`--json` is gated to `--status` only**: document that `gno serve --detach --json` and `gno serve --stop --json` (and the daemon equivalents) intentionally fail with VALIDATION. Update `docs/CLI.md` flag-format matrix accordingly. <!-- Updated by plan-sync: fn-72.3 added explicit --json gating with a VALIDATION error -->
- **`--stop` is silent when nothing is running**: document that `--stop` with no pid-file exits 3 and writes nothing on stderr (no error envelope). Operators scripting `--stop` should rely on the exit code, not on parsing stderr. <!-- Updated by plan-sync: fn-72.3 routes the not-running stop branch through CliError silent mode -->
- **`--status` exits 3 (NOT_RUNNING) when not running**: document that `--status` returns the schema-conformant payload on stdout AND a non-zero exit code (3) when `running:false`. Foreground status callers expecting exit 0 must change. <!-- Updated by plan-sync: fn-72.3 throws NOT_RUNNING after writing the stdout payload -->
- **Foreign-live JSON envelope**: when `--status --json` lands on a foreign-live pid, the NOT_RUNNING error envelope on stderr carries `details.foreign_live = { pid, recorded_version, current_version }`. Document the envelope shape so machine consumers know the field name. <!-- Updated by plan-sync: fn-72.3 routes foreign-live metadata through CliError.details so JSON-mode stderr is a single envelope -->
- CHANGELOG entry: one line each for the five new flags, plus a note about the new exit code 3, plus a note that `--json` is restricted to `--status` (and `--stop` is silent when not running).

## Investigation targets

**Required:**

- `docs/CLI.md` — current serve + daemon sections
- `docs/DAEMON.md` — full file (it's the canonical daemon guide)
- `docs/WEB-UI.md` — serve synopsis
- `docs/QUICKSTART.md`, `docs/TROUBLESHOOTING.md` — stale `nohup` references
- `src/cli/program.ts:2225-2566` — fn-72.3 serve wiring (canonical reference for the `--json` gating message text and the silent-NOT_RUNNING shape) <!-- Updated by plan-sync: fn-72.3 is now the source of truth for the operator-facing flag semantics -->

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
- [ ] `docs/CLI.md` documents the `--json` gating rule (only `--status` accepts `--json`; everything else throws VALIDATION) <!-- Updated by plan-sync: fn-72.3 added explicit --json gating -->
- [ ] `docs/CLI.md` documents the silent-`--stop` behavior (no stderr when no pid-file; rely on exit code 3) <!-- Updated by plan-sync: fn-72.3 routes the not-running stop branch through CliError silent mode -->
- [ ] `docs/CLI.md` documents that `--status` exits 3 when `running:false`, even though stdout still carries the schema payload <!-- Updated by plan-sync: fn-72.3 throws NOT_RUNNING after writing the stdout payload -->
- [ ] `docs/TROUBLESHOOTING.md` documents the foreign-live JSON envelope (`details.foreign_live = { pid, recorded_version, current_version }`) for machine consumers <!-- Updated by plan-sync: fn-72.3 routes foreign-live metadata through CliError.details -->
- [ ] `README.md` quickstart updated if it mentions serve/daemon
- [ ] `CHANGELOG.md` `[Unreleased] → Added` lists the five new flags + `NOT_RUNNING` exit code
- [ ] In-repo `website/` is untouched (legacy, not actively published)

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
