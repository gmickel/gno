# fn-82-second-brain-capture-and-provenance.4 Upgrade MCP gno_capture to provenance receipts

## Description

Upgrade the existing MCP `gno_capture` tool in place so it uses the shared capture core and returns the canonical provenance receipt with documented legacy compatibility fields.

Do not create a second MCP capture tool. Keep write tools opt-in and server-enforced. Tool annotations/schema improvements are useful for client UX but are not the write gate.

Expected files:

- `src/mcp/tools/capture.ts`
- `src/mcp/tools/index.ts`
- `src/mcp/server.ts` only if write-gate/metadata plumbing needs it
- `spec/mcp.md`
- `spec/output-schemas/mcp-capture-result.schema.json`
- `docs/MCP.md`
- `assets/skill/SKILL.md`
- `assets/skill/mcp-reference.md`
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`
- `test/mcp/tools/capture.test.ts`
- `test/spec/schemas/mcp-capture-result.test.ts`

Implementation notes:

- Existing MCP `overwrite` is not an alias for `collisionPolicy`; it must be handled through shared core legacy overwrite behavior or rejected globally.
- Keep MCP compatibility fields that existing schema/docs imply: `docid`, `absPath`, `overwritten`, and `serverInstanceId` where available/required.
- Shared contract supports `open_existing`; MCP should support it through shared core unless a deliberate breaking limitation is documented in task 1.
- Keep direct handler rejection for disabled writes even though the tool is normally not registered without `--enable-write`.
- Preserve lock and sync behavior using existing `withWriteLock` and `defaultSyncService` patterns.

## Acceptance

- [ ] **R1:** `gno_capture` input schema mirrors the shared capture contract, including provenance fields, text safety limits, content validation matrix, and collision policy.
- [ ] **R2:** Existing `overwrite` input is handled through shared core legacy overwrite semantics with `collisionPolicyResult: overwritten`, or rejected with a documented breaking-removal error; adapters do not bypass core.
- [ ] **R3:** MCP result schema preserves documented compatibility fields (`docid`, `absPath`, `overwritten`, `serverInstanceId`) or explicitly versions any breaking schema change.
- [ ] **R4:** `gno_capture` delegates to the shared core for path planning, provenance frontmatter, tags, presets, content hash, text safety, collision behavior, and receipt fields.
- [ ] **R5:** MCP supports `open_existing` parity through the shared core or the shared contract explicitly removes that policy from all capture surfaces.
- [ ] **R6:** MCP write-gate tests cover tool absence when writes are disabled and direct handler rejection if reached while disabled.
- [ ] **R7:** MCP receipt schema validates structured output and preserves backward-compatible human text where needed.
- [ ] **R8:** MCP docs/spec/skill reference and hosted `gno.sh` MCP docs explain provenance, write gating, locks, legacy `overwrite`, collision behavior, and no-auto-embed semantics.

## Done summary

## Evidence

- Commits:
- Tests:
- PRs:
