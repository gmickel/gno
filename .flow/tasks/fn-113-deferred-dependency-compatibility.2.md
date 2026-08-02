# fn-113-deferred-dependency-compatibility.2 Resolve Ajv and ajv-formats type identity

## Description
Upgrade the direct Ajv dependency without creating a second nominal Ajv type under ajv-formats. Prefer a fixed Bun resolver; otherwise use a narrowly documented package resolution constraint.

## Acceptance
- Root Ajv and ajv-formats use compatible runtime and TypeScript identities.
- Schema contract tests and full prerelease gates pass.
- The Ajv Dependabot ignore is removed.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
