# Session import throughput

## Goal & Context
<!-- scope: business; source: inferred -->

Session import is correct but too slow for real histories. With synthetic placeholder data, 30 threads of 200 turns took about 160 s to import, and 90 such threads ran for more than 20 minutes: time grows faster than the data. A developer machine can hold thousands of agent threads, so a first import can take hours. The import no longer blocks the server, but its duration now limits who can use the feature.

## Architecture & Data Models
<!-- scope: technical; source: inferred -->

Profiling shows nearly all time in syncing archive records into the index; parsing and sanitizing a 10-thread source takes about 141 ms. Each thread's archive file is synced in one SQLite transaction (about 2 s for a 200-turn thread). Find the superlinear step (per-record lookups, re-reading or re-hashing whole archive files on each append, per-record index maintenance, or FTS work) with a profile on a generated corpus before changing code. Reuse the shared record-sync path; a fix there must keep ordinary JSONL collections correct.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** [inferred] A committed benchmark script generates a synthetic session corpus at three sizes (for example 30, 90 and 300 threads of 200 turns) and records import time, per-turn cost and peak memory. Errors: benchmark data stays synthetic and out of the repo.
- **R2:** [inferred] Import time scales roughly linearly with turn count across the three sizes, with the per-turn cost at the largest size within 1.5x of the smallest, and the 90-thread corpus imports at least 5x faster than before. Record before/after numbers in the spec completion evidence.
- **R3:** [inferred] Correctness is unchanged: `eval:sessions` stays at 100%, receipts and checkpoints are identical for the same fixtures, and ordinary JSONL record collections produce the same index contents before and after.
- **R4:** [inferred] The server stays responsive during imports (existing timer-drift test still passes).

## Boundaries
<!-- scope: business -->

- [inferred] No change to the archive format, redaction or identity rules; no new background service.
