# Short-circuit unchanged files in sync without reading and hashing them

## Overview

Proving a file is unchanged currently costs a full content read plus a SHA-256 of
every byte. `SyncService` decides skip-vs-process purely on `sourceHash`
(`src/ingestion/sync.ts:194-260`, `decideAction`), and `sourceHash` is only available
after the file has been read into memory and hashed (`sync.ts:775-781`). The store
already persists `sourceMtime` and `sourceSize` on every document row
(`spec/db/schema.sql`, `DocumentRow`), and `decideAction` never consults either.

Measured cost: **~3.3 ms per unchanged file** (5,000-file fixture, 16,689 ms median for
the unchanged pass). The per-file work is: stat, read 512 bytes for MIME sniff,
`listRecordDocuments`, read the whole file, SHA-256 it, `getDocument`, then conclude
"unchanged" and skip.

This is pre-existing behavior on every sync path — `gno update`, the daemon, and the
watcher all pay it. It became more visible in
`fn-114-reliable-watcher-reconciliation-for`, which made directory-scoped reconciliation
reachable from a single ambiguous filesystem event, so a large directory's unchanged
pass can now be triggered by ordinary temp-file churn rather than only by an explicit
update.

## Why this is worth doing

The win is not limited to the watcher. `gno update` over a large, mostly-unchanged
collection is dominated by this same read-and-hash pass. A cheap pre-check turns the
common "nothing actually changed" case from O(bytes) into O(1) per file.

## Boundaries / non-goals

- Not a change to what counts as changed once the fast path declines to skip — the
  hash comparison stays the authority whenever it runs
- Not batching, pagination, or parallelism in `syncPaths` (a separate axis)
- Not a change to `fn-114`'s reconciliation scope or bounds
- Not removing `sourceHash` from the schema or from change detection

## Decision context

The obvious implementation is: if an existing row's `sourceMtime` **and** `sourceSize`
both match the current `stat`, skip without reading. That is how most incremental build
systems work, and the data is already stored.

It is not free of correctness risk, and this spec exists partly to force that analysis
rather than assume it:

- `cp -p`, `rsync -t`, restores from backup, and archive extraction all deliberately
  preserve mtime while changing content
- Filesystem mtime granularity varies (HFS+ 1 s, ext4 ns, some network filesystems
  coarser); a write within the granularity window can be invisible
- Clock skew and clock rollback on the host
- Editors that write in place can preserve size for a same-length edit; **size alone is
  not a signal, and mtime alone is not either** — the pair is weaker than a hash by
  construction

Therefore the fast path must be a *conservative* optimization: it may only ever skip
work that the hash would also have skipped, and any doubt falls through to the existing
read-and-hash. An explicit escape hatch (a force/verify flag on `gno update`) is
probably required so users who hit a stale-index case have a recovery that does not
involve deleting the collection.

## Acceptance Criteria

- **R1:** A file whose stored `sourceMtime` and `sourceSize` both match the current
  filesystem stat is skipped without reading its content or computing its hash.
- **R2:** Any mismatch, missing stored value, or stat failure falls through to the
  existing read-and-hash path. The fast path can only skip; it can never mark a file
  changed on its own.
- **R3:** Every existing repair trigger still fires — previous conversion failure,
  recorded error, outdated `ingestVersion`, changed content-type-rules fingerprint. The
  fast path must not skip a file that `decideAction` would have sent to repair.
- **R4:** Record-container documents and their derived logical records behave
  identically to today.
- **R5:** A documented, tested recovery path exists for a stale index (for example a
  verify/force mode on `gno update` that ignores the fast path).
- **R6:** Measured improvement on a mostly-unchanged collection, reported as a
  before/after median with the fixture stated. Target: unchanged-file cost drops by at
  least an order of magnitude.
- **R7:** No regression in `gno update` correctness on a collection where content
  changed but mtime was preserved, when run through the R5 recovery path.

## Open questions

- Should the fast path be on by default, or opt-in until it has soaked? Default-on is
  where the value is, but a stale index is a silent, trust-destroying failure.
- Is `sourceCtime` a better second signal than `sourceSize`? ctime changes on metadata
  writes too, so it is harder to forge accidentally — but it is not preserved by `cp -p`
  and behaves differently across platforms.
- Does anything else in the codebase already depend on `sourceMtime` being advisory
  rather than authoritative? Audit before making it load-bearing.

## References

- `src/ingestion/sync.ts:194-260` — `decideAction`, which today compares only `sourceHash`
- `src/ingestion/sync.ts:762-800` — the per-file read, MIME sniff, hash, and store lookups
- `src/store/types.ts` — `DocumentRow.sourceMtime`, `sourceSize`, `sourceCtime`
- Measurement from `fn-114-reliable-watcher-reconciliation-for.4`: 5,000 eligible files,
  five warm runs, unchanged `syncPaths` pass median 16,689 ms (~3.3 ms/file), versus
  7.2 ms enumeration and 1.5 ms for the store query
- Discovered during `fn-114-reliable-watcher-reconciliation-for` review
