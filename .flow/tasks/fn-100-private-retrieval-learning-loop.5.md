---
satisfies: [R1, R3, R6, R7]
---
# fn-100-private-retrieval-learning-loop.5 Complete privacy migration documentation and regression gates

## Description
Deliver complete privacy migration documentation and regression gates as one implementation-sized increment.

**Size:** M
**Files:** `spec/output-schemas`, `test/traces`, `docs/CONFIGURATION.md`, `docs/HOW-SEARCH-WORKS.md`, `docs/TROUBLESHOOTING.md`, `assets/skill/SKILL.md`

### Approach
- Add migration/rollback, size/retention/idempotency, no-network, redaction, and purge regression suites.
- Treat migration v14 and its migration-v12/v13 upgrade paths as the compatibility baseline; cover aggregate export links and every terminal status.
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
- [ ] No-network and full-purge tests prove the private local contract.
- [ ] Docs and skill assets state consent, retention, redaction, explicit-label, and no-auto-personalization boundaries accurately.
- [ ] Cross-surface regression tests preserve transport-only identity, exact terminal/filter/capability semantics, and public JSON/Context Capsule canonical bytes.
- [ ] Retention regressions cover exact caps 1/2/3 plus concurrent eviction, proving retrieval still succeeds and no missing/open receipt is advertised.

<!-- Updated by plan-sync: fn-100-private-retrieval-learning-loop.2 established the cross-surface trace regression contract -->


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
