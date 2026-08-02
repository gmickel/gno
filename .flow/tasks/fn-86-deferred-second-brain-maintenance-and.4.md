---
satisfies: [R4, R5, R6]
---
# fn-86-deferred-second-brain-maintenance-and.4 Expose audit reports through CLI and read-only MCP

## Description
Expose the shared runner through `gno audit` human/JSON CLI and one read-only MCP tool with category selection, existing-compatible filters, output bounds, progress/cancellation, stable exit/status behavior, and representative large-index performance receipts.

**Size:** M
**Files:** `src/cli/program.ts`, `src/cli/commands/audit.ts`, `src/mcp/tools/audit.ts`, `spec/cli.md`, `spec/mcp.md`, `test/cli/commands/audit.test.ts`, `test/mcp/tools/audit.test.ts`

### Approach
- Human output renders the canonical report; it does not reclassify findings.
- Reuse collection/path/tag filter grammar only where semantics are clear.
- Mark MCP read-only and prove no mutation independently of annotations.
- Stream/progress/cancel safely and retain total/completeness truth under `--max-findings`.

### Investigation targets
**Required** (read before coding):
- `src/cli/program.ts:2198-2229` — unrelated egress-audit registration/terminology trap
- `src/cli/commands/doctor.ts` — exit/status rendering
- `src/mcp/tools/status.ts` — read-only MCP pattern
- `src/mcp/tools/workspace-write.ts:169-173` — explicit write-gate contrast
- `spec/mcp.md` — tool schema/version conventions

**Optional** (reference as needed):
- `src/cli/commands/links.ts` — current link-oriented CLI filters/output if present
- `test/mcp/tools/links.test.ts` — MCP link test patterns

### Key context
`readOnlyHint` is metadata, not proof. Cancellation/truncation must return partial status rather than a false clean report. No REST/UI surface in v1.

## Acceptance
- [ ] CLI categories/all, filters, JSON/human rendering, max-findings, progress/cancel, and documented exit codes consume one semantic report.
- [ ] MCP shares category/filter/schema/status semantics, is content-bounded, and no-write tests pass regardless of annotations.
- [ ] Clean, findings, partial, unavailable, changed-during-run, invalid, cancellation, and runtime failure fixtures behave consistently across CLI/MCP.
- [ ] Representative large-index receipts show bounded memory/output and truthful timings/counts with no per-finding scan growth.
- [ ] CLI/MCP contract tests, package smoke as applicable, and lint pass.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
