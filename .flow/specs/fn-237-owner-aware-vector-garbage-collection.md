# Owner-aware vector garbage collection

## Conversation Evidence

> issue #361 (https://github.com/gmickel/gno/issues/361): "Provide an explicit way to remove stored vector variants that no longer have any valid active document owner."
> issue #361: "Proposal: expose `gno vec gc`, optionally also integrating the same operation into `gno cleanup`."
> issue #361: "Inspect all stored partitions, including active, shadow and legacy-keyed partitions, rather than only the current model's selected partition."
> issue #361: "Preserve every variant with at least one valid active owner in its own partition, regardless of the owner's collection."
> issue #361: "Provide a non-mutating `--dry-run` with per-partition collectible variant counts and stored embedding-payload bytes."
> issue #361: "Perform deletion under the index write lease, with transactional owner revalidation, epoch invalidation and consistent updates to owner rows, variants and available vector mirrors."
> issue #361: "Preserve retrieval authority and existing mirror-state guarantees. Report partitions that cannot be processed safely."
> issue #361: "Define legacy `content_vectors` handling explicitly, with separate counts if included."
> issue #361: "Report logical deletion separately from disk space returned. Deleting rows can make database space reusable without shrinking the file. Any compaction option or documented procedure should address temporary space, locking and WAL behavior separately."
> user (turn 1): "doing gc automatically after we expose it should be no big deal? let's build that too."
> user (turn 1, [paraphrase]): automatic collection must be cheap when there is nothing to collect (an indexed query, not a full scan), bounded per run with leftovers collected next time, safe under concurrent search and embedding, default on, and switchable off if GNO has a pattern for that.

## Goal & Context
<!-- scope: business -->
<!-- Source: 55% issue / 15% user / 30% [inferred] -->

Synchronization deactivates documents but keeps their vector owner bindings, so stored vector variants (and their vec0 mirror rows) outlive every document that could use them. `gno cleanup` collects orphaned content, chunks and legacy `content_vectors`, but not `vector_variants`; `vec sync` and `vec rebuild` re-mirror stored variants including unowned ones; `vec drop` removes only whole abandoned shadow partitions. The existing owner-aware collector covers one partition and runs only during conditional runtime-reference maintenance in embedding preparation. After a large index reorganization the database keeps the old vectors indefinitely. [paraphrase]

This spec exposes owner-aware collection as `gno vec gc` across every stored partition, and runs the same operation automatically at the point where unowned variants have settled, bounded and cheap when there is nothing to do. [strategy:Local knowledge lifecycle]

## Architecture & Data Models
<!-- scope: technical -->
<!-- Source: [inferred] from codebase inspection -->

