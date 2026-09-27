# fn-139-gno-status-stops-listing-removed.1 Implement gno status stops listing removed collections with only inactive rows

## Description
TBD

## Acceptance
Satisfies the spec's goal, requirements and triage notes; judge against the spec directly.

## Done summary
`gno status` no longer lists a collection removed from config. `SqliteAdapter.getStatus` takes an optional `configuredCollections` list and limits the collection list and the document and chunk totals to those names. CLI status, REST `/api/status`, MCP `gno_status` and SDK `status()` pass their config's names. `totalChunks` now counts only distinct chunks of active documents, so chunks left by deleted files no longer count.

Approach: status filters by the caller's config and stays read-only. The other option, having `gno collection remove` sync the DB table, would need a DB write from a config-only command, could conflict with a resident writer, and would still miss collections removed by editing the config by hand.

Tests (each failed on origin/main first):
- test/store/adapter.test.ts: removed collection with active rows and with inactive rows; checks the collection list, active docs and chunk total.
- test/cli/status.test.ts: end to end, `collection remove` then `status --json`.
- test/serve/api-status.test.ts and test/mcp/tools/status.test.ts: configured names reach getStatus.
- test/store/variant-status.test.ts: pinned total changed from 3 to 2 on purpose. The fixture's inactive document chunk no longer counts, which is the chunk-total fix in the triage.

Docs: spec/cli.md, status schema descriptions (no shape change), docs/CLI.md, CHANGELOG [Unreleased] Fixed.

Live QA (isolated roots, before on an origin/main worktree, after on this branch): .flow/tmp/qa-fn-139-gno-status-stops-listing-removed/{before,after}-{cli,serve}.txt. Before: the removed collection was listed with active rows (documentCount 1) and with inactive rows (documentCount 0), and the text output showed "Total: 1 documents, 9 chunks". After: only `keep` is listed, with "Total: 1 documents, 1 chunks". REST /api/status after the change reports totals 2 docs / 2 chunks; before, it reported 2 / 3.

Follow-up, not fixed here: a `gno serve` that is already running keeps its in-memory config, so a collection removed through the CLI stays in its /api/status until serve restarts. Serve adopts external config changes only on the sessions routes. That is a separate issue about config adoption.

stage: impl-review - skipped(config: REVIEW_MODE=none; repo rules skip review stages)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 77636730db9b4c358c3298f226e945a81f88d9ba
- Tests: bun run lint:check, bun test (5904 pass, 3 skip, 0 fail), bun run docs:verify, live QA: .flow/tmp/qa-fn-139-gno-status-stops-listing-removed/{qa,serve-qa}.sh before/after
- PRs: