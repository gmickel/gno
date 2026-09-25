# Error schema lists the CLI BUSY code

## Goal & Context
<!-- scope: business; source: inferred -->

The CLI already emits a `BUSY` error code (exit 4) for write-lease contention and pending requests, but `spec/output-schemas/error.schema.json` does not list it, so a schema-validating client rejects a valid error payload.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** [inferred] `error.schema.json` includes every error code the CLI can emit, including `BUSY`, and a contract test validates a real BUSY payload from a contended write. Errors: the test fails if a CLI error code is added without updating the schema.
- **R2:** [inferred] spec/cli.md exit-code documentation matches.
