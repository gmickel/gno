---
satisfies: [R2, R3, R4, R9, R10, R11]
---
# fn-114-reliable-watcher-reconciliation-for.2 Add bounded directory-enumeration and active-document store seams

## Description
Build the two bounded query seams the watcher needs, with their own focused tests, so
task `.3` only has to wire and coalesce. Neither seam touches `src/serve/`.

1. **Single-level eligible-children enumeration.** Given a collection and a directory
   relative path (the collection root is `""`), return the eligible **direct children**
   relative paths. No existing helper does this: `FileWalker.walk` always recurses from
   the collection root and has no depth bound.
2. **Active indexed direct children.** A narrow store query returning the *effective
   source paths* of ACTIVE documents in a collection that are direct children of a
   given directory. `listDocuments` is inadequate — it returns the whole collection
   table including inactive rows, with no path bound.

   The effective source path is `COALESCE(record_source_path, rel_path)`, DISTINCT.
   Record-container documents (JSONL/transcript exports) are stored under virtual
   paths (`isRecordVirtualPath`, `src/ingestion/record-path.ts:14`) while their
   physical input lives in `documents.record_source_path` (`spec/db/schema.sql:115`).
   `syncPaths` stats physical paths, so returning virtual paths would either lose them
   in the `matchesWalkPath` filter or stat files that do not exist — and deleting an
   eligible record container would leave all its logical records active.

**Size:** M
**Files:**
- new helper alongside `src/ingestion/walker.ts` (or exported from it), re-exported via
  `src/ingestion/index.ts` following the existing `matchesWalkPath` export at `:34`
- `src/store/types.ts` — the new `StorePort` method signature
- `src/store/sqlite/adapter.ts` — the implementation
- `src/store/migrations` — one migration adding the indexed parent key
- `spec/db/schema.sql` — schema kept in sync with the migration
- `test/ingestion/` — enumeration tests
- `test/store/` — store query tests

### Approach

- Enumeration: read the directory with `node:fs/promises.readdir(absDir, { withFileTypes: true })`
  (Bun has no native readdir; comment the `node:*` import per CLAUDE.md), then filter
  each candidate through the SAME `matchesWalkPath(relPath, collectionToWalkConfig(collection, maxBytes))`
  the watcher already uses. Do not fork the eligibility rules.
- Preserve root containment with the existing `safeRelPath` semantics
  (`src/ingestion/walker.ts:125-144`) and POSIX-normalize separators, matching the
  watcher's `replaceAll("\\","/")` at `watch-service.ts:199`.
- Match `FileWalker.walk`'s existing symlink behavior exactly — confirm what it does at
  `walker.ts:227-318` before choosing; do not invent new symlink semantics here.
- The query MUST be index-served (R11). A direct-child predicate over
  `COALESCE(record_source_path, rel_path)` is not servable by today's indexes: the
  active-path index binds `collection` only, so the plan degrades to a full scan of the
  collection's active rows plus a temporary B-tree for `DISTINCT`, and the
  collection-root case (`""` as parent) is not a prefix range at all. Add an indexed
  parent key via one migration:
  - preferred: a `source_parent_path` column holding the parent directory of
    `COALESCE(record_source_path, rel_path)` (`""` at the collection root), plus a
    partial index on `(collection, source_parent_path)` restricted to active rows.
    A `VIRTUAL` generated column can be added by `ALTER TABLE` and indexed; the SQLite
    idiom for "strip the last path segment" is
    `substr(p, 1, length(rtrim(p, replace(p, '/', ''))) - 1)` guarded by
    `instr(p, '/') = 0 → ''`. Verify that expression against real fixtures before
    committing to it.
  - acceptable alternative: a plain maintained column written by the adapter wherever
    `rel_path` / `record_source_path` is written, backfilled in the migration. If you
    take this route, a test must pin the invariant that every write path keeps it in
    sync — a stale parent key silently loses documents.
  Either way the lookup becomes an equality probe for both root and nested directories,
  and `spec/db/schema.sql` is updated to match the migration.
- Mirror the shape and error handling of the neighbouring adapter methods
  (`StoreResult<...>`, no throwing); return DISTINCT effective source paths.
- Reject a directory argument that escapes the collection root; return an explicit
  empty/failed result rather than enumerating outside it.

### Investigation targets

**Required:**
- `src/ingestion/walker.ts:125-144` (`safeRelPath`), `:182-219` (`matchesWalkPath`),
  `:227-318` (`FileWalker.walk` — symlink + maxBytes handling to match)
- `src/ingestion/types.ts:293+` — `collectionToWalkConfig`
- `src/core/path-rules.ts:31-53` — `matchesCollectionExclusion`
- `src/store/types.ts:1346+` (`StorePort`), `:1605` (`listDocuments` — the inadequate
  seam), and the `DocumentRow.active` field
- `src/store/sqlite/adapter.ts:1513-1535` (`listDocuments` impl to mirror),
  `:1670-1673` (`markInactive`)

**Optional:**
- `spec/db/schema.sql` — existing indexes on `documents`

### Key context

- The collection ROOT is a legitimate directory key, represented as `""`. Both seams
  must handle it — a file saved directly in the collection root is the common case.
- The enumeration outcome is a THREE-state discriminated result, not an array:
  `present(paths)` / `missing` / `error(cause)`. "Gone" and "unreadable" need opposite
  watcher behavior and must not collapse into one empty array.
  - `missing` (ENOENT / ENOTDIR — the directory is genuinely gone): the caller
    continues with the active-indexed side so the children deactivate.
  - `error(cause)` (EACCES / EIO / anything transient): fail CLOSED — the caller must
    not infer deactivation from it — and preserve the cause for diagnostics.
  Neither may throw into a watch callback (R9). Deciding this contract here is the
  point of splitting the task out.
- Do NOT call `markInactive` from these seams. `syncPaths` owns deactivation.

### Acceptance

- [ ] Enumeration helper returns only eligible direct children of the given directory,
      applying the current collection `pattern`/`include`/`exclude`, dotfile, temporary,
      and reserved-path rules via the existing `matchesWalkPath` — no forked rules
- [ ] Enumeration handles the collection root (`""`), nested subdirectories, and refuses
      a directory argument that escapes the collection root
- [ ] Enumeration does not recurse: files in nested subdirectories of the target
      directory are not returned
- [ ] Enumeration symlink behavior matches `FileWalker.walk`; parity documented in the
      task evidence
- [ ] Store query returns relative paths of ACTIVE documents that are direct children of
      the given directory in the given collection, and excludes inactive rows, other
      collections, and deeper descendants
- [ ] Enumeration returns `present` / `missing` / `error(cause)` as three distinct
      outcomes, with separate tests for each, and never throws
- [ ] A store-query failure returns an explicit non-throwing failure result
- [ ] Store query returns the effective source path `COALESCE(record_source_path, rel_path)`
      DISTINCT, covered by tests for: several active logical records sharing one source
      container; inactive records excluded; the container deleted; the container
      atomically replaced
- [ ] A migration adds the indexed parent key and `spec/db/schema.sql` matches it
- [ ] `EXPLAIN QUERY PLAN` captured as evidence for BOTH the collection-root lookup and
      a nested-directory lookup, showing the parent bound used by the index, with no
      full collection scan and no `USE TEMP B-TREE FOR DISTINCT`
- [ ] If a maintained (non-generated) column was chosen, a test pins that every write
      path keeps it in sync
- [ ] Focused tests under `test/ingestion/` and `test/store/` cover each bullet above
- [ ] `bun test test/ingestion/ test/store/`, `bun run lint:check`, and
      `bun run typecheck` pass

## Acceptance
- [ ] Direct-children enumeration returns only eligible immediate children, reusing matchesWalkPath
- [ ] Collection root ("") and nested directories both handled; root-escaping arguments refused
- [ ] Enumeration is non-recursive and matches FileWalker.walk symlink behavior
- [ ] Store query returns active direct-child relPaths only; inactive rows, other collections, and deeper descendants excluded
- [ ] Missing/unreadable directory and store failure return explicit non-throwing results
- [ ] Index coverage verified or documented
- [ ] Tests added under test/ingestion/ and test/store/
- [ ] bun test test/ingestion/ test/store/, lint:check, and typecheck pass


## Done summary
Added the two bounded query seams the watcher's directory reconciliation needs:
`listEligibleDirectChildren` (single-level, non-recursive, three-state
present/missing/error outcome, eligibility delegated to the existing
`matchesWalkPath`) and `StorePort.listActiveDirectChildSourcePaths` (DISTINCT
effective source paths of active direct children, so record containers resolve to
their physical path), backed by migration 027's partial expression index that
makes both the collection-root and nested lookups index-served equality probes
with no full collection scan and no temporary B-tree for DISTINCT.
## Evidence
- Commits: 871bbcb10eb41bf5993e8ff59f516a2a4438d0a7
- Tests: bun test test/ingestion/ test/store/ (449 pass, 0 fail), bun run lint:check (0 warnings, 0 errors; format clean), bunx tsc --noEmit (clean), baseline: green for bun test test/ingestion/ test/store/ (418 pass), lint:check, tsc at 35b7b3cf, bun test test/cli -> 189 pre-existing failures, CONDUCTOR-VERIFIED as unrelated: macOS-only, both sample files pass in isolation; cause is Database.setCustomSQLite() losing the race in a shared-process directory run, so fts5stemmer.dylib cannot load. Green at base commit in the same way. Filed separately.
- PRs: