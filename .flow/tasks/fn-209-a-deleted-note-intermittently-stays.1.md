---
satisfies: [R1, R2, R3]
---
# fn-209-a-deleted-note-intermittently-stays.1 Drop notes the snapshot never saw when their folder changes

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
A note deleted from disk could stay active in the index. Mechanism (confirmed with temporary watcher tracing of a reproducing seed): a note indexed from its own exact watcher event after the snapshot baseline is in the store but not in the snapshot, because an exact-only flush recommits the unchanged snapshot. When its folder was then moved or deleted, inotify reported only the folder; snapshot classification produced removals from the snapshot diff for the folder's known children (`d4/new-178.md`, `d4/new-184.md`) and never asked the store, so the newer note (`d4/new-186.md`) stayed active until a full sync.

Fix (`src/serve/watch-reconciliation.ts`): after a successful snapshot diff, `storeOnlyRemovals` asks the store for active descendants under each dirty directory hint (root and nested hints skipped) and adds those the fresh snapshot does not list and `lstat` confirms are missing. A failed check never infers a delete; a descendant overflow escalates to a full reconcile; a store error returns a classification error (retained work). CHANGELOG Unreleased Fixed entry.

Defect route:
- prior fixes: none for this path (fn-202 retry backoff and fn-205 startup reconcile touched the watcher, not removal classification)
- diagnosis: in-process repro (real resident, real fs.watch, seeded churn incl. directory moves/deletes) mismatched on seeds 1 and 10 of 1-10; temporary tracing of seed 10 showed the exact-only flush indexing `d4/new-186.md` and the later directory flush's removals omitting it; eliminated "events lost" (both events arrived), "prefix bug" (seed 1 moved to an unrelated name) and "move and recreate" (passes on main)
- introduced by: skipped: present since snapshot-based classification landed
- base: ba2be165 classification tests fail (removals lack the store-only note) | head: 65322bee passes
- live: repro seeds 1-20 all converge with the fix (seeds 1 and 10 failed on main); soak 20x smoke (seeds 1-20) and 20x torture sleep-wake (seeds 1-20): 40/40 with zero I8/I9 failures and no extra documents

R1 reproduced and mechanism confirmed. R2 fixed with regression tests in test/serve/watch-reconciliation-store-removals.test.ts. R3 40 consecutive soak runs converge.

Full gate: lint 0 warnings; bun test 6108 pass, 0 fail.

Also in this PR (after merging main): CHANGELOG sections folded, and four await-thenable lint warnings in the fn-207/fn-208 tests cleared.

stage: impl-review - skipped(policy: repo instructions skip all review stages)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: ba2be165f57e872afdd7db33d065c6f09d55c9de, 65322bee12341a0829ee6963bc9eecb5af400078, edd158542f69e59c4d967024921c5a48f8758ef9, 3052560f939bef8d362999458646f70277d21d72
- Tests: bun run lint:check && bun test
- PRs: