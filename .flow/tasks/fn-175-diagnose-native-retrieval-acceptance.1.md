# fn-175-diagnose-native-retrieval-acceptance.1 Diagnose and fix native retrieval acceptance instability

## Description
TBD

## Acceptance
Satisfies the spec's Requirements section; judge against it directly.

## Done summary
Diagnosed both native acceptance failures and fixed the one product bug.

- missing-policy is a deterministic noExpand regression (identical in six native runs): the noExpand reader answers "120" to a question with no evidence. The screen is correct; noExpand stays off. No threshold, fixture, or model change.
- The invalid runs came from the five-second expansion budget, which covered model load and generation. It intermittently cancelled the cold f16 expansion load on CUDA and always cancelled CPU expansion (15-22 s). Expansion now runs under models.loadTimeout/inferenceTimeout inside withInferencePage, so a generation timeout falls back without failing the request and caller cancellation still throws.
- After the fix, three native CUDA runs were valid with identical outcomes; live CLI `gno query --explain` on CPU went from `expansion: skipped (timeout)` at 5004 ms (main) to `expansion: enabled` at 10.9 s.
- Docs: HOW-SEARCH-WORKS and TROUBLESHOOTING no longer describe the budget; CHANGELOG Fixed entry.
- Codex gpt-6-astra medium impl-review: SHIP, 0 findings.
- Full bun test green with TMPDIR outside the repo (5 project-affinity tests fail only when TMPDIR is inside the repo cwd).
## Evidence
- Commits: 78506ddc, 83bfbe21, 828cb434
- Tests: bun test, bun run lint:check, bun run docs:verify, bun evals/acceptance/evidence-cli.ts --native (runs 3-5), gno query --explain on CPU
- PRs: