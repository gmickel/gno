---
satisfies: [R1, R4]
---
# fn-86-deferred-second-brain-maintenance-and.1 Freeze deterministic read-only audit report contract

## Description
Define the versioned audit runner/report/finding contract, no-write port boundary, stable finding identity, status/exit taxonomy, snapshot consistency rules, filters/limits, and deterministic fixture harness. Prove identical snapshots serialize semantically identically and mid-run changes cannot report clean.

**Size:** M
**Files:** `src/core/audit.ts`, `spec/cli.md`, `spec/mcp.md`, `spec/output-schemas/audit-report.schema.json`, `test/audit/report.test.ts`

### Approach
- Separate rule evaluation from human/JSON rendering.
- Snapshot config/rules/scope/source-index evidence before category scans.
- Derive stable IDs from rule + normalized subject/location + evidence fingerprint.
- Make skip/unavailable/inconclusive and partial/changed-during-run first-class.

### Investigation targets
**Required** (read before coding):
- `src/core/egress-audit.ts` — content-free receipt/versioning precedent only
- `src/store/sqlite/adapter.ts:508` — transaction/snapshot patterns
- `src/store/types.ts` — read-only store port shapes
- `src/cli/commands/doctor.ts` — CLI status/exit rendering conventions
- `spec/output-schemas/` — schema/version contract patterns

**Optional** (reference as needed):
- `src/mcp/tools/status.ts` — read-only MCP result patterns
- `test/spec/schemas/` — contract-test conventions

### Key context
This is not the existing egress audit and must not reuse its name ambiguously. No audit baseline/finding is persisted to the database in v1.

## Acceptance
- [ ] Versioned report/finding schemas include scope, capabilities, fingerprints, versions, stable IDs, evidence, counts, timing, truncation, and complete/partial/changed/failed status.
- [ ] Rule status and exit taxonomy distinguish pass/fail/skip/unavailable/inconclusive, findings present, invalid input, partial evidence, and runtime failure.
- [ ] Traversal-order permutations produce equivalent canonical JSON and stable finding IDs for identical snapshots.
- [ ] Mid-run source/index changes yield bounded retry or `changed_during_audit`, never a clean report.
- [ ] No-write contract tests prove source/config/store are unchanged; focused schema/core tests and lint pass.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
