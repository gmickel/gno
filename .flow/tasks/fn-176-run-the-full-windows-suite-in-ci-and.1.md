# fn-176-run-the-full-windows-suite-in-ci-and.1 Correct Windows test scope and verify CI commands

## Description
Implement the parent no-plan release-gate correction.

## Acceptance
Satisfy the parent goal and requirements.

## Done summary
Corrected both Windows workflow commands to Bun's supported --max-concurrency=1 flag. The new executable command-contract regression runs each real workflow command against numbered and unnumbered fixture files; both fail before the fix by running only one file and pass after the fix by running both. CI selection/aggregation regressions and lint pass. Full Windows CI remains a publication prerequisite; no claim of a full Windows run is made by the local fixture test. The v2.5.0 publication workflow was cancelled before npm/release jobs ran.
## Evidence
- Commits:
- Tests: bun test test/scripts/windows-test-scope.test.ts test/scripts/ci.test.ts, bun run lint:check
- PRs: