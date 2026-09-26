---
satisfies: [R1, R2, R3]
---
# fn-192-document-lookups-that-plan-on-the.1 Implement Document lookups that plan on the active index

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Migration 033 drops `idx_documents_active`. Without planner statistics, SQLite chose that near-universal index over selective ones: an audit of every statement executed by the test suite found 221 of 306 plans on it, and no query that filters on inactive documents. Four statements that pair a `mirror_hash` filter with `collection = ?` keep an `INDEXED BY idx_documents_mirror_hash` pin: the collection-scoped EXISTS in vector stats and `gno embed --force`, `getDocumentsByMirrorHashes`, and eligibility when `allowedMirrorHashes` is set. On a 20,000-document synthetic index the backlog count drops from 10.03 s to 11.77 ms and the `--force` chunk count from 21.86 s to 6.64 ms, with identical results. The full table, audit method, and R3 rationale are in the spec's "Resolution (fn-192.1)" section.

Tests: `test/store/document-active-plans.test.ts` asserts EXPLAIN plans for the spec's shapes. For the three pinned code paths it plans the SQL the code actually emits, and those cases fail when the pins are reverted. Three test pins changed with the new migration version (clipper-store and runtime-compat applied lists, chunking-policy schema identity), and the `stats.test.ts` minimal schema gained the production `idx_documents_mirror_hash`.

Environment: /tmp (tmpfs) is at its per-user quota (EDQUOT). All gates ran with TMPDIR=/home/gordon/.cache/gno-test-tmp/fn-192.

Follow-up (not built): the collection-count pin in the private `getActiveChunkCount` in `src/cli/commands/embed.ts` has plan coverage only through the identical literal shape in the test, not through the function itself.

stage: impl-review - skipped(policy: conductor owns the review gate)
## Evidence
- Commits: 6b128f753f03c2861080b8e87f0a0c73b9bef1ad
- Tests: bun run lint:check (TMPDIR=/home/gordon/.cache/gno-test-tmp/fn-192): rc 0, 0 errors, 42 warnings (baseline count), bun run docs:verify: rc 0, bun test (TMPDIR=/home/gordon/.cache/gno-test-tmp/fn-192): 5827 pass, 3 skip, 0 fail, bun test test/store/document-active-plans.test.ts: 9 pass; 3 pinned-path cases fail with pins reverted (red-first check), baseline: green (bun run lint:check rc 0; bun test 5818 pass 0 fail pre-edit)
- PRs: