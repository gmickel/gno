# A failing file makes the watcher re-sync the whole collection forever

## Problem

When a watcher's full-collection reconcile (generation reconcile) completes but one file in the collection fails (unreadable, password-protected, unverifiable source), the whole reconcile is requeued with failure backoff. The backoff caps at 5 minutes, so the resident walks and hashes the entire collection every 5 minutes for as long as it runs. On a large vault with a single unreadable file that is a recurring full scan, the battery-drain class fn-202 fixed for targeted syncs.

Before fn-205 this path ran only after a config edit. fn-205 queues a generation reconcile at every `gno serve` start, so it now hits every desktop user with any permanently failing file.

Evidence:
- Probe on main a331392a: 5 notes plus one `chmod 000` note, `gno update`, then `gno serve` for 300 s: `ingest_errors` rows 1 -> 6 (10 s) -> 7, 8, 9 (~70 s), 10 (~130 s), 11 (~260 s), one full reconcile per backoff step.
- Soak smoke on main (seed 21): I1 fails in the steady phase with `ingest_errors +10`, `db +185400 B`, about 42 wakeups/s; fn-208's smoke on a pre-fn-205 base passed I1 (0 errors, 9.8 wakeups/s).

## Acceptance Criteria

- **R1:** A generation reconcile that completed with file-level failures counts as done for the collection: only the failed paths are retried (as exact paths, with the existing failure backoff), never the whole collection.
- **R2:** A regression test shows that a permanently failing file causes no repeated full reconciles while still retrying that file with backoff.
- **R3:** Soak smoke passes I1 in the steady phase (no ingest-error growth from repeated reconciles) and the probe above shows bounded single-file retries.

## Boundaries

- A reconcile that fails as a whole (throws, store error, collection unavailable) still requeues the generation with backoff, as today.
- No change to fn-202's backoff constants.
