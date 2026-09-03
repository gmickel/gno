---
satisfies: [R1, R4, R7]
---
# fn-130-memory-slice-rememberrecall-contracts.4 REST + SDK surfaces + cross-surface contract

## Description
REST + SDK surfaces + cross-surface contract. **Size:** M. **Files/Touches:** src/serve/routes/api.ts, src/sdk/client.ts + types, spec/output-schemas/memory-remember.schema.json + memory-recall.schema.json, test/spec/schemas/memory*, docs/API.md.
POST /api/memory/remember + /api/memory/recall (loopback + CSRF conventions, write-path admission per existing REST write rules); client.remember()/client.recall(); ONE shared zod schema powering all four surfaces (incl. required caller/session identity fields AND the required egressLineage field on recall results); adapters delegate to core (no lease in adapters). Cross-surface contract tests assert byte-compatible result shapes across CLI --json / MCP / REST / SDK for the same operations.

**Touches:** src/serve/routes/api.ts, src/sdk/client.ts, src/sdk/types.ts, spec/output-schemas/memory-*.schema.json (new), test/spec/schemas/memory*, docs/API.md

## Acceptance
- [ ] Both endpoints enforce loopback+CSRF and the write path honors existing REST write admission; live curl verification
- [ ] SDK methods round-trip add/supersede/recall against a temp index (contract test)
- [ ] Output schemas committed; contract tests prove all four surfaces emit identical shapes for identical inputs
- [ ] docs/API.md + SDK docs in the same change

## Done summary
Added the REST and SDK bindings of the shared memory contract: `POST /api/memory/remember` (201 when a record is written, 200 for existing/candidates) and `POST /api/memory/recall` in `src/serve/routes/api.ts` (handlers `handleMemoryRemember` / `handleMemoryRecall` with optional `deps { lockPath, lockWaitMs }`, wired in `src/serve/server.ts` behind the existing `isRequestAllowed` CSRF gate and, for recall, `handleResidentRead`; also in the `routeApi` fallback router), delegating to `MemoryService` (the service owns the write lease; the adapter takes none) and mapping `MemoryError.code` verbatim onto the error envelope with a status table (400 validation/fence, 404 not-found, 409 hash-mismatch/conflict/lease-busy, 500 sync/query). SDK: `client.remember()` / `client.recall()` in `src/sdk/client.ts` with best-effort embed/vector ports and `writeLeasePath(client.dbPath)`; errors are `GnoSdkError` with the memory code in `details.code` and the `MemoryError` as `cause`; types (`GnoRememberInput/Result`, `GnoRecallInput/Result`, `MemoryFact`, `MemoryRecallReceipt`, ...) and `MemoryError` exported from the package root. Shared schemas `spec/output-schemas/memory-remember.schema.json` + `memory-recall.schema.json` derived 1:1 from the core `RememberResult` / `RecallResult` types (recall facts require `egressLineage`; receipt requires caller + session), registered in `test/spec/schemas/validator.ts`.

Tests: `test/spec/schemas/memory-schemas.test.ts` (static valid/invalid fixtures per outcome) and `test/spec/schemas/memory-contract.test.ts` (core vs REST vs SDK on separate temp indexes: identical normalized results for empty recall, add, exact-dup existing, candidates; every R4 refusal + unknown collection + supersede-without-predecessor return the same code on all three surfaces with the documented HTTP status; malformed-body 400; fallback router wiring; SDK add -> recall -> supersede -> recall shows only the successor and a second supersede returns MEMORY_SUPERSEDE_CONFLICT; receipt replay fenced on REST and SDK). Live curl verification of both endpoints incl. CSRF is in the evidence. Docs: docs/API.md (tables, two endpoint sections, memory error table) and docs/SDK.md (Remember / Recall section, public surface).

Touches extension, flagged for the conductor: `src/serve/server.ts` (route wiring; the endpoints do not exist without it), `src/sdk/index.ts` (public exports), `test/spec/schemas/validator.ts` (schema registration). CHANGELOG.md deliberately untouched (shared file) - noted for .5 in NOTES_DIR (`fn-130-4-rest-sdk.md`). Follow-up not built: CLI/MCP rows in the cross-surface test once .2/.3 land (they can call `loadSchema("memory-remember" | "memory-recall")`).

baseline: green via handoff (verified at 48488e5d by fn-130-memory-slice-rememberrecall-contracts.1); lint baseline green.

stage: impl-review - skipped(policy: parallel-wave - conductor owns the review after integration)

Integrated onto the spec branch as ae2db379 (cherry-pick over the .2/.3 commits).

stage: impl-review - skipped(policy: review backend none)
stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: ae2db3790c89628f3662c6d8680889385e9bf457
- Tests: baseline: green via handoff (verified at 48488e5d by fn-130-memory-slice-rememberrecall-contracts.1); lint baseline: bun run lint:check exit 0, bun run lint (exit 0; 1 pre-existing warning in test/cli/query-text.test.ts), bun test test/spec/schemas/memory-schemas.test.ts test/spec/schemas/memory-contract.test.ts (29 pass, 0 fail), bun test (full suite: 4601 pass, 2 skip, 0 fail, 183s, exit 0; green receipt .flow/tmp/green-receipts/f465486a-unittest.json), live curl against `bun src/index.ts serve --port 3791` on a temp home: recall empty -> 200 + hint; remember add -> 201 + fact file on disk; recall -> 200 with gno:// cite, egressLineage, receipt; unscoped -> 400 MEMORY_SCOPES_REQUIRED; unmanaged collection -> 400 MEMORY_COLLECTION_UNMANAGED; Origin http://evil.example -> 403 CSRF_VIOLATION on both endpoints; same-origin Origin -> 200, integrated: bun test test/spec/schemas/memory-contract.test.ts test/spec/schemas/memory-schemas.test.ts test/mcp/memory.test.ts test/cli/memory.test.ts
- PRs: