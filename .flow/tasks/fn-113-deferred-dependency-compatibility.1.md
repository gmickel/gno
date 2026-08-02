# fn-113-deferred-dependency-compatibility.1 Migrate the lint toolchain and policy

## Description
Upgrade Ultracite, Oxlint, oxlint-tsgolint, and Oxfmt together. Migrate configuration, triage the new rule set, and preserve type-aware linting without suppressing real defects.

## Acceptance
- Supported module configuration replaces obsolete named-config strings.
- Oxlint type-aware and type-check modes complete without a tsgolint panic.
- Newly enabled rules are explicitly adopted, scoped, or rejected with rationale.
- Full prerelease and CI gates pass.
- Four lint-toolchain Dependabot ignores are removed.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
