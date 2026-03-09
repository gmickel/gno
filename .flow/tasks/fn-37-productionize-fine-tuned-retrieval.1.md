# fn-37-productionize-fine-tuned-retrieval.1 Automate model promotion artifacts

## Description

Automate the path from a completed fine-tune run to a portable, benchmarked promotion bundle with no manual checkpoint picking.

## Acceptance

Automate the promotion path from a completed fine-tune run to a portable, benchmarked artifact.

Acceptance:

- pick best checkpoint automatically from run logs
- fuse/dequantize/export path works for named runs
- benchmark summary is emitted automatically for the exported artifact
- release metadata/model-card skeleton is generated for the promoted run
- commands are documented in the sandbox README

## Done summary

Implemented the automated promotion path for fine-tune runs. The pipeline now selects the best checkpoint from logs, fuses/dequantizes it, exports GGUF, smokes the artifact through gno, benchmarks it, and generates promotion artifacts (model card, install snippet, summary JSON). Proved end-to-end on mlx-run1 with a measurable benchmark win over the shipped baseline.

## Evidence

- Commits:
- Tests: bun run research:finetune:promote mlx-run1, bun test test/research/run-selection.test.ts test/research/promotion-bundle.test.ts, bun run lint:check
- PRs:
