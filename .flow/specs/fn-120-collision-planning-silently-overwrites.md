# Collision planning silently overwrites record containers and unindexed files

## Overview

Every create/duplicate/copy surface decides "does something already exist at this
target?" from the set of **indexed `rel_path` values**. A physical record container
(`.jsonl`, `.vtt`, … per the collection's `recordAdapters`) has no row at its own rel
path — its content is indexed as N logical records at virtual `.gno/records/…` paths,
with the physical file recorded only in `record_source_path`. It is therefore invisible
to collision planning. So is any file on disk that is not indexed at all, on the surfaces
that pass no disk listing.

**Severity: P1 — data loss.** Pre-existing; predates
`fn-114-reliable-watcher-reconciliation-for`, which only surfaced it.

## Evidence

`resolveNoteCreatePlan` receives `listDocuments(collection).map(d => d.relPath)` and
nothing else. For a target that is an existing container that set does not contain the
target, so `openedExisting` is false, `createdWithSuffix` is false, and the `error` policy
does not throw. Control reaches the create branch and `atomicWrite(fullPath, content)`
**replaces the existing container on disk**.

Concretely: capture to `sessions.jsonl` twice with `onCollision: "error"` and the second
call destroys the first file instead of erroring.

`capture()` is not affected the same way — it passes `diskRelPaths` from
`listCaptureDiskRelPaths` — but its receipt was a separate reporting bug, fixed in fn-114.

## Affected call sites

- `createNote()` — SDK `src/sdk/client.ts`; the `atomicWrite` is the overwrite
- REST `POST /api/docs` create — `src/serve/routes/api.ts` (`handleCreateDocument`); same
  indexed-only planning, guarded only by a `Bun.file(...).exists()` + `body.overwrite`
  check that does not implement the collision policies
- both duplicate paths — SDK `duplicateNote()` and MCP `gno_duplicate_note` / REST
  `POST /api/docs/:id/duplicate`, all via `planDuplicateRefactor({ existingRelPaths })`;
  the suffix-avoidance loop cannot see a container target
- `copyFile` — can overwrite an existing container target for the same reason

## Boundaries / non-goals

- Not a change to what a record adapter does or to how containers are indexed
- Not a change to fn-114's reconciliation, capture proof, or receipt wording
- Not a redesign of the collision policies themselves — the three existing policies keep
  their meanings; they must simply be *reachable* for these targets

## Acceptance Criteria

- **R1:** One definition of "a physical file already occupies this rel path" that is
  authoritative for WRITES — index rows plus effective source paths
  (`COALESCE(record_source_path, rel_path)`) plus disk — analogous to what
  `requireActiveCaptureDocument` established for the read-back proof.
- **R2:** That definition is applied by every create/duplicate/copy planner, so
  `error`, `open_existing`, and `create_with_suffix` mean the same thing on every surface.
- **R3:** Explicit semantics for an unindexed-but-present file and for a container:
  which policy each maps to, and whether `open_existing` on a container is meaningful at
  all, given it has no single document to open.
- **R4:** A no-clobber guarantee at the write itself — `atomicCreate` rather than
  `atomicWrite` unless the caller asked for `overwrite` — so a future planning miss
  cannot become data loss.
- **R5:** Coverage per surface for: container target, unindexed disk file, and each of
  `error` / `open_existing` / `create_with_suffix`.

## Open questions

- Does `open_existing` have a sensible meaning for a container? R3 must answer it rather
  than defaulting.
- Should `copyFile` share the planner, or is its contract deliberately lower-level?
- Is there an existing helper that already answers R1 for reads that can be lifted, or
  does this need a new authoritative seam?

## References

- `src/sdk/client.ts` — `createNote()` collision planning and the `atomicWrite`; the site
  now carries a comment recording exactly what it does and does not detect
- `src/serve/routes/api.ts` — `handleCreateDocument`, `POST /api/docs/:id/duplicate`
- `src/mcp/tools/workspace-write.ts` — `gno_duplicate_note`
- `src/ingestion/record-path.ts` — the virtual record path scheme
- Discovered during `fn-114-reliable-watcher-reconciliation-for` review, PR gmickel/gno#183
