---
satisfies: [R2, R5]
---
# fn-160-make-browser-clipping-persistent-and.1 Expose minimal paired collection discovery

## Description
**Size:** M
**Touches:** [src/serve/routes/clipper.ts, src/serve/routes/api.ts, spec/output-schemas/clipper-collections.schema.json, test/clipper/routes.test.ts, test/clipper/pairing-security.test.ts, test/spec/schemas/clipper.test.ts, docs/API.md]
**Approach:** Reuse createClipperRouteGateway authentication/admission. Add a closed minimal collection-name response with no-store and exact-origin GET/OPTIONS handling. Do not expose generic collection metadata or invent picker-only eligibility. Specify the contract before implementation.

## Acceptance
- [ ] Paired discovery and unauthorized/expired/revoked/cross-origin negative tests pass.
- [ ] Minimal schema forbids filesystem/model/update-command fields; API docs match.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
