# Graph reconciliation oracle v1

Synthetic sources only. `manifest.json` pins the complete materialized mutation
sequence, graph hint configurations and size inventory independently of the
unchanged fn-143 acceptance pins. No models or user indexes are opened.

`fullRebuild` creates a separate database and source directory for each state,
ingests the complete corpus and runs global typed-edge reconciliation. The paired
fn-143 comparator checks URI-normalized typed edge tuples and supported graph
unresolved/ambiguity diagnostics for global, targets and outside scopes. No target
URI, confidence or diagnostic is discarded. Repeated public graph reads must
preserve their exact ordering; fresh-index row IDs are not compared.

The mutation driver preserves relative source insertion precedence in the fresh
index. Existing ambiguous resolution depends on document IDs; a fresh filesystem
walk in alphabetical order can select a different duplicate. That is an existing
ordering dependency, not evidence of an incremental invalidation defect. The
oracle copies neither projected edges nor numeric row IDs from the candidate.

Cases include unresolved outside incoming references, target add/delete/restore,
unique-to-ambiguous-to-unique transitions, rename, title change to a previously
unresolved identity, configuration changes and source disappearance. Deliberate
selected-collection-only and old-identity-only projections must be rejected.

The unchanged scoped-sync characterization counts actual `getContent` calls and
SQLite INSERT/DELETE/UPDATE triggers on `doc_edges`:

| Documents | Content reads | Deleted rows | Inserted rows | Updated rows |
| --------- | ------------: | -----------: | ------------: | -----------: |
| 101       |           101 |          100 |           100 |            0 |
| 1001      |          1001 |         1000 |          1000 |            0 |
| 5001      |          5001 |         5000 |          5000 |            0 |

These are baseline reproduction assertions, not desired golden performance.
Incremental implementation must replace the production-path expectation with its
new measured budget while retaining this baseline evidence. No timing here is
attributed to the earlier private-vault index measurement.

Current identical-source restoration can remain inactive. The mutation test
accepts either strict equality after that bug is fixed or the exact enumerated
legacy comparator rejection. This is a negative characterization, not acceptance
of missing edges. All other states require equality. Later implementation tasks
must remove that legacy branch when restoration is corrected.

This task does not validate crash recovery, CLI/MCP/API visibility, broad-change
cost, or final incremental performance; those remain dependent-task QA gates.
