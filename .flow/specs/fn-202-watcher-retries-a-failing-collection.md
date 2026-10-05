# Watcher retries a persistently failing collection every 500 ms forever

## Problem

A user on GNO Desktop 2.8.0 (macOS) reported heavy battery drain. Their diagnostics show the resident `gno serve` holding about 82% of one core with no active job, no API polling and no embedding pass running. Status reported `embed.lastResult.deferred=true` with `nextRunAt` rearmed every 30 s, status requests later timed out, a native sample showed main-thread SQLite reads and WAL commits with `fsync`, and their nightly routine timed out three days in a row while waiting for `nextRunAt` to clear. Two of their collections set `sourceAvailability: local` on paths GNO cannot verify, so every sync of those collections ends with `SOURCE_AVAILABILITY_UNSUPPORTED`.

Reproduced on this repo (`main` at 6cc426c7) with an isolated resident:

- With nothing pending, the resident idles at 0.1-0.3% CPU.
- Add a collection with `sourceAvailability: local` (unsupported on Linux, same error code as the user's) and touch one file in it. CPU rises to 7.9% and `ingest_errors` gains about 51 `SOURCE_AVAILABILITY_UNSUPPORTED` rows per 30 s, indefinitely.
- An unreadable file (`EACCES`) in a normal collection does the same (+20 rows per 10 s).

Mechanism: `requeueAfterFailure` (src/serve/watch-service-events.ts) re-arms a failed flush after a fixed `WATCHER_RETRY_BACKOFF_MS = 500` with no growth and no cap. A path or generation reconcile that fails the same way every time is retried twice a second for the life of the process. Each attempt takes the shared writer lease (spawning `lockf` on macOS), runs the sync, and writes an `ingest_errors` row. While the watcher holds the lease, the embed scheduler's pass defers and re-arms every 30 s, which is the `deferred=true` / `nextRunAt` state the user's wrapper waited on. `SOURCE_AVAILABILITY_UNSUPPORTED` is not a source-availability skip (`isSourceAvailabilitySkip`), so it counts as a file-level failure and enters this loop. On the user's Mac, unverifiable `local` availability also escalates directory events to a full-collection reconcile, which makes each attempt more expensive.

## Acceptance Criteria

- **R1:** Consecutive failed watcher flushes for one collection retry with a growing delay: the first retry keeps the current 500 ms, each further consecutive failure doubles it, up to a cap of 5 minutes. Pending work stays durably queued, as it does today. A watch-service test with a sync that always fails shows fewer attempts in the same window than a fixed 500 ms retry would make, while still retrying. Live: the isolated resident from the reproduction, with the `local` collection and a touched file, returns to near-idle CPU after the first few retries, and `ingest_errors` growth slows to the capped rate.
- **R2:** A flush that completes without failure resets that collection's failure count, so the next failure starts again at 500 ms. A test shows a successful flush resets the delay to 500 ms.
- **R3:** Writer-lease contention retries keep their fixed 5 s delay and do not count as failures.
- **R4:** Removing a collection or disposing the watch service clears its failure count.

## Boundaries

- No change to the embed scheduler. Its 30 s deferral is cheap on its own (measured 0.2% CPU with the lease held externally); it settles once the watcher stops monopolising the lease.
- No change to how `SOURCE_AVAILABILITY_UNSUPPORTED` is classified, and no pruning of `ingest_errors`. Both are reported as follow-ups.
