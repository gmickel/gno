# fn-54-re-evaluate-markit-as-a-unified.1 Re-run converter evaluation once markit stabilizes

## Description

The 2026-04 re-check shows that `markit` has materially improved and is worth keeping on the radar, but it is still not ready to replace GNO's current converter stack.

What changed since the earlier evaluation:

- upstream now has real tagged releases through `v0.5.0`
- upstream now has a real Bun test suite, and it passed locally on the re-check
- GNO fixture smoke was good on the sample PDF/DOCX/PPTX/XLSX files

What still blocks full adoption:

- `.xlsm` is still unsupported
- sparse / irregular XLSX handling still appears unsafe because the converter does not honor coordinate gaps
- build ergonomics via `npm run build` still look rough, even though `bun test` succeeds

Future follow-up should be biased toward either:

- no adoption yet, or
- experimental/partial adoption for happy-path formats only

Not a full replacement.

## Acceptance

- [ ] Re-check upstream release/test maturity.
- [ ] Re-run GNO fixture smoke on PDF/DOCX/PPTX/XLSX.
- [ ] Re-confirm `.xlsm` status.
- [ ] Re-check sparse XLSX behavior rather than assuming it is fixed.
- [ ] Record a future-facing recommendation: no adoption, experimental partial adoption, or broader adoption.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
