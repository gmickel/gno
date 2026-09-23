# Restore full Windows test compatibility

## Goal

Make the complete Windows regression suite pass without filename filtering, blanket skips, relaxed assertions or hidden failures, then unblock coordinated publication.

## Evidence

The corrected command in PR #245 is `bun test --max-concurrency=1`. Run 35879140015 recorded 4,135 passing tests and 179 failures before cancellation after about 20 minutes; the run did not finish, so these are partial counts. The previous unsupported flag had silently selected only 22 tests. Failure identities are retained in `.flow/artifacts/fn-176-run-the-full-windows-suite-in-ci-and/windows-partial-run.json`; raw diagnostics remain available through the Actions job 107242846993.

## Requirements

Group failures by root cause before editing. Distinguish platform-dependent fixture/path assumptions from product defects. Observed clusters include integration fixtures, watcher snapshots/reconciliation, MCP config validation, native lifecycle fixtures, macOS signing-script tests and timeouts in restoration tests. The initial trace-retrieval grouping included subsequent integration output; grouping every file header attributes those failures to the integration fixtures. Use focused real reproductions; do not treat every failed case as a separate defect.

Investigate SQLite resource release as a hypothesis: Bun's default close leaves separately prepared statements usable, while close(true) finalizes them. Establish whether this contributes to Windows cleanup/locking before changing the adapter.

Keep each correction minimal and preserve public behavior unless a demonstrated product defect requires it. Run affected Linux/macOS checks and a complete Windows run. Preserve the initial negative evidence and verify the executed inventory, not just a green job label. Do not publish until the corrected full gate passes. Any runtime changes require corresponding Git and gno.sh docs/CLI/MCP/SDK/UI/skill updates only where the supported contract changes.

## Boundaries

Do not weaken the new workflow command-contract regression or restore the unsupported concurrency flag. Do not move the aborted v2.5.0 tag. A future verified release uses a fresh version. This compatibility work is separate from the completed compiled-context feature and from fn-170 mutation receipts.

## Implementation evidence

- SQLite close regression proves separately prepared statements are finalized immediately. SQLite fallback contention now yields between immediate attempts, allowing same-process writers to release without blocking the event loop.
- Fixture corrections isolate Windows APPDATA, use native paths and file URLs, preserve virtual filesystem keys, and replace Unix-only launcher assumptions. Native safety/fallback assertions remain active.
- Windows audit output uses a private directory before writing contents and verifies the final file ACL. Native acceptance captures use Windows ACL and CIM observations; archived instrumentation is bundled inside the harness namespace with separate source and deployed hashes. Runtime snapshot files remain unchanged.
- Full Windows CI remains the completion gate; focused Linux results alone do not establish Windows compatibility.

- Complete native Windows run 35912746439 on fc94700b passed 5,373 tests with 29 existing platform skips and zero failures across 643 files. Bootstrap security-check remediation is verified separately before final landing.
