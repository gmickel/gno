---
satisfies: [R1, R2, R3, R4, R5, R6, R7, R8]
---
# fn-225-opt-in-collection-link-and-path-rules.1 Implement opt-in collection link and path rules for gno audit

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Collection config gains an optional strict `audit` block (`linkCollections`, `externalUrls: report|ignore`, `paths`), validated in the schema; unknown linkCollections names are rejected on the collections array with a message naming them. New `src/core/audit-collection-rules.ts` evaluates `links.collection-policy`, `links.external-url` (scheme:// URLs in mirror text outside getExcludedRanges; gno:// and file:// are local; missing text = unchecked warning) and `links.path-layout` (Bun.Glob on recordSourcePath ?? relPath), wired into the links category in audit-workspace; mirror text is loaded only when an audited collection reports URLs. Rules are emitted only for audited collections that configure them; config fingerprint adds `audit` only when present; LINK_AUDIT_RULE_VERSION 1.4. Docs: CONFIGURATION (Collection audit rules + field table), CLI, MCP, spec/cli.md, spec/mcp.md, CHANGELOG. Skill: SKILL.md audit paragraph with a bash-form setup recipe and an external-url inspection command, cli-reference `gno audit` entry, mcp-reference Audits, examples. Eval: audit_link_policy + audit_finding_report added; 100% (62/62) twice.

Tests: test/audit/collection-rules.test.ts (17); full suite 6377 pass / 0 fail.

stage: impl-review - skipped(policy: repo CLAUDE.md skips all review stages)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 623f5240
- Tests: bun test test/audit/collection-rules.test.ts, bun test, uv run eval.py (autoresearch gno-skill, 100% x2)
- PRs: