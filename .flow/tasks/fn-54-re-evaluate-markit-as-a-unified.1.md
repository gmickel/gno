# fn-54-re-evaluate-markit-as-a-unified.1 Re-run converter evaluation once markit stabilizes

## Description
Re-run the `markit` evaluation once the upstream project is more mature.

Use the same formats and failure modes that matter for GNO, not just happy-path marketing demos. The review should be biased toward whether `markit` can safely replace part or all of GNO's current conversion pipeline.

Focus especially on:
- `.xlsm` support
- sparse / irregular XLSX sheets
- PPTX text spacing / list fidelity
- deterministic output and error behavior
- whether the project has added a real automated test suite
## Acceptance
- [ ] Re-run `markit` on GNO PDF/DOCX/XLSX/PPTX fixtures.
- [ ] Re-run at least one sparse XLSX edge case and one real spreadsheet repro.
- [ ] Record exact regressions/wins vs GNO's current adapters.
- [ ] State whether `markit` is ready for experimental adoption, partial adoption, or no adoption.
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
