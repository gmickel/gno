/**
 * Shared SQL fragments for the document "effective source path" and its parent
 * directory key.
 *
 * A document's effective source path is `COALESCE(record_source_path, rel_path)`:
 * record-container documents (JSONL/transcript exports) are stored under virtual
 * `#record/...` paths while their physical input lives in `record_source_path`.
 * Any filesystem-facing lookup must use the physical path.
 *
 * The parent expression and the partial index below are deliberately defined in
 * ONE place: migration 027 creates the index from `CREATE_SOURCE_PARENT_INDEX_SQL`
 * and the adapter queries with `ACTIVE_DIRECT_CHILD_SOURCE_PATHS_SQL`, which is
 * built from the same expression strings. SQLite matches expression indexes
 * structurally, so a textual drift between the two would silently degrade the
 * lookup into a full collection scan. `test/store/source-parent-index.test.ts`
 * pins the query plan.
 *
 * @module src/store/source-path-sql
 */

/** Effective (physical) source path of a document row. */
export const SOURCE_PATH_EXPR = "COALESCE(record_source_path, rel_path)";

/**
 * Parent directory of the effective source path, POSIX-style, with the
 * collection root represented as the empty string.
 *
 * `replace(p, '/', '')` yields every character of `p` except the separators, so
 * `rtrim(p, <that>)` strips the trailing final segment and leaves `p` up to and
 * including its last `/`. Dropping that trailing separator gives the parent.
 * A path with no separator is a direct child of the collection root.
 */
export const SOURCE_PARENT_PATH_EXPR = `CASE WHEN instr(${SOURCE_PATH_EXPR}, '/') = 0 THEN '' ELSE substr(${SOURCE_PATH_EXPR}, 1, length(rtrim(${SOURCE_PATH_EXPR}, replace(${SOURCE_PATH_EXPR}, '/', ''))) - 1) END`;

/** Name of the partial expression index backing the direct-children lookup. */
export const SOURCE_PARENT_INDEX_NAME = "idx_documents_source_parent_path";

/**
 * Partial expression index making the active direct-children lookup an equality
 * probe for both the collection root and nested directories. The trailing
 * source-path column keeps `DISTINCT` satisfiable from index order, so SQLite
 * needs no temporary B-tree.
 */
export const CREATE_SOURCE_PARENT_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${SOURCE_PARENT_INDEX_NAME}
  ON documents(collection, ${SOURCE_PARENT_PATH_EXPR}, ${SOURCE_PATH_EXPR})
  WHERE active = 1`;

/** Drop statement for the parent index (migration rollback). */
export const DROP_SOURCE_PARENT_INDEX_SQL = `DROP INDEX IF EXISTS ${SOURCE_PARENT_INDEX_NAME}`;

/**
 * Distinct effective source paths of ACTIVE documents that are direct children
 * of a given directory in a given collection. Parameters: `collection`,
 * `parentDirRelPath` (`""` for the collection root).
 */
export const ACTIVE_DIRECT_CHILD_SOURCE_PATHS_SQL = `SELECT DISTINCT ${SOURCE_PATH_EXPR} AS source_path
   FROM documents
   WHERE collection = ? AND ${SOURCE_PARENT_PATH_EXPR} = ? AND active = 1`;

/**
 * Effective source paths of every ACTIVE document in a collection.
 *
 * This is deliberately the whole-collection answer the bounded seams below
 * exist to avoid, and it has exactly ONE caller condition: the collection ROOT
 * was observed absent from disk. A removed root is a whole-collection event, so
 * the honest indexed side for it is every active document - the descendant seam
 * cannot express it (a `""` prefix range has no bound) and the direct-children
 * seam answers only the root's own files, stranding every nested document.
 *
 * Deduplicated by the caller rather than with `DISTINCT`, matching the batched
 * statements below: a record container's many logical rows collapse to one
 * physical source path in memory.
 *
 * Parameters: `collection`.
 */
export const ACTIVE_COLLECTION_SOURCE_PATHS_SQL = `SELECT ${SOURCE_PATH_EXPR} AS source_path
   FROM documents
   WHERE collection = ? AND active = 1`;

/**
 * Effective source paths of ACTIVE documents anywhere beneath a directory -
 * direct children AND deeper descendants.
 *
 * Used when a dirty directory is GONE from disk: the whole removed subtree has
 * to deactivate, and a direct-children lookup would strand everything nested
 * below it (the limitation fn-114 originally documented as R12).
 *
 * Bounds, in order of what each one is for:
 *
 * - `parent >= :dir AND parent < :dirUpper` is the INDEX-DRIVING range. Every
 *   descendant's parent directory is either `dir` itself or starts with
 *   `dir/`, and `'/'` (0x2F) is immediately below `'0'` (0x30), so appending
 *   `'0'` to `dir` is the tight exclusive upper bound of that whole family.
 * - the `= :dir OR substr(...) = :dirPrefix` residual is the CORRECTNESS
 *   filter. The range alone also spans sibling names that merely share the
 *   prefix and sort below `dir/` (`dir1!x`, `dir1.x`, and - crucially - it must
 *   not be widened into a bare `LIKE 'dir1%'`, which would swallow `dir10`).
 *   It runs over the handful of rows the range already isolated.
 *
 * No `DISTINCT`: over a range the parent expression cannot satisfy it from
 * index order, and SQLite would add `USE TEMP B-TREE FOR DISTINCT`, which R11
 * forbids. The adapter dedupes in memory, exactly as the batched
 * direct-children statement does.
 *
 * Parameters: `collection`, `dir`, `dir || '0'`, `dir`, `length(dir) + 1`,
 * `dir || '/'` - see {@link activeDescendantSourcePathParams}.
 */
export const ACTIVE_DESCENDANT_SOURCE_PATHS_SQL = `SELECT ${SOURCE_PATH_EXPR} AS source_path
   FROM documents INDEXED BY ${SOURCE_PARENT_INDEX_NAME}
   WHERE collection = ?
     AND ${SOURCE_PARENT_PATH_EXPR} >= ?
     AND ${SOURCE_PARENT_PATH_EXPR} < ?
     AND (${SOURCE_PARENT_PATH_EXPR} = ?
          OR substr(${SOURCE_PARENT_PATH_EXPR}, 1, ?) = ?)
     AND active = 1`;

/**
 * Bind parameters for {@link ACTIVE_DESCENDANT_SOURCE_PATHS_SQL}.
 *
 * `dir` must already be normalized and non-empty; the collection root has no
 * meaningful "subtree" bound and is never queried this way.
 */
export function activeDescendantSourcePathParams(
  collection: string,
  dir: string
): [string, string, string, string, number, string] {
  const prefix = `${dir}/`;
  // '/' + 1 === '0': the first string that sorts above every `dir/...` path.
  const upperBound = `${dir}0`;
  return [collection, dir, upperBound, dir, prefix.length, prefix];
}

/**
 * Batched form of the descendant lookup: the removed-subtree answer for several
 * directories in one statement, tagged with the key it belongs to.
 *
 * The keys arrive as a `VALUES` co-routine and drive a nested loop, so each key
 * contributes its OWN bounded range probe of the parent index rather than one
 * shared scan - `EXPLAIN QUERY PLAN` shows `SEARCH documents USING INDEX
 * idx_documents_source_parent_path (collection=? AND <expr>>? AND <expr><?)` at
 * every key count, never `SCAN documents` and never a temp B-tree.
 *
 * The watcher needs the batch because a whole flush's ambiguous hints must be
 * discriminated at once: a vanished name is either a dead temp file or a
 * recursively deleted directory, and only the indexed side tells them apart.
 * Asking per hint would put one query behind every unique temp filename.
 *
 * Parameters: the `dirCount` directory keys, then `collection`.
 */
export function activeDescendantSourcePathsBatchSql(dirCount: number): string {
  const values = Array.from({ length: dirCount }, () => "(?)").join(", ");
  return `WITH keys(k) AS (VALUES ${values})
   SELECT keys.k AS key, ${SOURCE_PATH_EXPR} AS source_path
   FROM keys JOIN documents INDEXED BY ${SOURCE_PARENT_INDEX_NAME}
     ON documents.collection = ?
    AND ${SOURCE_PARENT_PATH_EXPR} >= keys.k
    AND ${SOURCE_PARENT_PATH_EXPR} < keys.k || '0'
    AND (${SOURCE_PARENT_PATH_EXPR} = keys.k
         OR substr(${SOURCE_PARENT_PATH_EXPR}, 1, length(keys.k) + 1) = keys.k || '/')
   WHERE documents.active = 1`;
}

/**
 * Directory keys per batched statement.
 *
 * SQLite's `SQLITE_LIMIT_VARIABLE_NUMBER` defaults to 999; one parameter is
 * spent on `collection`. This is a STATEMENT-SHAPE bound, not a work budget:
 * every requested directory is queried, just across more than one statement
 * once there are more than this many of them. Nothing is ever dropped.
 */
export const ACTIVE_DIRECT_CHILD_BATCH_CHUNK = 898;

/**
 * Batched form of the direct-children lookup: the active effective source paths
 * of several directories in one statement, tagged with their parent directory.
 *
 * Two deliberate differences from the single-directory statement above:
 *
 * - `INDEXED BY` pins the plan. Measured on a 800-row/ANALYZE-d database, an
 *   unhinted `IN (...)` list of 26 keys made SQLite prefer
 *   `idx_docs_wiki_relpath_resolve (collection=?)` - still a SEARCH, but a
 *   collection-wide one that reads every active row of the collection. R11
 *   requires the parent index specifically, and a hint is the only way to get
 *   it deterministically at every IN-list size.
 * - No `DISTINCT`. Across several IN values SQLite cannot satisfy `DISTINCT`
 *   from index order alone and adds `USE TEMP B-TREE FOR DISTINCT`, which R11
 *   forbids. The caller dedupes per directory in memory instead - the same
 *   collapse of a record container's many logical rows to one physical source
 *   path (R10), performed one layer up.
 */
export function activeDirectChildSourcePathsBatchSql(dirCount: number): string {
  const placeholders = Array.from({ length: dirCount }, () => "?").join(", ");
  return `SELECT ${SOURCE_PARENT_PATH_EXPR} AS parent_path, ${SOURCE_PATH_EXPR} AS source_path
   FROM documents INDEXED BY ${SOURCE_PARENT_INDEX_NAME}
   WHERE collection = ? AND ${SOURCE_PARENT_PATH_EXPR} IN (${placeholders}) AND active = 1`;
}
