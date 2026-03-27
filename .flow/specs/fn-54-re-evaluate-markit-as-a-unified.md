# fn-54-re-evaluate-markit-as-a-unified Re-evaluate markit as a unified document conversion backend

## Overview
Revisit [`markit`](https://github.com/Michaelliv/markit) as a possible single replacement for GNO's current document-conversion stack once the upstream project has matured enough to trust in core ingest paths.

Current conclusion: promising for happy-path PDF/DOCX/XLSX/PPTX conversion, but not ready for production adoption in GNO because the project is still brand new, has no real automated test suite, does not support `.xlsm`, and mis-handles sparse XLSX sheets by shifting cells left instead of honoring cell coordinates.

## Scope
- Re-evaluate upstream project maturity and maintenance health.
- Re-run smoke tests on GNO conversion fixtures and real-world failing spreadsheets.
- Compare output quality and failure behavior against GNO's current `markitdown-ts` + `officeparser` adapters.
- Decide whether to:
  - keep current adapters,
  - add `markit` as an experimental optional adapter, or
  - replace specific formats only.

## Approach
1. Check upstream stability signals:
   - release cadence
   - issue volume / responsiveness
   - automated tests
   - supported formats, especially `.xlsm`
2. Re-run the converter bakeoff on:
   - GNO fixture corpus
   - at least one sparse XLSX sheet
   - at least one real spreadsheet that previously failed in GNO
3. Document exact wins/regressions by format.
4. Only consider migration if `markit` is at least parity on:
   - PDF
   - DOCX
   - PPTX
   - XLSX
   - error handling / determinism

## Quick commands
- `cd /Users/gordon/tmp/markit && bun install && bun run build`
- `bun test`
- `bun dist/main.js /Users/gordon/work/gno/test/fixtures/conversion/xlsx/sample.xlsx -q`
- `bun dist/main.js /Users/gordon/work/gno/test/fixtures/conversion/pptx/sample.pptx -q`
- `cd /Users/gordon/work/gno && bun test test/converters/integration.test.ts`

## Acceptance
- [ ] Upstream maturity re-checked with concrete release/test/support signals.
- [ ] GNO fixture smoke rerun and documented.
- [ ] `.xlsm` support (or continued lack of support) explicitly re-evaluated.
- [ ] Sparse-sheet XLSX behavior re-tested.
- [ ] Clear go/no-go recommendation recorded for GNO adoption.

## References
- Local clone: `/Users/gordon/tmp/markit`
- Upstream: `https://github.com/Michaelliv/markit`
- GNO current adapters:
  - `/Users/gordon/work/gno/src/converters/adapters/markitdownTs/adapter.ts`
  - `/Users/gordon/work/gno/src/converters/adapters/officeparser/adapter.ts`
