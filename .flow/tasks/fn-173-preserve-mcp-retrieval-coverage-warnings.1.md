---
satisfies: [R1, R2, R3, R4]
---
# fn-173-preserve-mcp-retrieval-coverage-warnings.1 Preserve MCP retrieval warnings and advertise safe filter usage

## Description
TBD

## Acceptance
Satisfy all acceptance criteria in the parent spec.

## Done summary
MCP search, vector search and hybrid query now retain retrieval warning codes/messages in text for empty and nonempty results. Verified Ask exposes incomplete Capsule metadata coverage. Shared typed-filter descriptions cover all six relevant MCP inputs, preserving user filters and limiting diagnosis to known expected targets.

Repository MCP contract/docs and Unreleased changelog updated. Agent block v3, its hash, skill assets, predicate semantics and ranking remain unchanged. Existing hosted metadata docs already describe incomplete-coverage semantics; no hosted behavior or claims require a change.

Verification: full suite 5360 passed, two existing skips, zero failures; final MCP/verified-Ask suite 270 passed. Typecheck, lint/format and docs verification passed. Deliberate current wire-golden update changes filter descriptions only; historical SDK capture remains unchanged.

Live QA: isolated config/index with synthetic valid/invalid metadata. Six real stdio comparisons reproduce warning loss in the npm package for GNO 2.4.0 and show corrected text after the fix; structuredContent is exactly unchanged in all six. Native verified Ask exposes the warning too. Runtime processes closed normally.

Agent screens: prescribed CLI skill eval 100%, 47/47 checks across 20 unchanged scenarios. MCP usage 47/49: fast_mode selected gno_search instead of the scorer's gno_query fast=true. Known-target diagnostic probe retained the filter. Unknown-target probe still dropped the filter and inferred a match from scope counts, including one retained rerun after clearer wording. All actual model receipts are claude-sonnet-4-5-20250929 via cl2. These single-draw screens do not establish compliance; the runtime warning-delivery contract is verified separately. No unrelated skill changes or extra enforcement framework added.

stage: plan - skipped(policy: one no-plan owner)
stage: plan-review - skipped(policy: repository skips unrequested reviews)
stage: implementation-review - skipped(policy: repository skips unrequested reviews)
stage: completion-review - skipped(policy: repository skips unrequested reviews)
Release boundary: include with fn-169's next release. No version bump, tag, release, deployment or fn-169 implementation.
## Evidence
- Commits: b4c1b16c655de53312f35f847e6bb234b24d6542
- Tests: bun test:5360pass2skip0fail, bun test test/mcp test/pipeline/verified-ask.test.ts:270pass, bun run lint:check, bun run typecheck, bun run docs:verify:15pass2modelskips, real stdio before/after6cases + verifiedAsk, CLI skill eval47/47; MCP usage 47/49; warning probe negative retained
- PRs: