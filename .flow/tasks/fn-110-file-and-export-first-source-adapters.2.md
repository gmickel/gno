---
satisfies: [R1, R2, R3, R4, R5, R6]
---
# fn-110-file-and-export-first-source-adapters.2 Implement JSONL and transcript export adapters

## Description
Deliver implement jsonl and transcript export adapters as one implementation-sized increment.

**Size:** M
**Files:** `src/converters/adapters/jsonl/adapter.ts`, `src/converters/adapters/transcript/adapter.ts`, `test/converters/jsonl.test.ts`, `test/converters/transcript.test.ts`, `test/fixtures/exports`

### Approach
- Support declarative safe JSONL field mappings; require a configured ID for update/tombstone semantics or use content-hash append identity with explicit limitations.
- Convert VTT/SRT/common transcript JSON/text into session/segment records preserving speaker and timestamp/cue anchors, source/export IDs, and malformed-segment isolation.
- Stream lines/cues with encoding/size/count caps and no executable mapping expressions.

### Investigation targets
**Required** (read before coding):
- `src/converters/native/plaintext.ts`
- `src/converters/canonicalize.ts`

**Optional** (reference as needed):
- `src/ingestion/frontmatter.ts`
- `src/core/sections.ts`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/ingestion/record-adapter.ts`
- `spec/project-profile.schema.json`

## Acceptance
- [ ] JSONL and transcript fixtures emit deterministic searchable records with configured/stable IDs, hashes, people/dates, and exact line/cue anchors.
- [ ] Malformed lines/cues and encoding/size/count violations are isolated with retryable/non-retryable receipts.
- [ ] Re-import update/removal behavior matches declared full-snapshot identity semantics.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
