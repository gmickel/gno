# fn-73-gno-runtime-hardening.10 Keep serve available when PDF conversion fails

## Description

TBD

## Acceptance

- A malformed or structurally invalid PDF is classified as a non-fatal CORRUPT conversion failure.
- Starting `gno serve` and its initial sync continues when such a PDF exists.
- The affected source path is visible in a concise diagnostic without a dependency stack dump.
- A regression test covers the reported invalid-PDF failure.
- Relevant changelog and troubleshooting documentation are current.

## Done summary
Rejected structurally incomplete PDFs before `markitdown-ts` invokes its noisy,
event-loop-blocking parser. Recorded conversion failures with the current ingest
version and skipped unchanged non-retryable failures on later syncs. Added
converter and ingestion regressions plus troubleshooting, Web UI, and changelog
documentation.
## Evidence
- Commits:
- Tests: bun test test/converters/integration.test.ts test/ingestion/sync-conversion-errors.test.ts, bun run lint:check, bun test, bun run docs:verify, bun run test:package
- PRs: