---
satisfies: [R6]
---
# fn-103-capsule-distribution-and-commercial.6 Close encrypted publish artifact review finding

## Description
Close the residual encrypted V2 publish-artifact review finding before hosted serving work.

- Route `buildEncryptedPublishArtifact` through a closed runtime validator and projection matching the advertised JSON schema.
- Preserve encrypted payload opacity while validating structural boundaries: valid publish route slug and source type, non-empty bounded secret token and base64 payload strings, positive safe-integer iterations, generated date-time, and encrypted visibility.
- Drop unknown runtime properties rather than serializing them.
- Add direct valid-builder/schema and rejection coverage.

## Acceptance
- [ ] Every returned V2 builder artifact satisfies `publish-artifact.schema.json`.
- [ ] Empty, oversized, malformed base64 payload fields; unsafe iterations; invalid slugs/source types; and empty/oversized tokens fail closed.
- [ ] The returned artifact is a closed projection and does not serialize unknown input or payload properties.
- [ ] Focused publish/schema, lint, typecheck, docs verification, and full Bun tests pass.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
