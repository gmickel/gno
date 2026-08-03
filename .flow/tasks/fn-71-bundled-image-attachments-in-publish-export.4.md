---
satisfies: [R5, R6]
---

# fn-71-bundled-image-attachments-in-publish-export.4 Validate and transactionally ingest v1 assets on gno.sh
## Description
Implement gno.sh's strict v1 consumer/transaction boundary: whole-artifact validation, immutable private object persistence, sentinel completeness, and idempotent publish/republish/delete/rollback/orphan lifecycle before any snapshot generation becomes visible.

**Size:** M
**Files:** `/Users/gordon/work/gno.sh/src/lib/publish-artifact.ts`, `/Users/gordon/work/gno.sh/src/lib/server/storage.ts`, `/Users/gordon/work/gno.sh/src/lib/source-catalog.ts`, `/Users/gordon/work/gno.sh/test/`

## Approach
- Validate schema/capabilities, signatures, dimensions, length, digest, IDs, and every sentinel before visibility.
- Use opaque immutable keys and private storage by default.
- Commit snapshot/catalog visibility only after its complete asset generation is durable.
- Make retries, republish, delete, rollback, and orphan cleanup idempotent with content-free receipts.

## Investigation targets
**Required** (read before coding):
- `/Users/gordon/work/gno.sh/src/lib/publish-artifact.ts:47-98,117-152,211-228` — current ingest/sanitization/snapshot
- `/Users/gordon/work/gno.sh/src/lib/server/storage.ts:53-83` — current JSON-only S3 layer
- `/Users/gordon/work/gno.sh/src/lib/publish-artifact-client.ts:11` — upload limit
- `/Users/gordon/work/gno.sh/src/lib/source-catalog.ts:60-70` — current manifest placeholder
- `/Users/gordon/work/gno.sh/docs/release-readiness-checklist.md:132` — lifecycle proof

**Optional** (reference as needed):
- Hetzner Object Storage lifecycle documentation
- OWASP File Upload Cheat Sheet

## Key context
A stored object is not visible until the matching snapshot generation is committed. Raw sentinels or partial asset sets fail the whole ingest. Delivery authorization is the next task.

## Acceptance
- [ ] Hostile/malformed assets and unresolved sentinels fail before snapshot/catalog visibility and leave no permanent orphan set.
- [ ] Storage-success/ingest-failure, retry, concurrent publish, republish, delete, and rollback prove idempotent lifecycle and cleanup.
- [ ] Object keys/logs expose no source paths or secret tokens; size/digest/media metadata is accurate.
- [ ] Snapshot/catalog generation can never reference a missing or wrong-generation asset.
- [ ] gno.sh check/typecheck/tests and focused storage/ingest integration pass.

## Done summary
Implemented gno.sh's strict v1 bundled-raster ingest boundary. The consumer validates the complete artifact before writes, persists immutable private objects under opaque generation keys, enriches snapshots with digest-bound storage manifests, and activates fallback or database visibility only after every object is durable. Failed activation cleans newly created objects; same-generation requests are serialized; S3 creates are conditional and storage errors fail closed. Added idempotent delete, rollback, and orphan-cleanup lifecycle operations plus exact UTF-8 envelope enforcement.
## Evidence
- Commits: e8dfdf8
- Tests: cd /Users/gordon/work/gno.sh && bun run test (169 passed, 5 skipped, 0 failed), cd /Users/gordon/work/gno.sh && bun run check, cd /Users/gordon/work/gno.sh && bun run typecheck, cd /Users/gordon/work/gno.sh && bun run build, cd /Users/gordon/work/gno.sh && bun run test src/lib/publish-artifact-asset-storage.test.ts src/lib/publish-artifact-asset-lifecycle.test.ts src/lib/publish-artifact-asset-lifecycle.integration.test.ts (17 passed)
- PRs: