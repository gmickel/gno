---
satisfies: [R1, R3, R6, R7]
---
# fn-100-private-retrieval-learning-loop.5 Complete privacy migration documentation and regression gates

## Description
Deliver complete privacy migration documentation and regression gates as one implementation-sized increment.

**Size:** M
**Files:** `spec/output-schemas`, `test/spec/schemas`, `test/traces`, `test/replay`, `docs/CONFIGURATION.md`, `docs/HOW-SEARCH-WORKS.md`, `docs/TROUBLESHOOTING.md`, `assets/skill/SKILL.md`

### Approach
- Add migration/rollback, size/retention/idempotency, no-network, redaction, and purge regression suites.
- Treat migration v14 and its migration-v12/v13 upgrade paths as the compatibility baseline; cover aggregate export links and every terminal status.
- Freeze the task-3 public management contract: `RetrievalTraceManagementService.list/show/label/export/delete/purge`; request/result types exported from `src/core/retrieval-trace-management.ts`; and `StorePort.getBoundedRetrievalTrace`, cursor-aware `listRetrievalTraces`, `appendRetrievalTraceExportManifest`, `getRetrievalTraceExportManifest`, and `getOrCreateRetrievalTraceRedactionSecret`. Regression fixtures must fail if later surfaces bypass these shared seams.
- Keep all management schemas closed and versioned: `retrieval-trace-{list,show,judgment,export,delete,purge}.schema.json` plus their shared common schema and task-4 replay/qrels schemas. CLI JSON, SDK results, REST bodies, MCP `structuredContent`, and Web decoding must agree; `trace export --output` is the deliberate artifact-only/no-stdout exception.
- Cover newest-first opaque cursor pagination and bounded inspection exactly. List never returns raw replay query/goal text; show returns exact `totals` and per-section `truncated` flags. Trace management must continue to work after recording is disabled and when no collection remains configured.
- Cover explicit judgment semantics: only `relevant`, `irrelevant`, and `missing_expected`; recorded evidence must resolve by URI/docid/hash and exact spans; unsafe absolute paths fail before persistence; corrections are append-only; identical concurrent requests settle as one insert plus duplicates rather than conflicts; missing/evicted trace IDs return `NOT_FOUND`, never fabricated empty receipts.
- Lock authorization independently from identity and future egress policy. Loopback REST mutations require the existing same-origin/CSRF gate; HTTP MCP trace mutation tools are absent unless `gateway.enableWrite` / `--mcp-enable-write` is explicit and handlers defend against disabled direct dispatch; bearer authentication alone never authorizes mutation. Reads remain available without enabling writes and all denial bodies are content-free.
- Prove logical delete/full purge cascade exact trace/run/event/judgment/export/link counts. Preserve physical cleanup as a separate truthful receipt (`completed`, `wal_busy`, or `failed`, with WAL frame counts); Web must retain busy/failed cleanup state and retry guidance rather than presenting a false fully-clean result.
- Lock the task-2 public seams in regression fixtures: `SEARCH_RESULT_PLANNER_METADATA`, `SEARCH_RESULTS_TRACE_METADATA`, `CITATION_TRACE_METADATA`, and `RETRIEVAL_TRACE_METADATA` remain non-enumerable/non-canonical; CLI stderr, MCP `_meta`, REST `X-GNO-Trace-ID`, and SDK envelopes preserve payload bytes and suppress identity after eviction.
- Cover boundary-first lifecycle across CLI/MCP/SDK/REST: trace creation precedes model/runtime setup; `finishRetrievalTraceAfterError` maps aborts to `cancelled` and other setup failures to `failed`; Ask with no retained citation completes as `partial`; search/query receipts may remain open for get/open continuation.
- Cover exact evidence and replay scope: oversized first lines are omitted rather than exceeding the character budget; citations retain true final/planner/source/graph provenance; vector-only receipts do not claim lexical use; degraded hybrid receipts retain capability reason/fallback codes; multi-collection filters are canonical and sorted.
- Cover retention truthfully at both layers: caps 1/2/3 pre-disable before clock/ID/fingerprint/store work; direct recorder callers receive an error after eviction; session/surface callers fail soft without a trace ID, query-only open orphan, or dead REST header; concurrent cap enforcement remains idempotent and terminally closed.
- Document off-by-default controls, replay-capable versus diagnostic redaction, explicit feedback semantics, and failure recovery.
- Update contracts/skill/hosted privacy guidance and run prerelease plus autoresearch gates.

### Investigation targets
**Required** (read before coding):
- `spec/output-schemas`
- `test/spec/schemas`
- `docs/CONFIGURATION.md`
- `assets/skill/SKILL.md`

**Optional** (reference as needed):
- `docs/API.md`
- `docs/SDK.md`
## Acceptance
- [ ] All trace/list/replay/export schemas and migrations pass cross-platform tests.
- [ ] Management service/type/store contracts, stable cursor pagination, bounded-detail totals/truncation, and cross-surface structured outputs are locked by contract tests.
- [ ] No-network and full-purge tests prove the private local contract.
- [ ] Docs and skill assets state consent, retention, redaction, explicit-label, and no-auto-personalization boundaries accurately.
- [ ] Cross-surface regression tests preserve transport-only identity, exact terminal/filter/capability semantics, and public JSON/Context Capsule canonical bytes.
- [ ] Retention regressions cover exact caps 1/2/3 plus concurrent eviction, proving retrieval still succeeds and no missing/open receipt is advertised.
- [ ] Mutation authorization, missing-trace behavior, concurrent label idempotency, aggregate-manifest cascades, and truthful WAL cleanup receipts pass CLI/SDK/REST/MCP/Web regressions without content leakage.

<!-- Updated by plan-sync: fn-100-private-retrieval-learning-loop.2 established the cross-surface trace regression contract -->
<!-- Updated by plan-sync: fn-100-private-retrieval-learning-loop.3 froze the shared management APIs, schemas, authorization, pagination, explicit labels, aggregate exports, and purge semantics -->


## Done summary
Closed the private retrieval learning contract with opaque cursors, canonical filters, non-enumerable metadata, nested schema closure, transactional migration rollback, no-network/privacy/auth/purge regressions, package coverage, and complete user/hosted documentation.
## Evidence
- Commits: 1d5c9aa
- Tests: bun test: 2720 pass, 1 Windows-only skip, 0 fail, bun run lint:check: clean, bun run docs:verify: 13 pass, 2 uncached-model skips, bun run test:package: passed, bun run eval:agentic: 48 pairs pass, 48.94% fewer calls, 44.12% fewer bytes, 100% linkage, skill autoresearch: 48/48, gno.sh typecheck and 10 truth tests: green
- PRs: