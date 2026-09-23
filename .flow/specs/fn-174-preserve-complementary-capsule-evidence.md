# Preserve complementary Capsule evidence beyond lexical facet coverage

## Goal

Prevent a Context Capsule from discarding a complementary source solely because another passage covers the same lexical query facets. The fixed compiled-context evaluation exposes a security approval source retained while the operations rollback checklist is omitted as `redundant_coverage`.

## Requirements

- Reproduce the omission with the unchanged `evals/fixtures/compiled-context/cases.json` two_sources case and retain the failed baseline.
- Identify the smallest justified evidence-selection change. Preserve deterministic ordering, whole-output budgets, overlap/deduplication, privacy and bounded retrieval. Do not introduce a second selector.
- Protect ordinary Capsule and compiled-context callers with focused regressions. Run the existing retrieval acceptance gates and the unchanged paired compiled-context study; preserve negative outcomes and thresholds.
- Separately preregister an unambiguous missing-fact abstention probe before drawing it. Keep the original failed abstention result and do not replace or rescore it.
- Update affected Git and gno.sh documentation only where supported behavior changes. Changes to the CLI, MCP, SDK, UI and shipped skill are conditional on a real contract change.

## Evidence

The retained study in `.flow/artifacts/fn-169-compiled-project-context-from-verified/eval/REPORT.md` records 36 valid paired draws, identical 12/18 grounded success, and exact preservation of all supplied evidence by the compiler. The required-source guard failed before compilation. The fn-169 quality gate remains failed until independently resolved; smaller artifacts alone do not establish sufficient context.
