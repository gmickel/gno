---
satisfies: [R1, R2, R6]
---
# fn-103-capsule-distribution-and-commercial.8 Reject invalid public artifact enums at the trust boundary

## Description
Close the independent review blocker in the completed gno.sh public-agent import boundary without reopening `fn-103.2`.

Treat artifact JSON as untrusted input. Validate and project exact supported `sourceType` and `visibility` enum values before building publish state or an agent projection. Invalid values must fail closed with identical behavior in fallback and database runtimes.

Implementation lives in `/Users/gordon/work/gno.sh`; this GNO task records the cross-repository remediation and evidence.

## Acceptance
- V1 artifact normalization rejects unknown `sourceType` values before state construction.
- V1 artifact normalization rejects unknown `visibility` values before state construction.
- The public projection validator independently enforces exact `sourceType: note | collection` and `visibility: public`.
- Fallback and real Postgres/MinIO tests prove invalid enums make no target, snapshot, projection, or storage-visible activation.


## Done summary
Closed the independent review blocker around untrusted artifact enums in gno.sh.

- Added exact `sourceType` and `visibility` validation before state construction for V1 and V2 artifacts.
- Retained the import-normalization trust-boundary checks so invalid JSON fails before persistence work.
- Changed the public projection input boundary to accept unknown enum values and independently require `sourceType: note | collection` and `visibility: public`.
- Added fallback tests proving invalid enums fail before any target, snapshot, or projection activation and direct state/projection builders fail closed.
- Added real Postgres/MinIO parity coverage proving invalid enums create no target rows before valid two-owner activation.

Hosted remediation commit: `811efed` in `/Users/gordon/work/gno.sh`, pushed on `feat/capsule-distribution-commercial`.
## Evidence
- Commits: 811efed
- Tests: gno.sh: bun run test -- src/lib/publish-agent-isolation.test.ts, gno.sh: bun run test:integration (4 passed with Postgres and MinIO), gno.sh: bun run check, gno.sh: bun run typecheck, gno.sh: bun run test (26 files, 90 passed), gno.sh: bun run build (67 pages prerendered)
- PRs: