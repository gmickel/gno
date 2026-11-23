# Relocate indexed documents across collections

## Conversation Evidence

> user (turn 1): "let's implement issue 359 and make a pr to upstream"
> issue #359: "In 2.16.0, moving an unchanged file into another collection creates a new document row because document lookup uses collection and relative path."
> issue #359: "Could an explicit cross-collection relocation operation preserve the indexed document identity and reuse its existing derived data when compatible?"
> issue #359: "Accept an explicit source document and destination collection/path, including reconciliation after a filesystem move."
> issue #359: "Verify unchanged source bytes and compatible conversion/chunking settings before taking the reuse path."
> issue #359: "Preserve the document's database identity, annotations, unchanged chunks and compatible vector ownership."
> issue #359: "Update its collection, URI, searchable path, change history and affected link projections."
> issue #359: "Reject destination collisions and ambiguous matches."
> issue #359: "An explicit relocation operation would avoid needing to infer a move from matching hashes, which can also identify independent copies. Some FTS work may still be necessary when the searchable path changes."

## Goal & Context
<!-- scope: business -->
<!-- Source: 10% user / 60% [paraphrase] / 30% [inferred] -->

Reorganizing a large index (for example splitting one collection into a prose collection and a data collection) currently costs a full re-ingestion of every moved file: the moved file becomes a new document, so it is hashed, converted, chunked and given new vector owner bindings, and the old document is only deactivated when its collection is next reconciled. On an index of about 40,000 documents, moving about 36,000 unchanged files ran at roughly 350 to 400 files per minute. [paraphrase] An explicit relocation lets the owner tell GNO "this indexed document now lives at that collection and path", so GNO keeps the document's identity and derived data and only updates what depends on its location. [paraphrase] [strategy:Local knowledge lifecycle]

## Architecture & Data Models
<!-- scope: technical -->

- One store operation moves one document row to a new `(collection, rel_path)` in a single transaction while keeping its database id: it updates the collection, relative path and URI, the full-text filepath (and title when it changes), the document's parsed links and path-derived metadata, and appends the change-journal entries. It never rebuilds full-text rows for other documents sharing the same content. [inferred]
- The ingestion layer plans each relocation and decides whether the fast path applies. The fast path applies only when normal ingestion of the destination file would treat the row as unchanged: same source bytes (hashed from the destination file), current ingest version, no recorded error, and compatible conversion, chunking and language settings. Anything else is refused and left to normal ingestion. [inferred]
- The destination file is read through the same guards `gno update` uses for a targeted path: containment inside the destination collection root, the collection's include/exclude rules, size limits and source-availability rules. [inferred]
- Chunks, vector variants and owner bindings stay attached to the document. When the destination path changes the document's title (a filename-derived title), the owners for that document are invalidated exactly as normal ingestion does on a title change, so the next embed pass re-embeds them instead of keeping stale vectors. [inferred]
- Graph and typed-edge projections are re-projected for the moved document and the documents that link to it before and after the move, through the existing projection path. [inferred]

## API Contracts
<!-- scope: technical -->

- A CLI command under `gno collection` relocates one document (by `#docid`, `gno://` URI or `collection/path` reference), a folder prefix, or a mapping file of source/destination pairs, under the write lease, with a dry-run mode and a JSON receipt listing each item as relocated or refused with a reason code. [inferred]
- A refused item leaves the index unchanged for that item; the command reports it and exits non-zero when any item was refused, while committing the items that succeeded. [inferred]

## Edge Cases & Constraints
<!-- scope: technical -->

- Destination already indexed (active or inactive row) is refused as a collision. [paraphrase]
- A `#docid` reference that matches more than one active document, or two items in one run with the same source or destination, are refused as ambiguous. [paraphrase]
- Changed bytes at the destination, a changed extension, a different effective language hint, record containers and their records, and memory-managed collections on either side are refused (normal ingestion handles them). [inferred]
- The old path must no longer exist, unless it is the same physical file as the destination (nested collection roots); otherwise the move could be a copy and is refused. [inferred]
- An inactive source document is refused. [inferred]
- Vector reuse holds when the destination collection resolves to the same embedding model; with a different model the document keeps its identity, chunks and text search, and the destination model's vectors are pending as for any new document. [inferred]

## Acceptance Criteria

- **R1:** Relocating an unchanged indexed document to another collection keeps its database id, chunks, tags and vector owner bindings; an embed dry run afterwards shows nothing pending for it when both collections use the same embedding model. [paraphrase]
- **R2:** After relocation, search and retrieval find the document under its new collection, path and URI, searches scoped to the source collection no longer return it, and a following `gno update` reports no added or inactivated documents for the moved files. [paraphrase]
- **R3:** The relocation updates the change history and the link and graph projections that depend on the document's collection or path. [paraphrase]
- **R4:** Destination collisions, ambiguous references, changed bytes and incompatible settings are refused without modifying the index for that item. [paraphrase]
- **R5:** When the destination filename changes the document's title, the document keeps its identity but its vector owners become pending rather than keeping stale vectors. [inferred]
- **R6:** Relocation runs under the write lease and keeps vector epoch fences intact; it does not mark the vector index mirror stale. [inferred]
- **R7:** A benchmark on synthetic documents reports the time to relocate N documents against the time normal ingestion takes for the same move. [inferred]

## Boundaries
<!-- scope: business -->

- No move inference from matching hashes during `gno update`. [paraphrase]
- No filesystem moves by GNO: relocation records a move the owner already made on disk. [inferred]
- No MCP, SDK or Web UI surface in this change. [inferred]

## Decision Context
<!-- scope: both -->

Explicit relocation was chosen over hash-based move inference because matching hashes also identify independent copies. [paraphrase] Refusing the fast path on any incompatibility, instead of partially re-deriving data, keeps relocated rows indistinguishable from what normal ingestion would have produced. [inferred]