- **One liveness rule, one implementation.** A variant in partition P is *live* when some active document whose content matches the content of one of the variant's owner bindings (same mirror hash and chunk sequence) produces the variant's exact embedding input under P's model. This covers every valid active owner (any collection) and also identical content that is active but not yet re-bound (a moved file before the next embed), which the embed path would reuse by input hash. Everything else is collectible. The per-partition evaluation works over the database and the partition's stored model only; it never constructs a variant store (which can create partition and mirror state). The store's existing single-partition collector and owner release delegate to it.
- **Removal.** A batch removes, in one immediate transaction, the vec0 mirror rows (when the partition has a mirror table and sqlite-vec is loaded), the owner bindings and the variants of the collectible ids it re-selected inside that transaction. The existing epoch triggers fence concurrent embedding and proofs. The prior mirror mark is restored only when the mirror was updated in the same transaction; a dirty or never-recorded mark stays as it was. Partition state and activation are never changed.
- **Durable candidate queue.** A trigger-fed table of `(partition, variant)` candidates is filled when a document goes from active to inactive (its bindings' variants), when an owner binding is deleted (including by cascade), and when an owner binding is re-pointed to another variant. Inserts are conflict-free (no unique key or conflict clause). A migration seeds it once from bindings of already-inactive documents. Processing a candidate removes its queue row whether the variant is kept or collected, so the queue only holds unexamined work.
- **Automatic collection point.** At the end of an embed pass for the partition the pass embedded into, under the pass's write turn: one indexed probe of that partition's queue; when non-empty, process candidates in bounded batches (count cap per batch, overall count and time budget per pass). Leftovers stay queued for the next pass. Other partitions' candidates wait for `gno vec gc`.
- **Explicit command.** `gno vec gc` walks every stored partition's variants in keyset batches (active, shadow and legacy-keyed alike) with the same rule, clears queue rows for the variants it examined, and reports per partition. `--dry-run` opens the index read-only (no migrations, no lease) and reads one snapshot.

## API Contracts
<!-- scope: technical -->
<!-- Source: [inferred] -->

- `gno vec gc [--dry-run] [--json]` plus the existing write-lease flags. Per partition: id, model, state (active/shadow), legacy flag, variants examined, collectible (dry run) or removed (real run) variants, their stored embedding bytes, and skip reason when it could not be processed. Totals: variants, embedding bytes, and the database's reusable free space and file size, reported separately from the logical bytes. A note that legacy `content_vectors` are excluded (collected by `gno cleanup`) with their read-only count.
- Automatic collection is on by default and turned off with an environment variable.
- Compaction is never automatic: documentation describes `VACUUM` as a separate explicit step (temporary space up to about twice the database, exclusive lock for the duration, WAL checkpoint).

## Edge Cases & Constraints
<!-- scope: technical -->
<!-- Source: [inferred] -->

- A partition with a vec0 mirror table while sqlite-vec cannot load is skipped and reported, never partially mutated.
- A queued candidate whose variant no longer exists (partition dropped, already collected) is discarded.
- Garbage that predates the queue and has no inactive-document binding (for example variants whose bindings were deleted before upgrade) is only found by the explicit full traversal.
- Searches read committed snapshots: each batch is visible all at once or not at all.
- A variant kept only because identical, not-yet-bound content exists is dequeued; if that content is removed before it is ever embedded, only the explicit traversal finds the variant again.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** `gno vec gc` examines every stored partition (active, shadow and legacy-keyed) and removes exactly the variants with no live use in their own partition, together with their owner bindings and vec0 mirror rows; a variant with a valid active owner in its partition stays regardless of the owner's collection, and two documents sharing content keep the shared variant when only one is deactivated. Errors: lease busy → the existing write-lease error and exit code; a partition whose mirror table exists without sqlite-vec → skipped with a reason, others processed; uninitialized GNO → the existing error.
- **R2:** `gno vec gc --dry-run` reports per-partition collectible variant counts and stored embedding bytes, equal to what a real run then removes, and leaves the database unchanged (main file bytes, row counts, variant epoch, mirror marks, partition rows); it takes no write lease and runs against an index whose schema is older than this release. Errors: no error surface beyond R1's uninitialized case.
- **R3:** Real runs work in bounded batches, each in its own immediate transaction that re-selects and revalidates its variants; a concurrent search during collection only ever sees the before or after state of each batch; partition state and activation never change; a clean mirror stays clean and a dirty mirror stays dirty. Errors: no error surface beyond R1.
- **R4:** Output reports logical embedding bytes removed separately from the file size and reusable free space, names legacy `content_vectors` as excluded with their count, and the docs describe compaction as a separate explicit step with its temporary-space, locking and WAL costs. Errors: no error surface beyond R1.
- **R5:** Automatic collection runs at the end of each embed pass for that pass's partition, default on: with nothing queued it costs one indexed probe; it processes at most a bounded number of candidates per pass within a time budget and resumes on the next pass; it removes exactly the variants and mirror rows that deactivation or rebinding left unowned; an environment variable turns it off. Errors: a failure inside automatic collection is reported on the embed result and never fails or rolls back the embed pass.
- **R6:** Moving a file within or across collections and then syncing and embedding with automatic collection on re-embeds no chunk of the moved file. Errors: no error surface beyond R5.
- **R7:** A bench reports automatic-collection cost with nothing to collect and when collecting N variants. Errors: no error surface.

## Boundaries
<!-- scope: business -->

- No automatic compaction or `VACUUM`. [inferred]
- `gno vec gc` does not collect legacy `content_vectors`; `gno cleanup` keeps owning them. [inferred]
- No change to retrieval authority, partition activation or the single-writer model. [paraphrase]

## Decision Context
<!-- scope: both -->

Automatic collection runs at the end of an embed pass rather than at the end of synchronization: the embed path reuses stored variants by exact input hash for identical content that has not been re-bound yet (a moved file), so collecting right after the old document is deactivated would discard vectors the next pass reuses. At the end of the pass, the partition's bindings have settled. The liveness rule additionally keeps variants whose content is active but unbound, which protects bounded or collection-scoped passes. A trigger-fed queue makes the no-op check one indexed probe and makes bounded runs resumable across processes; an epoch comparison would fire after any write, and a full traversal re-hashes the partition. `gno cleanup` integration is left out: cleanup's orphan pass is index-wide and unbounded, while the explicit command and the embed-end pass cover both use cases. [inferred]
