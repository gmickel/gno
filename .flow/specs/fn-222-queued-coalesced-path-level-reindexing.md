# Queued, coalesced, path-level reindexing

## Conversation Evidence

> user (turn 1, [paraphrase]): "How does GNO's indexing work today, and what would have to happen if around 100 people on one shared deployment asked to reindex parts at the same time? Would a queueing system make sense without degrading the experience for single-user vaults?"

## Goal & Context
<!-- scope: business -->
<!-- Source: 30% user / 40% [paraphrase] / 30% [inferred] -->

GNO is increasingly run as one shared resident (`gno serve` / `gno daemon` behind the HTTP MCP gateway) that many agents and people use at once. In that setup, on the order of 100 people may ask to reindex parts of the index at the same time. Today:

- Only one write job runs per process; every other request is rejected (`JOB_CONFLICT` / `LOCKED`) and each client must retry on its own.
- Identical requests are not merged, so N requests for one collection mean N full rescans (each one reads and hashes every file).
- Callers can only reindex a whole collection or everything. Path-level sync exists internally (watcher, capture, remember) but is not exposed.

The goal is a queueing approach that absorbs concurrent reindex requests without deteriorating the experience for single-user vaults, which remain the primary GNO use case.

## Architecture & Data Models
<!-- scope: technical -->
<!-- Source: [inferred] -->

- **Pending work per collection.** The job manager keeps, per collection, one pending entry holding either a set of paths or a "whole collection" marker (whole subsumes paths). A new request merges into the pending entry instead of creating a new run. One worker drains entries in order, taking the write lease for each. If new work arrives for a collection while it is running, the worker runs one more pass afterwards. This mirrors the existing embed scheduler's debounce-and-rerun behaviour.
- **Ownership.** The queue is in-process state owned by the job manager of the process that holds the resident owner lock (or the stdio MCP process). It is not persisted. The index on disk stays the source of truth; the watcher and the daemon's startup sync already reconcile the index with the files.
- **Single writer stays.** The shared write lease and `BEGIN IMMEDIATE` remain the exclusion between writers across processes.
- **Path-level reindex** reuses the existing path-scoped sync used by the watcher, including deletion handling for paths that no longer exist.

## API Contracts
<!-- scope: technical -->
<!-- Source: [inferred] -->

- Reindex requests (MCP `gno_index` / `gno_sync`, REST `POST /api/sync`, CLI `gno index` / `gno update`) accept an optional list of paths within a named collection, alongside today's collection-or-all scope.
- A request accepted while other write work is running or pending returns a job id instead of `JOB_CONFLICT`. When it merges into an existing pending entry, it returns that entry's job id, so several callers may share one job id.
- Job status reports `queued`, `running`, `completed` or `failed`, plus the scope that was merged into the job.
- A full queue returns a distinct error (not `JOB_CONFLICT`) that says the queue is full and when to retry.

## Edge Cases & Constraints
<!-- scope: technical -->
<!-- Source: [inferred] -->

- Process exit or crash with queued jobs: queued work is lost. Status lookups for those job ids after restart report "unknown job", as today. The index stays consistent because each pass commits per batch.
- A path outside the collection root, or one that escapes it through a symlink, is rejected before queueing.
- A requested path that no longer exists is treated as a deletion, as the watcher does.
- A whole-collection request arriving while a path-level entry is pending replaces it with a whole-collection pass. A path-level request arriving while a whole-collection pass is pending is absorbed.
- Embedding stays in the resident's background scheduler. A sync job must not leave the embed backlog deferred indefinitely because it held the lease when it triggered embedding.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** A reindex request that arrives while another write job is running or pending is queued and returns a job id instead of being rejected with `JOB_CONFLICT` or `LOCKED`. Errors: when the pending queue is at its bound, the request fails with a distinct queue-full error carrying a retry hint; an unknown collection is rejected before queueing. [paraphrase]
- **R2:** Concurrent reindex requests for the same collection are coalesced: while one pass for that collection runs, any number of further requests for it cause at most one more pass, and that pass covers the union of what they asked for. Errors: no error surface beyond R1. [inferred]
- **R3:** A caller can reindex a list of paths inside one collection through CLI, MCP and REST, and only those paths are re-read and re-processed. Errors: a path outside the collection root (including through a symlink) is rejected with a clear message; a path that no longer exists is marked inactive; an empty list is rejected. [inferred]
- **R4:** Single-user vaults are not degraded: with a single caller, a reindex starts immediately as today, produces the same index contents, and the CLI keeps its current write-lease wait, `--no-wait` behaviour and exit codes. Errors: no error surface beyond today's. [paraphrase]
- **R5:** If the process stops while jobs are queued, the index on disk stays consistent, and after restart a status lookup for a lost job id reports it as unknown rather than completed. Errors: no error surface beyond R1. [inferred]

## Boundaries
<!-- scope: business -->

- No external queue service or broker, and no persisted job store. [inferred]
- No change to the single-writer model: one write lease per data directory, one writer at a time. [inferred]
- No multi-user authentication, per-user authorization or per-user quotas. [inferred]
- Reads blocking behind write jobs is fixed in the sibling spec "Index jobs no longer block reads", which this one depends on. [inferred]

## Decision Context
<!-- scope: both -->
<!-- Source: [inferred] -->

Split out from one captured spec on concurrent reindexing; the sibling "Index jobs no longer block reads" ships first.

`fn-127` (serialise concurrent index and embed) deliberately rejected a job queue and a lock service in favour of one shared write lease. That decision was made for single-user vaults with scheduled jobs colliding. This spec keeps the lease and the single-writer model and adds only an in-process, coalescing queue in front of it, because rejecting requests does not scale to a shared resident with many callers. With one caller the queue never holds more than one entry, so single-user behaviour matches today.

Rejected: an external broker (adds a service and latency on a single-writer host for no throughput gain); splitting the database per collection (a larger storage change that does not address the request rejections); rate-limiting reindex requests instead of merging them (still rescans repeatedly).

## Parked unknowns

- Whether upstream wants a queue at all, given that `fn-127` rejected one: needs the maintainer's call.
- The queue bound and the priority between small path-level requests and whole-collection passes: needs a load test against a shared resident at about 100 concurrent callers.
