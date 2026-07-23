---
satisfies: [R1, R2, R7]
---
# fn-103-capsule-distribution-and-commercial.9 Migrate legacy publication identity without destructive pre-delete

## Description
Close the independent rereview blocker in the gno.sh owner-scoped publication migration without reopening completed tasks.

On the first re-import after scoped identity ships, or when a publication changes identity/visibility, preserve the existing owner+slug target and its snapshots, access rows, agent projections, and rollback history until the replacement is fully validated and activated. Database source persistence, legacy-target migration, replacement snapshot insertion, and active-target switch must be one transaction. Any failure must leave the prior publication live and unchanged. The fallback runtime must provide equivalent preserve-then-activate semantics without cross-owner ambiguity.

Implementation lives in `/Users/gordon/work/gno.sh`; this GNO task records the cross-repository remediation and evidence.

## Acceptance
- First re-import from a legacy/pre-scoped target ID migrates that owner+slug publication without deleting its snapshots, access rows, public projections, or rollback history.
- Identity and visibility migration has one explicit safe result: existing history is preserved under the replacement target only when owner scope, owner ID, and route slug match exactly; cross-owner candidates never participate.
- Database source persistence, target/history migration, snapshot insertion, and active revision switch commit atomically.
- Injected database failure before or during activation leaves the old target, active snapshot, access, stored history, and reader projection live.
- Fallback activation preserves the prior publication on failure and migrates matching legacy history on success.
- Fallback and real Postgres/MinIO tests cover successful legacy-ID upgrade plus rollback, injected activation failure, and visibility-change behavior.


## Done summary
Implemented safe legacy publication identity migration across fallback and hosted database runtimes.

- Fallback imports remap exact owner-scope, owner-ID, and route-slug history to the new scoped target before the single state activation.
- Database imports now create source provenance, persist source rows, lock and migrate any legacy target, move snapshot and membership ownership, write the replacement, and switch the active snapshot on one checked-out PostgreSQL transaction.
- Visibility changes retain history while public routes follow only the committed current visibility.
- Validation and injected database failures leave the old target, source history, and active projection unchanged.
- Added fallback regression coverage and real PostgreSQL/MinIO upgrade, rollback, visibility, and failure-injection coverage.
- Updated the public agent projection operations runbook.
## Evidence
- Commits: 1439fe6
- Tests: cd /Users/gordon/work/gno.sh && bun x vitest run src/lib/publish-agent-isolation.test.ts, cd /Users/gordon/work/gno.sh && bun run test:integration, cd /Users/gordon/work/gno.sh && bun run check, cd /Users/gordon/work/gno.sh && bun run typecheck, cd /Users/gordon/work/gno.sh && bun test, cd /Users/gordon/work/gno.sh && bun run build
- PRs: