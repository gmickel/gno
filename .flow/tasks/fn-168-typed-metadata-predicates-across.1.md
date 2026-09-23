---
satisfies: [R1, R2, R3, R4, R5, R6, R7]
---
# fn-168-typed-metadata-predicates-across.1 Implement typed metadata predicates across retrieval surfaces

## Description
TBD

## Acceptance
Every R-ID in the parent spec's Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Implemented typed metadata extraction, SQL eligibility, shared predicates, ingestion repair, and scoped diagnostics across CLI/MCP/SDK/REST/Web UI. Filtered Capsules use1.2 while1.0/1.1 remain valid; predicates bind canonical identity and trace replay. Invalid/pending documents are excluded, coverage stays explicit, and valid Capsule evidence remains usable.

Verification: full5355-pass suite (2existing skips),407 post-QA tests,357 post-review tests,55 final affected tests; typecheck, lint/format, documentation checks and site build/check/typecheck/Markdown tests pass. Deterministic pinned oracle gate passes at100/1000/10000 docs; deliberate negative control fails. Native CUDA hybrid/vector smoke and ordinary Ask retain expected filtered evidence. Native verified Ask abstention retained without claiming answer-quality acceptance.

Live isolated config/index and synthetic source corpus exercised CLI, SDK, REST, real stdio MCP, Search/Ask and metadata display. Browser QA covers invalid/corrected values, nested predicates, collection persistence, mobile375px, repair/backfill, corrupt-PDF and invalid-note coverage. Fifteen site pages were checked at desktop/mobile, with copy/navigation and Markdown/LLM parity. QA exposed and fixed verified-Ask filter loss, stale UI results, scope loss on reload, footer overflow and resident-fast Capsule capability mismatch.

Shipped skill eval:38/38 cases107/107 checks, six typed scenarios repeated three times; initial value/values failures retained and corrected through one minimal example. Same actual model pinned, claude-sonnet-4-5-20250929 through cl2. Project Claude/Codex installations and docs parity verified.

Requested implementation review: actual claude-opus-5-5/high through cl2, same session, final SHIP with all findings fixed. Standalone head-bound review used because the task-scoped runner drops --focus. Receipt committed. No speculative frameworks adopted; duplicate record metadata validation/storage removed.

stage: plan - skipped(policy: no-plan single implicit owner)
stage: plan-review - skipped(policy: existing reviewed spec; no additional design review requested)
stage: implementation-review - ran (explicit Opus5.5/cl2 override)
stage: completion-review - skipped(policy: repository skips unrequested reviews)
Tracker disabled. Stop at linked PR handoff. No merge, deployment, version bump or publication.
## Evidence
- Commits: bd71abff, 7e3281fb, b732d999
- Tests: bun test:5355pass2skip0fail, bun test affected:407pass; review fixes357pass; final55pass, bun run typecheck, bun run lint:check, bun run docs:verify:15pass2model-skips, bun evals/acceptance/typed-metadata.ts --output <new-report.json>; negative control exits1, skill usage eval38/38cases107/107checks, isolated live CLI/SDK/REST/stdioMCP/nativeCUDA/UI+15sitepages QA, gno.sh check/typecheck/build +8Markdown tests
- PRs: