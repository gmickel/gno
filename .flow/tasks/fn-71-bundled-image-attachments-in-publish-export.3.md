---
satisfies: [R1, R4]
---

# fn-71-bundled-image-attachments-in-publish-export.3 Carry encrypted assets through v2 client-only rendering
## Description
Carry the validated asset bundle inside the v2 encrypted payload and render decrypted raster assets through scoped browser Blob URLs without exposing plaintext objects to server storage or leaking URLs across snapshot changes.

**Size:** M
**Files:** `src/publish/encrypted-export.ts`, `test/publish/encrypted-export.test.ts`, `/Users/gordon/work/gno.sh/src/lib/publish-artifact.ts`, `/Users/gordon/work/gno.sh/src/routes/publish.tsx`, `/Users/gordon/work/gno.sh/test/`

## Approach
- Encrypt descriptors and bytes under the existing v2 payload, preserving old v2 compatibility.
- Validate digest/type/size again after client decryption before creating object URLs.
- Resolve every sentinel before Markdown rendering; revoke Blob URLs on replacement, failure, navigation, and unmount.
- Keep the server blind to plaintext asset contents.

## Investigation targets
**Required** (read before coding):
- `src/publish/encrypted-export.ts:50-52,193` — current empty asset payload
- `/Users/gordon/work/gno.sh/src/lib/publish-artifact.ts:211-228` — snapshot construction
- `/Users/gordon/work/gno.sh/src/routes/publish.tsx` — reader lifecycle
- `/Users/gordon/work/gno.sh/src/lib/source-catalog.ts:60-70` — current placeholder manifest
- `docs/WEB-UI.md:867` — current `blob:` CSP policy

**Optional** (reference as needed):
- MDN object URL lifecycle guidance
- `/Users/gordon/work/gno.sh/docs/release-readiness-checklist.md:132` — deployed reader proof

## Key context
Blob URLs are capabilities scoped to the document; revocation is required. No decrypted v2 asset is persisted to server object storage or logs.

## Acceptance
- [ ] Asset-free and asset-bearing v2 payloads encrypt/decrypt compatibly and integrity failures reject the whole generation.
- [ ] Server-side storage/logging never receives plaintext v2 image bytes or derived public URLs.
- [ ] Client validation resolves every sentinel before render and produces real `<img>` elements with supported media types.
- [ ] Blob URLs are revoked on all lifecycle terminals; CSP remains least-privilege and tests detect leaks/stale URLs.
- [ ] Cross-repo encrypted fixtures, browser tests, and gates pass.

## Done summary
Encrypted v2 exports now resolve and validate local raster attachments before AES-GCM encryption, keep descriptors and bytes exclusively inside client-decrypted plaintext, and declare the shared capability only on the outer envelope. The gno.sh encrypted reader fail-closes on malformed payloads, revalidates digest/MIME/dimensions/ownership, rewrites sentinels to generation-scoped Blob URLs, preserves safe external HTTPS images, rejects forged Blob URLs, and revokes URLs on failure, replacement, racing decrypt, and unmount.
## Evidence
- Commits: b9e3bc94c736c9c724e2ea9c20d973a22cf66f6e, 9df0fa5beff526091593f0c86dd2f65d434c8aa9
- Tests: gno: bun run prerelease (3855 pass, 2 skip, 0 fail; docs 15 pass; extension/package/real-index sentinel pass), gno.sh: bun run check, gno.sh: bun run typecheck, gno.sh: bun run test (152 pass, 5 skip, 0 fail), gno.sh: bun run build
- PRs: