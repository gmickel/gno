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
TBD

## Evidence
- Commits:
- Tests:
- PRs:
