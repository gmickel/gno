# fn-102-knowledge-delta-and-capsule.6 Resolve PR 143 review findings

## Description
Resolve the six P1 findings from PR #143 review: UTF-8-safe journal deltas,
SQL-bounded retention, race-free saved-Capsule registration watermarks,
journaling conversion-failure disappearance, fail-closed optional selectors,
and nonzero/manual-reverification failure reporting.

## Acceptance
- [ ] Structural deltas cannot violate migration 015 UTF-8 JSON byte caps.
- [ ] Append retention avoids materializing the retained journal and preserves age/count/byte/cursor behavior.
- [ ] Registration cannot skip a journal change concurrent with Capsule loading.
- [ ] Conversion failure journals the document/evidence disappearance transactionally.
- [ ] Empty optional collection/change selectors fail closed across CLI, REST, SDK, and MCP.
- [ ] Failed terminal and JSON reverification output remains informative and exits nonzero.
- [ ] Regression tests, docs/spec, lint, typecheck, and full tests pass.

## Done summary
Resolved all six PR #143 review findings.

- Bounded journal structure values by serialized UTF-8 bytes and enforced the
  migration 015 JSON-column limits.
- Added transactional retained-entry/byte counters and bounded oldest-prefix
  retention scans, including v16-to-v17 backfill.
- Closed the saved-Capsule registration watermark race.
- Journaled successful-document to conversion-failure evidence disappearance.
- Rejected empty optional selectors across core, CLI, REST, SDK, and MCP.
- Kept failed manual reverification output informative while exiting nonzero.
- Updated CLI/spec/troubleshooting/changelog and hosted public truth.

Regression coverage includes Unicode/escaping/collision bounds, 100,000-row
retention behavior, migration backfill, concurrent registration, conversion
failure scheduling, cross-surface selector validation, and CLI exit behavior.
## Evidence
- Commits: 88198b2
- Tests: bun test (2842 pass, 1 expected Windows skip, 0 fail), bun run lint:check, bun run typecheck, bun run docs:verify (13 pass, 2 model-cache skips), bun test test/store/change-journal.test.ts (12 pass), .flow/bin/flowctl validate --all (110 specs, 315 tasks, valid)
- PRs: 143