# fn-37-productionize-fine-tuned-retrieval.1 Automate model promotion artifacts

## Description
TBD

## Acceptance
Automate the promotion path from a completed fine-tune run to a portable, benchmarked artifact.

Acceptance:
- pick best checkpoint automatically from run logs
- fuse/dequantize/export path works for named runs
- benchmark summary is emitted automatically for the exported artifact
- release metadata/model-card skeleton is generated for the promoted run
- commands are documented in the sandbox README


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
