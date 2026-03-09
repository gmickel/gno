# fn-37-productionize-fine-tuned-retrieval.2 Document fine-tuned model workflow

## Description

Document the fine-tuned model workflow for both contributors and users, including portability constraints and troubleshooting.

## Acceptance

Document the fine-tuned model workflow for both contributors and users.

Acceptance:

- research/finetune docs cover local training, export, selection, and benchmarking
- user-facing docs explain how to point a custom preset at a fine-tuned model
- docs explain portability constraints clearly (Mac-only training, portable output)
- troubleshooting notes exist for export/runtime blockers

## Done summary

Expanded both sandbox and user-facing documentation for fine-tuned models. Added a dedicated Fine-Tuned Models guide, documented custom preset usage, clarified Mac-only training vs portable artifacts, and added troubleshooting for export/runtime/benchmark issues.

## Evidence

- Commits:
- Tests: bun run docs:verify, bun run lint:check
- PRs:
