---
satisfies: [R1, R2, R3, R4]
---
# fn-154-gno-20-release-dependency-sweep-and.1 Audit dependencies, apply selected upgrades and validate release candidate

## Description
Complete authorized dependency sweep and release gates on PR 217; preserve native ownership and retrieval quality, exclude PR 183.

## Acceptance
Document live audit decisions, exact pins and residual advisory exposure. Frozen install, lint, typecheck, tests, docs and actual package gates pass. Fresh native CUDA and Heimdall comparisons and relevant CI checks pass. Reconcile PR217 and hosted docs queue with the final candidate. PR183 remains untouched. Report ready only after the gates establish readiness.
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
