---
satisfies: [R1, R3, R7]
---
# fn-100-private-retrieval-learning-loop.1 Add opt-in trace storage retention and redaction

## Description
Deliver add opt-in trace storage retention and redaction as one implementation-sized increment.

**Size:** M
**Files:** `src/store/migrations/012-retrieval-traces.ts`, `src/store/types.ts`, `src/store/sqlite/adapter.ts`, `src/core/retrieval-trace.ts`, `test/store/retrieval-traces.test.ts`

### Approach
- Store versioned trace/run/event/judgment records with idempotency keys, source hashes, and bounded retention; default recording off.
- Define field-level redaction for queries, filters, IDs, URLs, spans, and paths while retaining explicit replay-capable mode only with user consent.
- Provide purge that transactionally removes traces/events/exports and reports exact counts.

### Investigation targets
**Required** (read before coding):
- `src/store/migrations/index.ts:1-40`
- `src/store/types.ts`
- `src/store/sqlite/adapter.ts`
- `src/core/user-dirs.ts`

**Optional** (reference as needed):
- `src/core/job-manager.ts`
- `src/core/errors.ts`

### Key context
- Non-click/open absence is not negative feedback; only explicit judgments are relevance labels.
- Redacted traces may be diagnostic-only; replay capability must be declared per receipt.

## Acceptance
- [ ] Recording is off by default and storage/retention/redaction modes are schema-validated.
- [ ] Concurrent duplicate events settle once and retention caps remain deterministic.
- [ ] Inspect/delete/full-purge tests prove no orphaned trace content or hidden network calls.


## Done summary
Implemented opt-in private retrieval trace storage with strict metadata/replay redaction, migration v14, atomic idempotency, deterministic bounded retention, exact cascade deletion, physical purge receipts, closed evidence schemas, and documented configuration/database contracts. Independent review: SHIP. Commit: 0902389.
## Evidence
- Commits:
- Tests: bun run lint:check, bun test test/store/adapter.test.ts test/store/retrieval-traces.test.ts test/store/retrieval-trace-purge.test.ts test/store/migrations.test.ts, bun run docs:verify, .flow/bin/flowctl validate --spec fn-100-private-retrieval-learning-loop --json, git diff --check
- PRs: