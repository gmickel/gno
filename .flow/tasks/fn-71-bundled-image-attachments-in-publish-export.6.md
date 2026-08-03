---
satisfies: [R4]
---
# fn-71-bundled-image-attachments-in-publish-export.6 Authorize public and secret raster delivery

## Description
Add visibility-specific raster delivery for v1 readers: immutable public URLs only for public shares, capability-authorized private delivery for secret shares, sentinel rewriting before Markdown parsing, and network/CSP/cache behavior that cannot cross share generations.

**Size:** M
**Files:** `/Users/gordon/work/gno.sh/src/routes/publish.tsx`, `/Users/gordon/work/gno.sh/src/lib/server/storage.ts`, `/Users/gordon/work/gno.sh/src/lib/publish-artifact.ts`, `/Users/gordon/work/gno.sh/test/`

### Approach
- Bind every asset request to the share visibility/generation established at ingest.
- Keep object storage private by default; public exposure is an explicit public-share projection.
- Resolve sentinels to authorized URLs before Markdown block rendering and prevent raw/internal identifiers from escaping.
- Test tokenless/expired/wrong-generation access, cache headers, and public immutability.

### Investigation targets
**Required** (read before coding):
- `/Users/gordon/work/gno.sh/src/routes/publish.tsx` — reader/request lifecycle
- `/Users/gordon/work/gno.sh/src/lib/server/storage.ts:53-83` — storage access layer
- `/Users/gordon/work/gno.sh/src/lib/publish-artifact.ts:117-152` — current embed stripping/render preparation
- `/Users/gordon/work/gno.sh/src/lib/source-catalog.ts:60-70` — generation manifest
- `/Users/gordon/work/gno.sh/docs/prd/publish-artifact-upload.md` — visibility/upload product rules

**Optional** (reference as needed):
- OWASP secure cloud storage guidance
- `/Users/gordon/work/gno.sh/docs/release-readiness-checklist.md:132` — deployed access proof

### Key context
A secret path or opaque object key is not authorization. Secret asset responses require the same share capability; public assets are assumed permanently public and immutable.

## Acceptance
- [ ] Public-share assets render from immutable public generation URLs and never expose source paths/internal sentinels.
- [ ] Secret-share assets require the matching capability on every request; tokenless, expired, wrong-share, and wrong-generation access fails.
- [ ] Sentinel rewriting completes before Markdown rendering and cannot leak private storage keys or raw `gno-asset:` values.
- [ ] Cache/CSP/content headers are correct for supported raster media and cannot mix generations or visibility classes.
- [ ] Focused reader/network/access tests and gno.sh gates pass.


## Done summary
Implemented capability-bound bundled raster delivery for public and secret readers. Reader projection validates complete manifests, rewrites asset sentinels to generation-bound URLs, and strips internal storage keys. Public delivery uses immutable caching and ETags; secret delivery reauthorizes the token on every request and uses private no-store caching. Both paths validate snapshot, generation, digest, media type, stored bytes, and manifest identity before serving. Missing or unauthorized resources share one hardened response.
## Evidence
- Commits: ec05865aafcace9d824e11fcd65b1794791b13bb
- Tests: bun run check, bun run typecheck, bun run test (185 passed, 5 skipped), bun run build, live built-server curl: public and secret misses both 404 with identical body and no-store/CSP/nosniff/CORP headers
- PRs: