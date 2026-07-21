---
satisfies: [R3, R6, R7]
---
# fn-111-collection-egress-policies.4 Propagate restrictive policy through mixed and derived data with audit

## Description
Deliver propagate restrictive policy through mixed and derived data with audit as one implementation-sized increment.

**Size:** M
**Files:** `src/core/egress-provenance.ts`, `src/core/egress-audit.ts`, `src/core/context-capsule.ts`, `src/core/retrieval-trace.ts`, `src/publish/artifact.ts`, `test/egress/derived-policy.test.ts`

### Approach
- Attach source collection policy lineage to snippets, embeddings, Capsules, traces, journal records, clip/export artifacts, and multi-record sources; transformation never declassifies.
- For mixed collections, compute most restrictive effective policy and require explicit disclosed partial-result semantics before omitting denied sources.
- Write bounded local allow/deny audit receipts with operation/destination zone/policy/reason/timestamp and hashes only; support retention/inspect/purge transactionally.

### Investigation targets
**Required** (read before coding):
- `src/publish/artifact.ts`
- `src/store/types.ts`
- `src/config/types.ts`

**Optional** (reference as needed):

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/core/context-capsule.ts`
- `src/core/retrieval-trace.ts`
- `src/core/change-journal.ts`
- `src/core/browser-clip.ts`
- `src/ingestion/record-adapter.ts`

## Acceptance
- [ ] Derived artifacts retain the most restrictive source lineage across all declared types.
- [ ] Mixed-source deny/explicit-partial behavior is deterministic and cannot silently omit restricted evidence.
- [ ] Audit inspect/retention/purge works locally and stores no content, credentials, query text, or sensitive absolute paths.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
