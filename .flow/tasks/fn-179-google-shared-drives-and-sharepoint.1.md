---
satisfies: [R1, R2, R3, R4, R5, R6, R7]
---
# fn-179-google-shared-drives-and-sharepoint.1 Implement Google Shared Drives and SharePoint library source availability

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
`sourceAvailability: local` now admits Google Drive Shared drives on macOS (`GoogleDrive-*/Shared drives/<drive>/...`); the bare `Shared drives` folder stays unsupported. The smoke harness accepts immediate Shared drive roots and records the layout in every receipt. OneDrive is re-proven for the two installed SharePoint library roots. The heimdall evidence is recorded under research/file-provider/, and the docs, CHANGELOG, and gno.sh (worktree /home/gordon/work/gno-sh-fn179, commit c52942a, not pushed) now match it.

- R1 tests: test/scripts/macos-file-provider-smoke.test.ts. They cover root-shape accept/refuse, real temp-dir resolution, a symlinked root, a symlinked Shared drives dir, and the cleanup-plan layout.
- R4 tests: test/ingestion/source-availability/darwin-path.test.ts. They cover the drive root, a descendant, the aggregation root, the trailing-slash empty name, the account root, and an unknown container.
- The Shared drive race row is inferred, not observed. Google Drive 131.0 would not evict fixtures on request. Maintainer approved.
- Full suite: 5832 pass, 2 fail. The failures were 5 s load timeouts in test/store/links.test.ts, which passes 43/43 on its own. Recorded as inconclusive, not green.

stage: impl-review - skipped(config: repo instructions skip all review stages; conductor instructed no model review)
## Evidence
- Commits: fbe1bd03caa1a31f65407e7441780a46f3f9b2d4, 44ecc42a52eb6e3b6c7732c65317cf2426c68a82, 91e65a416785ee568676e232d9e1548b59e6d835, 0768de2974c16dc97f21e9bcedcb8373d6076ef1
- Tests: mise exec bun@1.4.2 -- bun run lint:check (rc 0), mise exec bun@1.4.2 -- bun run docs:verify (rc 0; 15 passed, 2 skipped), mise exec bun@1.4.2 -- bun test test/ingestion/source-availability test/scripts/macos-file-provider-smoke.test.ts (130 pass, 0 fail), TMPDIR=/home/gordon/.cache/gno-test-tmp/fn-179 mise exec bun@1.4.2 -- bun test (INCONCLUSIVE: 5832 pass, 3 skip, 2 fail = 5s load timeouts in test/store/links.test.ts; that file 43/43 green in isolation), gno.sh c52942a: bun run check, bun run typecheck, bun run test (all rc 0; 431 pass, 41 skipped), heimdall evidence: research/file-provider/evidence/2026-09-26-shared-drives-and-sharepoint.json
- PRs: