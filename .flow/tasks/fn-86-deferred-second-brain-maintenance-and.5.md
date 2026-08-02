---
satisfies: [R7]
---
# fn-86-deferred-second-brain-maintenance-and.5 Verify audit utility safety and all truth surfaces

## Description
Complete audit v1 with adversarial/runtime QA, full gates, docs/schema/skill reconciliation, hosted gno.sh truth surfaces, and a utility/false-positive evidence note that explicitly decides whether any future maintenance discovery is warranted.

**Size:** M
**Files:** `test/audit/`, `test/cli/`, `test/mcp/`, `spec/`, `docs/CLI.md`, `docs/MCP.md`, `docs/CONFIGURATION.md`, `docs/TROUBLESHOOTING.md`, `README.md`, `CHANGELOG.md`, `assets/skill/`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`, `/Users/gordon/work/gno.sh/src/lib/product-pages.ts`

### Approach
- Drive real CLI and MCP runs against disposable clean, broken-link, incomplete-provenance, drifted-index, unreadable, and changed-during-run workspaces.
- Capture deterministic JSON diff, exit codes, no-write proof, performance, and false-positive review.
- Update every repo/hosted truth surface and distinguish content audits from existing egress audit receipts.
- Re-run skill autoresearch; do not create maintenance/apply work unless runtime evidence justifies a separate discovery/spec.

### Investigation targets
**Required** (read before coding):
- `docs/CLI.md` — command reference
- `docs/MCP.md` — tool reference
- `docs/CONFIGURATION.md` — any explicit age/ignore policy
- `docs/TROUBLESHOOTING.md` — partial/unavailable recovery
- `assets/skill/SKILL.md:296` — existing egress-audit terminology
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx` — hosted docs source

**Optional** (reference as needed):
- `scripts/docs-verify.ts` — repo docs gate
- `/Users/gordon/work/gno.sh/src/lib/product-pages.ts` — product claims

### Key context
This task cannot add repairs, contradiction detection, scheduling, or hidden persistence. gno.sh deployment remains a separate post-merge authorized boundary.

## Acceptance
- [ ] Captured CLI/MCP runs prove clean/findings/partial/unavailable/changed behavior, stable JSON IDs, documented exits, and zero workspace/index/config mutation.
- [ ] Full lint/test/eval/docs/package gates and representative performance receipts pass.
- [ ] False-positive/usefulness review records category quality and whether a separate maintenance discovery is justified; no mutation work is auto-created.
- [ ] Specs/schemas, README, CLI/MCP/config/troubleshooting docs, CHANGELOG, skill, and hosted gno.sh pages agree and distinguish egress audits.
- [ ] Skill autoresearch passes or records a justified no-change result; gno.sh local gates and driven docs/product-page QA pass.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
