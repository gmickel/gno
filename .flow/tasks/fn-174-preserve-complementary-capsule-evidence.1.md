# fn-174-preserve-complementary-capsule-evidence.1 Preserve complementary Capsule evidence and rerun fixed evals

## Description
Implement the parent no-plan spec in the existing isolated feature branch.

## Acceptance
Satisfy the goal and every requirement in the parent spec.

## Done summary
Removed the selector's rejection of distinct passages solely because their lexical query facets were already covered. Uncovered facets still guide ordering; deduplication, overlap, share caps and whole-output budgets remain enforced. The failing two-source reproduction now retains both approvals.

Full tests5386pass/2existing-skips;364UItests pass after fixing Happy DOM download navigation leakage; lint and docs gates pass. Unchanged36-draw paired study passes: two-source0/3→3/3 in both arms, overall12/18→15/18, no regression; separate unambiguous abstention probe6/6passes. Original negative draws retained. CLI/MCP/REST/browser and Git/gno.sh documentation verified. Native noExpand comparison fails on the pre-fix revision too; post-fix capture also has an inference error, both retained under native/ and tracked in fn-175. No native pass, changed-default, merge, release or deployment claim.
## Evidence
- Commits: 46c16e3e6cfdf81259cfb719996e78fc0c32d67b
- Tests: mise exec bun@1.4.2 -- bun test (5386 pass,2 skip), mise exec bun@1.4.2 -- bun test test/serve/public (364 pass), bun run lint:check, bun run docs:verify, bun run eval:hybrid (86%), fixed paired reader (36 draws,PASS), supplemental abstention (6 draws,PASS), isolated live CLI/MCP/REST/browser and site QA
- PRs: https://github.com/gmickel/gno/pull/244, https://github.com/gmickel/gno.sh/pull/69