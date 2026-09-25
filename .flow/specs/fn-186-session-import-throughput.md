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

## Completion evidence
<!-- scope: technical; source: measured -->

Measured with `bun run bench:session-import` (synthetic Codex corpus, 200 turns per thread = 400 records, isolated temp root, one child process per size; Linux, 32 cores, Bun 1.4.2). "Before" is the base commit 6dfe4dce; the 300-thread run was capped at 900 s.

| Threads | Records | Before (s) | Before ms/turn | After (s) | After ms/turn | After peak RSS (MB) | Speedup |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 30 | 12,000 | 172.9 | 28.8 | 14.5 | 2.42 | 256 | 11.9x |
| 90 | 36,000 | 1,625.1 | 90.3 | 46.8 | 2.60 | 441 | 34.7x |
| 300 | 120,000 | >900 (capped) | n/a | 168.2 | 2.80 | 1,116 | n/a |

After the fix the per-turn cost at 300 threads is 1.16x the 30-thread cost (before: 3.13x from 30 to 90). Before-fix peak RSS was 218 MB at 30 threads and 409 MB at 90. After the import the JS heap is about 10 MB; the remaining RSS growth is native SQLite memory.

Root cause: with no `sqlite_stat1` statistics, SQLite's planner chose the low-selectivity `idx_documents_active` index (or a collection-wide scan) over the selective one for four queries on the record-sync path, so each record or file scanned the whole index. The queries were the legacy-vector title lookup (`mirror_hash = ? AND active = 1`, twice per upsert), the FTS rebuild owner lookup (same shape), `listRecordDocuments` (`collection = ? AND record_source_path = ?`, which walked the collection's `(collection, rel_path)` autoindex to avoid a sort), and the change-journal age cutoff (`MAX(sequence) ... WHERE observed_at_ms <= ?`, a reverse rowid walk). Each now names its index with `INDEXED BY`, and the query results are unchanged.

R3: the index tables of both `eval:sessions` arms (the gold arm is an ordinary JSONL record collection), the import receipts and the session state checkpoints hash identically before and after. Timestamps and environment-dependent fingerprints (paths inside the temp root) are excluded because they differ between two runs of the same tree.
