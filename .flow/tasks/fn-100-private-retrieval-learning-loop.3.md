---
satisfies: [R1, R2, R3]
---
# fn-100-private-retrieval-learning-loop.3 Expose local trace feedback and purge controls

## Description
Deliver expose local trace feedback and purge controls as one implementation-sized increment.

**Size:** M
**Files:** `src/cli/commands/trace.ts`, `src/serve/routes/api.ts`, `src/sdk/client.ts`, `src/mcp/tools/trace.ts`, `src/serve/public/pages/TraceHistory.tsx`, `test/traces/cross-surface.test.ts`

### Approach
- Add inspect/list/label/export/delete/purge operations using stable local-write authorization and one shared service.
- Require explicit relevant/irrelevant/missing-expected judgments; include a safe way to reference expected documents without copying raw content.
- Build on migration v14 terminal states and aggregate export manifests: a feedback/export action may reference multiple completed traces, while partial/failed/cancelled traces remain distinguishable and cannot imply negative relevance.
- Consume the task-2 receipt contract directly: application boundaries use `startRetrievalTraceRequest`, `retrievalTraceFilters`, and `finishRetrievalTraceAfterError`; `RetrievalTraceSession` owns fail-soft surface behavior; `RetrievalTraceRecorder` remains truthful about persistence/retention eviction. Do not recreate trace IDs, fingerprinting, event ordering, or retention handling in feedback surfaces.
- Preserve surface identity rules exactly: CLI writes `Trace: <id>` to stderr only; SDK uses non-enumerable `RETRIEVAL_TRACE_METADATA`; MCP uses `_meta.gno.retrievalTrace.traceId`; REST uses `X-GNO-Trace-ID`. A session whose `metadata()` is unavailable after eviction emits no identity on any surface.
- Read stored terminal outcomes as recorded: `completed`, `partial`, `failed`, and `cancelled` stay distinct. In particular, Ask with generation but no retained citations is `partial`; setup/model failures are `failed`; aborts are `cancelled`; open search/query receipts remain continuable for get/open evidence.
- Keep remote/non-loopback mutation disabled by default. Bearer gateway authentication proves caller identity but never authorizes trace mutation; HTTP MCP writes additionally require the explicit `gateway.enableWrite` / `--mcp-enable-write` control, and fn-111 later adds egress policy rather than write identity. <!-- Updated by plan-sync (cross-spec): fn-99-resident-local-context-gateway.5 proved bearer authentication alone rejects writes -->

### Investigation targets
**Required** (read before coding):
- `src/serve/routes/api.ts`
- `src/sdk/client.ts`
- `src/mcp/server.ts`
- `src/cli/program.ts`

**Optional** (reference as needed):
- `src/serve/public/components/HealthCenter.tsx`
- `src/core/config-mutation.ts`

## Acceptance
- [ ] CLI/REST/MCP/SDK/Web parity covers inspect, explicit labels, export, delete, and full purge.
- [ ] Unauthorized/non-loopback writes are denied with stable codes and no trace content leakage.
- [ ] All output paths redact sensitive local paths and queries according to trace mode.
- [ ] Export manifests can bind multiple immutable traces and never reinterpret non-completed terminal states as negative feedback.
- [ ] Feedback surfaces reject missing/evicted trace IDs without fabricating an empty receipt; caps below the four-record minimum lifecycle remain cleanly disabled and produce no labelable trace.
- [ ] Cross-surface tests prove identity stays transport-only and disappears after fail-soft eviction while the underlying retrieval/feedback request remains correctly reported.

<!-- Updated by plan-sync: fn-100-private-retrieval-learning-loop.2 froze trace ownership, transport-only identity, terminal outcomes, and low-retention behavior -->


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
