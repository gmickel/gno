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
Closed the encrypted V2 publish-artifact review finding.

- Routes encrypted artifact construction through a closed runtime validator and projection.
- Validates schema-compatible route/source identity, bounded non-blank opaque tokens, bounded standard-base64 ciphertext/key material, positive safe-integer KDF iterations, generated timestamp, and fixed encrypted visibility.
- Drops caller-supplied extension fields at the artifact and payload boundaries without inspecting or transforming encrypted content.
- Aligns the advertised JSON schema and user-facing contract documentation with the runtime bounds.
- Adds valid builder-to-schema and fail-closed regressions for malformed, empty, oversized, unsafe, and extension-field inputs.
## Evidence
- Commits: 5a387b3
- Tests: bun test test/publish test/cli/publish-export.test.ts test/serve/routes/publish-export.test.ts test/spec/schemas (224 pass, 0 fail), bun run lint:check, bunx tsc --noEmit, bun run docs:verify (13 pass, 0 fail, 2 model-cache skips), bun test (2854 pass, 1 Windows-only skip, 0 fail), .flow/bin/flowctl validate --spec fn-103-capsule-distribution-and-commercial --json
- PRs: