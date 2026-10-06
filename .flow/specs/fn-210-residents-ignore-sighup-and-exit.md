# Residents ignore SIGHUP and exit without cleanup

## Problem

Nothing in `gno serve` or `gno daemon` handles SIGHUP, so the default action kills the process immediately: a closed terminal or a session logout ends a resident with no graceful shutdown. Locks are released by the kernel and the next start recovers, but in-flight work is cut off and the write-lease holder sidecar is left behind.

Evidence: fn-205 soak run `bun run soak --tier torture --classes signals --seed 3 --contain` failed I3 with "SIGHUP while mid-burst: write-lease holder sidecar left"; the restart afterwards released everything ("recovered after SIGHUP ... released"). SIGTERM in the same scenarios exits cleanly in tens of milliseconds.

## Acceptance Criteria

- **R1:** A resident (`serve`, `daemon`) treats SIGHUP like SIGTERM: graceful shutdown within the same budget, locks, pid file and holder sidecar released.
- **R2:** A regression test sends SIGHUP to a resident mid-sync and checks the exit and released files.
- **R3:** The soak torture `signals` class passes I3 for SIGHUP.

## Boundaries

- Short-lived CLI commands keep their current SIGHUP behavior.
- No change to how a detached resident is started; `--detach` children already ignore the terminal.
