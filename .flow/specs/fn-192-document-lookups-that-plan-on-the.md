# Document lookups that plan on the active index

## Goal & Context

SQLite has no statistics for GNO's index (no `ANALYZE`, no `sqlite_stat1`). For a query shaped `WHERE <column> = ? AND active = 1` it can choose `idx_documents_active`, which matches nearly every row, over the selective index. fn-186 fixed four such queries in record sync with `INDEXED BY`. The same plan still appears for `mirror_hash` lookups:

- `SELECT ... FROM documents WHERE mirror_hash = ? AND active = 1` (`src/store/sqlite/adapter.ts`)
- `SELECT ... FROM documents WHERE mirror_hash IN (...) AND active = 1` (`src/mcp/tools/links.ts`)
- the correlated `EXISTS (SELECT 1 FROM documents d WHERE d.mirror_hash = c.mirror_hash AND d.active = 1)` per chunk in `src/cli/commands/embed.ts`, `src/sdk/embed.ts`, and `src/store/vector/stats.ts`

`EXPLAIN QUERY PLAN` against a real index shows `SEARCH documents USING INDEX idx_documents_active (active=?)` for all three shapes. The correlated form costs roughly chunks x active documents.

## Acceptance Criteria

- **R1:** Every query on `documents` that filters on a selective indexed column plus `active = 1` plans on the selective index. A test asserts the plan (via `EXPLAIN QUERY PLAN`) for each shape listed above and for any other instance found by an audit of `src/`.
- **R2:** Measure the embedding/vector-stats path before and after on a synthetic index large enough to show the difference (for example 20k documents), and record the numbers in the spec. Results are unchanged: same backlog counts, same vector stats, same link results.
- **R3:** Choose the smallest fix that holds: `INDEXED BY` as in fn-186, or dropping/replacing `idx_documents_active` if the audit shows it serves no query. Document the choice.

## Boundaries

- No schema change beyond index adjustments; no change to query results.
- No `ANALYZE` scheduling unless R3 shows it is the smaller, reliable fix.
