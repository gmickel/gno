# Windows CI: capture request-ID flake and job timeout

## Goal & Context
<!-- scope: business; source: inferred -->

Windows CI occasionally fails `test/cli/capture.test.ts` (request-ID replay): both CLI invocations exit 2 in one run and pass on rerun, on code unrelated to the change under test. Separately, one `test-windows` rerun hung in the Test step for 32 minutes against a normal 11.5; the job has no timeout, so a hang can hold a runner for up to 6 hours.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** [inferred] Find the root cause of the Windows `capture.test.ts` request-ID replay flake from CI logs and a local or CI reproduction (for example lease or ledger timing, Windows ACL setup cost, subprocess startup), and fix it in product or test code without weakening assertions. Errors: if not reproducible after a bounded attempt, add targeted diagnostics that print the CLI stderr on failure and record the finding.
- **R2:** [inferred] `test-windows` (and any other job without one) gets an explicit `timeout-minutes` set with headroom over the observed normal duration (about 12 minutes), so a hung run fails fast instead of holding a runner.

## Boundaries
<!-- scope: business -->

- [inferred] No blanket retries or skips of the test; no change to request-ID semantics.
