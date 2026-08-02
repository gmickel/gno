# fn-113-deferred-dependency-compatibility Deferred dependency compatibility migrations

## Overview

Keep automated dependency maintenance green while two non-routine upgrades are handled deliberately. Ultracite 7.9.4 changes the repository lint policy and configuration format, producing repository-wide findings; Ajv 8.20.0 is installed alongside Ajv 8.17.1 under `ajv-formats` by Bun 1.3.14, producing nominally incompatible TypeScript types.

## Scope

- Migrate Ultracite, Oxlint, oxlint-tsgolint, and Oxfmt as one tested toolchain.
- Decide and document the intended new lint policy; fix real findings without bulk unsafe rewrites.
- Upgrade Ajv after Bun can deduplicate the compatible `ajv-formats` dependency, or add a verified package-resolution constraint.
- Remove the corresponding Dependabot ignores once both migrations pass the full release gate.

## Approach

1. Reproduce each upgrade independently from a clean lockfile.
2. For the lint toolchain, migrate `.oxlintrc.json` to the supported module configuration and review newly enabled rules by category.
3. For Ajv, verify one runtime/type identity is used by both direct imports and `ajv-formats`.
4. Run lint, typecheck, full tests, documentation verification, package smoke, and CI before removing the ignores.

## Quick commands
- `bun install --frozen-lockfile`
- `bun run lint:check`
- `bun run typecheck`
- `bun test`
- `bun run prerelease`

## Acceptance
- [ ] Ultracite/Oxlint/Oxfmt use supported configuration and the repository has an explicitly reviewed green lint baseline.
- [ ] `oxlint --type-aware --type-check` runs with a compatible `oxlint-tsgolint` and does not panic.
- [ ] Ajv and `ajv-formats` share compatible runtime and TypeScript identities with schema tests passing.
- [ ] Dependabot ignores for the five packages are removed.
- [ ] Full local and GitHub CI gates pass.

## References
- Dependabot grouped update PR #162 (August 2026)
- Ultracite 7.9.4 requires module-based Oxlint configuration and enables substantially broader rules than 7.1.5.
- Oxlint 1.76.0 declares `oxlint-tsgolint >=7.0.2001`; the old 0.11.5 pin panics on `typescript/consistent-return`.
- Ajv 8.20.0 plus `ajv-formats` 3.0.1 currently resolves as two Ajv installations under Bun 1.3.14.
