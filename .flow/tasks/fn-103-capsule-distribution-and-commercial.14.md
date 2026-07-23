---
satisfies: [R7]
---
# fn-103-capsule-distribution-and-commercial.14 Close production launch verifier integrity gaps

## Description
Strengthen the read-only production gate. Compare restricted and source-map misses byte-for-byte against a fresh random missing route, verify full security-header parity including CSP frame-ancestors and script-src, and verify the public document is manifest-declared with matching locator, hash, bytes, and exact line range.
## Acceptance
- [ ] Restricted and source-map responses match a fresh random missing response body, content type, cache, robots, and security headers.
- [ ] CSP includes frame-ancestors and script-src restrictions.
- [ ] Public document is declared by the served manifest.
- [ ] Served Markdown bytes, content hash, locator, and exact line range match the manifest.
- [ ] Deployment runbook documents the strengthened reviewed-revision gate.
## Done summary
Strengthened the production launch gate with exact uniform-miss comparison against a fresh random route, explicit no-script/no-framing CSP checks, and manifest-to-served-Markdown integrity verification for declaration, SHA-256, byte length, line count, and exact locator range. Added focused regression tests and updated deployment and projection runbooks.
## Evidence
- Commits: c6b0270
- Tests: bash -n scripts/verify-prod-launch.sh, bun test (107 pass, 7 database integration skips), bun run typecheck, bun run check, bun run build (67 prerendered pages)
- PRs: