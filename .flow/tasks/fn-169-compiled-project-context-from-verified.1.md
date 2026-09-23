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
Blocked:
R6 preregistered quality gate failed. The 36-draw fixed-model paired study showed identical grounded success (12/18 each) and all supplied evidence preserved, but a required source was already omitted by the baseline Capsule as redundant_coverage. The frozen abstention key also failed in both arms; its possible ambiguity is retained without rescoring. See .flow/artifacts/fn-169-compiled-project-context-from-verified/eval/REPORT.md. Implementation and live surface QA are complete; keep delivery draft, no release/deployment or automatic integration. Follow-up: fn-174-preserve-complementary-capsule-evidence.
## Evidence
- Commits:
- Tests:
- PRs:
