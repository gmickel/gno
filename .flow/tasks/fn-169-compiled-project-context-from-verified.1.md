---
satisfies: [R1, R2, R3, R4, R5, R6]
---
# fn-169-compiled-project-context-from-verified.1 Implement compiled project context from verified Capsules

## Description
Implement the parent no-plan spec through the shared Capsule selector/verifier and explicit local publication helpers. CLI, MCP, SDK, REST, browser export, ingestion exclusion, repository documentation and linked gno.sh documentation are implemented.

Verification evidence is retained under `.flow/artifacts/fn-169-compiled-project-context-from-verified/`. R6 remains blocked by the preregistered paired-eval failure; `fn-174-preserve-complementary-capsule-evidence` records the required follow-up. Do not mark this task complete or publish the feature on the strength of passing implementation tests alone.
## Acceptance
Satisfy every R-ID in the parent spec acceptance criteria.

## Done summary
Implemented the compiled-context contract across local CLI/SDK file operations, inline MCP/REST, browser preview/check/download, ingestion exclusion, shipped skills and both documentation surfaces. The fn-174 correction resolves the recorded missing-source gate without changing fixtures or thresholds. The original paired comparison now passes after the correction; original failures and a separately preregistered abstention probe remain retained.

Validation:5386tests passed/2existing skips,364UItests after download-test isolation correction, lint,15documentation checks,47/47skill checks, live isolated CLI/MCP/REST/browser QA and site check/typecheck/build/27tests plus driven pages. Native noExpand policy screen has an independent pre-existing failure tracked in fn-175; no native pass claimed. Delivery remains the existing linked PRs244 and69, with no merge, product release or site deployment.
## Evidence
- Commits: 46c16e3e6cfdf81259cfb719996e78fc0c32d67b
- Tests: mise exec bun@1.4.2 -- bun test (5386 pass,2 skip), mise exec bun@1.4.2 -- bun test test/serve/public (364 pass), bun run lint:check, bun run docs:verify, bun run eval:hybrid (86%), fixed paired reader (36 draws,PASS), supplemental abstention (6 draws,PASS), isolated live CLI/MCP/REST/browser and site QA
- PRs: https://github.com/gmickel/gno/pull/244, https://github.com/gmickel/gno.sh/pull/69