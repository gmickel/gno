---
satisfies: [R1, R2, R6]
---
# fn-103-capsule-distribution-and-commercial.1 Extend the public publish artifact with agent-readable evidence

## Description
Deliver extend the public publish artifact with agent-readable evidence as one implementation-sized increment.

**Size:** M
**Files:** `src/publish/artifact.ts`, `src/publish/export-service.ts`, `spec/output-schemas/publish-artifact.schema.json`, `test/publish/artifact.test.ts`

### Approach
- Add canonical public manifest/Capsule-compatible evidence metadata, Markdown locators, content hashes, capabilities, and one projection revision to the existing reader-safe artifact.
- Derive every field only from explicitly published notes/assets; never reference local index paths, drafts, or unpublished Capsule bodies.
- Add a compile-time/runtime public-only capability guard: secret/invite agent routes/config flags are absent, not merely undocumented.

### Investigation targets
**Required** (read before coding):
- `src/publish/artifact.ts:11-90`
- `src/publish/export-service.ts:134-390`
- `src/publish/encrypted-export.ts`

**Optional** (reference as needed):
- `src/cli/commands/publish.ts`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `test/publish`
- `src/core/context-capsule.ts`

### Key context
- Current visibility labels are export metadata, not authenticated remote access.
- Encrypted artifacts remain opaque to gno.sh and never gain server-decrypted evidence.

## Acceptance
- [ ] Canonical artifact fixtures include manifest revision, document/evidence hashes, Markdown locators, and capabilities derived solely from published projection.
- [ ] Private/draft/local-only paths/content and secrets are absent from artifact bytes and cache keys.
- [ ] No private/invite agent API route or activation flag ships in this task.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
