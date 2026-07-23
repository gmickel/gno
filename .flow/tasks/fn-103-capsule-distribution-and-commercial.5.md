---
satisfies: [R1, R2, R6]
---
# fn-103-capsule-distribution-and-commercial.5 Close public publish artifact review findings

## Description
Close the two P2 findings from the fn-103.1 implementation review before
starting hosted serving work.

- Reject forbidden local path and URI tokens anywhere in allowed metadata
  strings, including POSIX, Windows, `file://`, and `gno://` references.
- For canonical/image URL metadata, allow only uncredentialed public HTTP(S)
  targets; reject loopback, private, link-local, and local hostnames without
  broad false-positive substring matching.
- Make publish artifact builders fail closed for empty notes and other cheap
  schema invariants they control: slugs, required titles, unique note slugs,
  valid home-note membership, and required non-empty structural values.
- Add direct builder/schema and metadata-egress regression coverage.

## Acceptance
- [ ] Local path/URI tokens are rejected wherever they occur in allowed metadata strings.
- [ ] Canonical/image metadata rejects credentialed, loopback, private, and link-local HTTP(S) targets.
- [ ] Every returned V1 builder artifact satisfies the publish artifact schema.
- [ ] Direct regressions cover empty notes, invalid slugs/titles/home-note membership, duplicate slugs, and metadata egress cases.
- [ ] Focused publish/API, lint, typecheck, docs verification, and full Bun tests pass.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
