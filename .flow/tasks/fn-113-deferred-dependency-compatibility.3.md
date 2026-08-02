# fn-113-deferred-dependency-compatibility.3 Resolve transitive dependency security advisories

## Description
Audit and resolve the transitive dependency advisories that remain after all safe direct dependency upgrades. Prefer upstream releases or dependency removal over package-manager overrides. Treat compatibility, runtime behavior, package contents, and native install scripts as release gates.

## Acceptance
- `bun audit` findings are mapped to their direct dependency owners and reachable GNO surfaces.
- Every actionable advisory is fixed through an upstream-compatible upgrade, dependency replacement, or removal; any genuinely upstream-blocked item has a documented owner, upstream reference, and review date.
- No forced transitive override is accepted without full `bun run prerelease`, Web UI E2E, PDF E2E, and package smoke evidence.
- Direct dependencies remain pinned and required lifecycle scripts are reviewed before trust changes.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
