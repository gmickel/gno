# Windows request-ID writes start PowerShell on every CLI call

## Goal & Context
<!-- scope: business; source: inferred -->

On Windows, every CLI invocation that uses a request ID (`gno capture --request-id`, `gno remember --request-id`) checks the private write-receipts ledger directory's owner-only permissions by starting PowerShell. The "already checked" result is cached only for the current process, so each CLI call pays about 0.3-0.4 s warm and several seconds on a cold machine. Agents that retry-safe every write feel this on every call.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** [inferred] A second and later CLI call with a request ID on Windows does not start PowerShell when the ledger directory's owner-only permissions were already verified and have not changed, without weakening the fail-closed check (a directory another principal can access is still refused before any write). Measure warm and cold per-call cost before and after on a Windows runner.
- **R2:** [inferred] Tests cover: first call verifies and records, a later call skips the process spawn, and a permissions change (or a replaced directory) is detected and refused.

## Boundaries
<!-- scope: business -->

- [inferred] No change to which permissions the ledger requires; no new configuration knob.
