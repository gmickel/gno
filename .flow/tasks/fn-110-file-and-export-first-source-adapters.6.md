---
satisfies: [R1, R2, R3, R4, R5, R6, R7]
---
# fn-110-file-and-export-first-source-adapters.6 Complete record metadata parity security packaging and support docs

## Description
Deliver complete record metadata parity security packaging and support docs as one implementation-sized increment.

**Size:** M
**Files:** `src/pipeline/types.ts`, `src/core/context-evidence.ts`, `spec/output-schemas`, `test/ingestion/export-adapters-e2e.test.ts`, `docs/guides/file-export-adapters.md`, `assets/skill/SKILL.md`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

### Approach
- Preserve record-level people/dates/source locators and exact transcript/message/event anchors through search/get/Ask/Capsule without leaking unsafe absolute paths; extend task 3's `ContextEvidenceValue` and `toContextCapsuleEvidence` projection (plus the versioned schema) for approved record metadata rather than bypassing `compileContextEvidence`.
- Run streaming/memory, sanitization, encoding, MIME, timezone, duplicate/missing ID, partial snapshot, cross-platform, and packed npm suites.
- Publish a precise support matrix, config/limits/retry/quarantine guidance, and no-live-account/no-OAuth boundary across repo/skill/hosted docs.

### Investigation targets
**Required** (read before coding):
- `src/pipeline/types.ts`
- `spec/output-schemas`
- `docs/CONFIGURATION.md`
- `assets/skill/SKILL.md`

**Optional** (reference as needed):
- `docs/API.md`
- `docs/SDK.md`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/core/context-evidence.ts`

## Acceptance
- [ ] Cross-surface fixtures retain useful record metadata and exact anchors with schema parity.
- [ ] All resource/security/privacy/idempotency/cross-platform/package regression suites pass.
- [ ] CLI/config/docs/skill/gno.sh support matrices distinguish exports from live connectors and state caps/identity/tombstone/attachment behavior accurately.
- [ ] Record metadata additions preserve `compileContextEvidence` snapshot/provenance validation, exact full-line coordinates, and cross-surface canonical projection parity.
<!-- Updated by plan-sync (cross-spec): fn-98-context-capsule-mvp.3 made ContextEvidenceValue and toContextCapsuleEvidence the canonical evidence projection seam -->


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
