---
satisfies: [R1, R2, R3, R4, R5, R6]
---
# fn-167-adversarial-retrieval-evidence-coverage.1 Implement adversarial retrieval evidence coverage gate

## Description
Implement the parent spec as one cohesive change using the shipped acceptance capture facilities. Keep production ranking and public interfaces unchanged; retain unsuccessful comparisons and update both documentation surfaces.
## Acceptance
Every R-ID in the parent spec's Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Implemented the developer-only adversarial evidence gate, strict schemas, fourteen frozen case families, exact observed-passage scoring, and current/noExpand native collection using existing capture hooks. No production ranking/model/public-API changes or shipped skill edits.

R1/R2: versioned source/span pins, alternative sufficient sets, same-input fragment coverage, explicit missing/partial/clipped/unknown states, and source/scope/budget validation.
R3/R4: paired guards retain invalid observations and baseline misses. Controlled CLI replay passed; removing required evidence failed as intended. CUDA was unavailable under host VRAM contention. The full CPU attempt retained 28 observations but current-arm expansion deadlines invalidate comparison; no ranking candidate is adopted. Latest reader-only smoke verified the exact lookup and rejected an unsupported answer on the missing-information fixture. This is not a positive native ranking or production Ask quality claim.
R5/R6: reuse shipped capture/manifest primitives; preserve current weights, default modes and public contracts. GNO docs and five gno.sh pages now explain complete passage evidence and its limits. Existing skill guidance already covers diagnosis, citations and abstention.

Verification: full suite 5324 pass / 2 skip / 0 fail; later affected acceptance/schema suites 117 pass. Typecheck, standard lint/format and explicit nine-file eval lint pass. Docs verification 15 pass / 2 model-dependent skips. Site check/typecheck/build and eight Markdown tests pass; driven desktop/mobile, copy controls, navigation, Markdown twins and LLM projections pass with clean final console/network.

Evidence: .flow/artifacts/fn-167-adversarial-retrieval-evidence-coverage/RESULTS.md and its native/QA subdirectories. Site companion commit ab7b13206027bccc0282e24a9c9fb307d391a122 in gno.sh.
Release boundary: eval/source documentation only; no version bump/tag/npm/desktop release. Recommend separate follow-on user-visible releases for fn-168 through fn-172, with fn-171 before fn-172. Merge/deployment/publication remain separately authorized.

stage: implementation - ran (active harness)
stage: plan - skipped(policy: existing no-plan spec)
stage: impl-review - skipped(policy: repository skips review stages)
stage: completion-review - skipped(policy: repository skips review stages)
stage: plan-sync - skipped(config: disabled)
stage: qa - ran (live developer CLI and local gno.sh; no ranking-quality certification)
## Evidence
- Commits: a136372f50591587db6f1ce2f9204c43fc275f4a
- Tests: bun test: 5324 pass, 2 skip, 0 fail, bun test test/eval/acceptance test/spec/schemas/evidence-gate.test.ts: 117 pass, bun run typecheck: pass, bun run lint:check: pass; explicit eval lint: 9 files, zero warnings/errors, bun run docs:verify: 15 pass, 2 model skips, native current/noExpand: INVALID comparison retained; no adoption, reader-only native smoke: exact lookup verified; unsupported missing-information answer correctly rejected, gno.sh check/typecheck/build + docs-markdown tests + live five-page desktop/mobile QA: pass
- PRs: