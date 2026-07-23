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
Added a public-only agent manifest to reader-safe publish artifacts. Public
spaces now expose deterministic projection revisions, sorted Markdown
documents, exact line locators, content hashes, and Capsule-compatible evidence
identities. Secret-link and invite-only spaces cannot carry agent manifests;
encrypted artifacts remain opaque. Export serialization now omits local source
URIs, collection paths, unpublished notes, raw frontmatter, secrets, and
local-path metadata. Added a strict output schema, compile/runtime visibility
guards, privacy regressions, and CLI/API/user documentation.
## Evidence
- Commits: 240a76f
- Tests: bun test test/publish test/cli/publish-export.test.ts test/serve/routes/publish-export.test.ts (13 pass, 0 fail), bunx tsc --noEmit (pass), bun run lint:check (pass), bun run docs:verify (13 pass, 0 fail, 2 model-cache skips), bun test (2851 pass, 1 Windows-only skip, 0 fail), .flow/bin/flowctl validate --spec fn-103-capsule-distribution-and-commercial --json (valid)
- PRs: