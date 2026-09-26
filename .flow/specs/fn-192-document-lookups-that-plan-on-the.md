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

## Resolution (fn-192.1)

**Audit (R1).** Every SQL statement on `documents` that touches `active`, captured from a full `bun test` run (340 distinct statements, 306 explainable standalone), was planned against a freshly migrated index. 221 of the 306 planned on `idx_documents_active`, far more than the three shapes above: point lookups, `IN` lists, correlated EXISTS and title subqueries, joins keyed on `id` or `mirror_hash`, graph and link resolvers, and eligibility filters. No query filters on inactive documents (`active = 0`), so the index only ever served `active = 1`, which matches nearly every row.

**Choice (R3).** Migration 033 drops `idx_documents_active`. It is one change, where `INDEXED BY` would have meant more than 200 call sites, and it also covers queries written later. With the index gone, each of the 221 statements plans on the primary key, a selective index, or (where `active = 1` is the only filter) a scan that replaces an equally full index walk. No nested loop gets worse. Four statements pair a `mirror_hash` filter with `collection = ?`; once the active index is gone, they planned on a collection index, which in a one-collection index also matches every row. Those four keep a fn-186-style `INDEXED BY idx_documents_mirror_hash` pin: the collection-scoped EXISTS in `src/store/vector/stats.ts` and `src/cli/commands/embed.ts`, `getDocumentsByMirrorHashes` in `src/store/sqlite/adapter.ts`, and `buildEligibleDocumentQuery` in `src/store/sqlite/eligibility.ts` when `allowedMirrorHashes` is set. After the fix, a sweep of 308 explainable statements found none on `idx_documents_active`, and every statement carrying the `allowedMirrorHashes` predicate is pinned. `test/store/document-active-plans.test.ts` asserts the plans for the spec's shapes and, from the SQL the code actually emits, for the three pinned code paths. No `ANALYZE`.

**Measurements (R2).** Synthetic index: 20,000 documents (5% inactive), one chunk each, half embedded, Bun 1.4.2. "Before" recreates the index and strips the new pins, which reproduces the pre-fix statements. "After" is the current code. Before arm: one run. After arm: median of five.

| Operation | Before | After | Results identical |
|---|---:|---:|---|
| vector stats `countBacklog` | 10.03 s | 11.77 ms | yes |
| vector stats `countBacklog` (collection) | 10.85 s | 11.86 ms | yes |
| vector stats `getBacklog` limit 1000 | 119.13 ms | 2.12 ms | yes |
| vector stats `getBacklog` limit 1000 (collection) | 121.56 ms | 2.03 ms | yes |
| `gno embed --force` active chunk count | 21.86 s | 6.64 ms | yes |
| `gno embed --force` active chunk count (collection) | 22.35 s | 6.38 ms | yes |
| links `mirror_hash IN` x200 | 4.30 ms | 0.19 ms | yes |
| `getDocumentsByMirrorHashes` x200 (collection) | 6.13 ms | 0.63 ms | yes |
| eligibility `allowedMirrorHashes` x200 (collection) | 4.04 ms | 0.13 ms | yes |
| `mirror_hash = ?` lookup x1000 | 2.24 s | 2.99 ms | yes |
| count active documents (no selective filter) | 0.40 ms | 0.15 ms | yes |

The last row checks the one kind of query the dropped index could have helped: a count on `active` alone, previously covered by the index. It did not get slower. Evidence (plans, sweep, benchmark script and output) is in `.flow/tmp/qa-fn-192-document-lookups-that-plan-on-the/`, which is gitignored.
