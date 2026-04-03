# fn-54-re-evaluate-markit-as-a-unified Re-evaluate markit as a unified document conversion backend

## Overview

Revisit [`markit`](https://github.com/Michaelliv/markit) as a possible single replacement for GNO's current document-conversion stack once the upstream project has matured enough to trust in core ingest paths.

Current conclusion after the 2026-04 re-check:

- upstream is meaningfully healthier than before: real releases, active commits, and a real Bun test suite now exist
- happy-path conversion quality for GNO's sample PDF/DOCX/PPTX/XLSX fixtures is good
- however, `markit` is still not ready as a full production replacement for GNO because:
  - `.xlsm` remains unsupported
  - the XLSX converter still ignores sparse cell coordinates and likely shifts cells left on irregular sheets
  - npm/TypeScript build ergonomics still look rough even though `bun test` passes locally

That means `markit` is now credible for future experimental/partial adoption work, but still not a clean drop-in replacement for GNO's current converter stack.

## Scope

- Re-check upstream maturity and maintenance health.
- Re-run smoke tests on GNO conversion fixtures and key failure modes.
- Compare output quality and failure behavior against GNO's current `markitdown-ts` + `officeparser` adapters.
- Decide whether to:
  - keep current adapters,
  - add `markit` as an experimental optional adapter, or
  - replace specific formats only.

## Current Assessment

Re-check findings:

- upstream releases now exist through `v0.5.0`
- upstream test suite exists and passed locally via `bun test`
- GNO fixture smoke passed for:
  - PDF
  - DOCX
  - PPTX
  - XLSX
- `.xlsm` still fails as unsupported
- sparse-sheet behavior still appears unresolved from code inspection because the XLSX converter iterates cells in order rather than honoring coordinate gaps

## Recommended Next Step

Do **not** replace GNO's converter stack wholesale yet.

If we revisit this again, the most promising future work is:

1. verify sparse-sheet behavior on a real irregular workbook
2. decide whether to add `markit` as an experimental optional adapter for happy-path formats only
3. keep `.xlsm` and irregular-sheet handling on the blocker list until upstream closes the gap

## Quick commands

- `cd /Users/gordon/tmp/markit && bun install`
- `bun test`
- `bun run src/main.ts /Users/gordon/work/gno/test/fixtures/conversion/xlsx/sample.xlsx -q`
- `bun run src/main.ts /Users/gordon/work/gno/test/fixtures/conversion/docx/sample.docx -q`
- `bun run src/main.ts /Users/gordon/work/gno/test/fixtures/conversion/pptx/sample.pptx -q`
- `bun run src/main.ts /Users/gordon/work/gno/test/fixtures/conversion/pdf/sample.pdf -q`
- `cp /Users/gordon/work/gno/test/fixtures/conversion/xlsx/sample.xlsx /tmp/markit-sample.xlsm && bun run src/main.ts /tmp/markit-sample.xlsm -q`

## Acceptance

- [ ] Upstream maturity re-checked with concrete release/test/support signals.
- [ ] GNO fixture smoke rerun and documented.
- [ ] `.xlsm` support (or continued lack of support) explicitly re-evaluated.
- [ ] Sparse-sheet XLSX behavior re-tested.
- [ ] Clear recommendation is recorded for future work, without forcing premature adoption.

## References

- Local clone: `/Users/gordon/tmp/markit`
- Upstream: `https://github.com/Michaelliv/markit`
- GNO current adapters:
  - `/Users/gordon/work/gno/src/converters/adapters/markitdownTs/adapter.ts`
  - `/Users/gordon/work/gno/src/converters/adapters/officeparser/adapter.ts`
