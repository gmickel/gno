---
satisfies: [R1, R2, R3, R4]
---

# fn-161-align-embedding-status-with-active.1 Fix authoritative embedding status and regression coverage

## Description
Implement R1-R3 of the parent spec; host owns R4 release and downstream documentation reconciliation. Inspect variant identity/activation contracts before choosing the shared read-only status implementation.

Touches: src/store/sqlite/adapter.ts, src/store/vector/**, src/cli/commands/status.ts, src/serve/status.ts only if required, test/store/**, test/cli/status*, test/serve/status*, and new narrowly scoped status regression fixtures. Avoid unrelated files.

Quick: focused status/vector regression suites, bun run lint:check. Use Bun 1.4.2 from node_modules/.bin/bun, not the host default 1.3.14.

## Acceptance
- [ ] Complete verified variants with missing legacy vectors report zero backlog and correct collection counts.
- [ ] Missing/changed owners, stale partition identity, shared content and inactive documents behave correctly; legacy path remains covered.
- [ ] Status performs no model load, vector mutation or forced regeneration.
- [ ] Focused tests and lint pass. Host validates read-only live status and release gates.

## Done summary
Shared SQLite status now validates current document/chunk owners against the selected verified embedding partition. Normal embedding records its resolved selection in schema_meta; pre-existing unambiguous activated partitions work without rewriting the index. Collection counts retain distinct content chunks and require all active owners to be covered; backlog counts pending owners. Unscoped status accepts coverage from any resolved model, without mixing alternative partitions of the same model.

R1/R2/R3 regression evidence: test/store/variant-status.test.ts covers complete variants with missing/stale legacy data, query-only status reads, changed titles/text, missing owners, shared content/collections, inactive documents, stale epochs, ambiguous partitions, complete/partial selected replacements, missing selection targets, explicit model/fingerprint scopes, unselected shadow legacy fallback, and unscoped multiple-model coverage. test/embed/variant-backlog.test.ts verifies that actual embedding preparation persists and updates the selected partition when runtime context changes. CLI/API consumers already use the shared adapter and required no output changes.

baseline: green — bun test test/store (275 passed) and bun run lint:check; Bun 1.4.2.
Verification: combined store/embed/CLI/API suites passed 342 tests; final focused status suite passed 6 tests. bun run lint:check passed (26 inherited warnings, zero errors), including the commit hook. Canonical post-commit store gate result is recorded in evidence. No models were loaded by status, and no real user database was mutated by this worker.

Limits: status reports last-resolved persisted identity, not unobserved external model/runtime changes. Old ambiguous same-model partitions conservatively remain pending until normal embedding records selection. Shadow coverage reports embedding completeness independently from semantic search availability. Host owns full release gates, live CLI/API/site QA, downstream reconciliation, release and publication.

stage: impl-review - skipped(config: REVIEW_MODE=none)
## Evidence
- Commits: b42a7191ff4223534907b1ed30ad4ee456a69769
- Tests: baseline: green — bun test test/store (275 pass); bun run lint:check, bun test test/store test/embed test/cli/embed.test.ts test/cli/status.test.ts test/serve/api-status.test.ts (342 pass, 0 fail), bun test test/store/variant-status.test.ts (6 pass, 0 fail), bun run lint:check (pass; 26 inherited warnings, 0 errors), bun test test/store (post-commit: 281 pass, 0 fail; green receipt b42a7191-unittest)
- PRs: