---
satisfies: [R2, R6]
---
# fn-86-deferred-second-brain-maintenance-and.2 Add deterministic link integrity audit rules

## Description
Implement link-integrity rules over the shared read-only audit runner: broken/unresolved wiki and Markdown links, ambiguous targets, and policy-defined orphans with accurate inactive/ignored/mirror/external handling and batched query behavior.

**Size:** M
**Files:** `src/core/audit-links.ts`, `src/core/links.ts`, `src/store/sqlite/graph-link-resolver.ts`, `src/core/graph-edge-confidence.ts`, `test/audit/links.test.ts`

### Approach
- Reuse current parser and query-time resolver as authority; do not create a competing link grammar.
- Define orphan roots/ignore policy explicitly and classify inactive/renamed/mirrored documents conservatively.
- Batch/index link scans and expose truthful examined-row/timing metrics.
- Emit bounded evidence and remediation hints without modifying links.

### Investigation targets
**Required** (read before coding):
- `src/core/links.ts` — parsed link semantics
- `src/store/sqlite/graph-link-resolver.ts` — target resolution authority
- `src/core/graph-edge-confidence.ts` — existing graph diagnostics/confidence
- `test/store/links.test.ts` — ambiguous/path-style/incoming link fixtures
- `test/ingestion/sync-links.test.ts` — indexed link lifecycle

**Optional** (reference as needed):
- `src/store/sqlite/change-journal-store.ts:74-130` — heading/link delta evidence
- `test/cli/commands/links.test.ts` — current user-facing link output

### Key context
External URLs are not broken local links. “Orphan” depends on explicit roots/ignore policy. Inactive or renamed records cannot be mislabeled without resolver evidence.

## Acceptance
- [ ] Broken, unresolved, ambiguous, and policy-defined orphan findings use stable IDs and exact resolver evidence.
- [ ] External, ignored, inactive, renamed, duplicate/mirror, path-style wiki, fragment, and malformed cases are explicitly classified without false clean results.
- [ ] Output is deterministic and bounded; truncation preserves total counts/completeness semantics.
- [ ] Benchmarks/query assertions prove batched/indexed scans with truthful examined-row/timing metrics and no per-finding full-table scan.
- [ ] No-write unit/store/CLI fixture tests and lint pass.


## Done summary
Added deterministic link-integrity auditing over a bounded set-oriented snapshot. The audit reuses the graph resolver for exact, inferred, ambiguous, and unresolved evidence; applies explicit root, ignore-prefix, and mirror-duplicate orphan policy; excludes external parser boundaries; preserves exact totals under truncation; and proves read-only indexed/batched behavior.
## Evidence
- Commits: bea024cb
- Tests: bun test test/audit/links.test.ts test/audit/report.test.ts test/store/links.test.ts test/ingestion/sync-links.test.ts (78 pass), bun run lint:check
- PRs: