---
satisfies: [R1, R2, R7]
---
# fn-103-capsule-distribution-and-commercial.7 Scope public agent snapshots and rollback by owner

## Description
Close the independent review blocker in the completed gno.sh agent-publication work without reopening `fn-103.2`.

Scope snapshot IDs, object-storage keys, replacement deletes, projection lookup, fallback history, and rollback selection to the owning publish target. Identical public artifacts published by different owners must coexist without replacement, reads crossing owners, shared storage objects, or coupled rollback history.

Implementation lives in `/Users/gordon/work/gno.sh`; this GNO task records the cross-repository remediation and evidence.

## Acceptance
- Snapshot identity and stored object keys are owner/target scoped.
- Replacement deletes only the current target's matching snapshot.
- DB agent reads require the selected snapshot to belong to the selected target.
- Fallback projection history and rollback selection are target scoped.
- Fallback and real Postgres/MinIO tests publish an identical public artifact for two owners and prove independent reads, replacement, retained histories, and rollback.


## Done summary
Closed the independent review blocker around cross-owner snapshot identity and rollback isolation in gno.sh.

- Moved import scoping into one shared boundary used by hosted artifact imports and the legacy external-path fallback.
- Derived target IDs from owner scope, owner ID, route, and visibility with an unambiguous hash.
- Derived snapshot IDs and object-storage keys from the scoped target plus full projection revision or source snapshot identity.
- Remapped targets, snapshots, access rows, and fallback projection maps together.
- Scoped snapshot replacement deletes by both snapshot and target ID.
- Required database agent reads to join the active snapshot back to its owning target.
- Kept rollback selection constrained to retained snapshots for the selected owner target.
- Added fallback and real Postgres/MinIO two-owner tests using byte-identical artifacts. They prove distinct snapshots/storage keys, replacement isolation, two retained histories per owner, and independent rollback.
- Updated the public-agent operations runbook with the owner-scoped identity invariant.

Hosted remediation commit: `811efed` in `/Users/gordon/work/gno.sh`, pushed on `feat/capsule-distribution-commercial`.
## Evidence
- Commits: 811efed
- Tests: gno.sh: bun run test -- src/lib/publish-agent-isolation.test.ts src/lib/publish-import.test.ts, gno.sh: bun run test:integration (4 passed with Postgres and MinIO), gno.sh: bun run check, gno.sh: bun run typecheck, gno.sh: bun run test (26 files, 90 passed), gno.sh: bun run build (67 pages prerendered)
- PRs: