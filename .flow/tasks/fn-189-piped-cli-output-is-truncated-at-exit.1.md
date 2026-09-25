---
satisfies: [R1, R2]
---
# fn-189-piped-cli-output-is-truncated-at-exit.1 Implement Piped CLI output is truncated at exit

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
The CLI entry point now ends stdout and stderr and waits for their queued writes before `process.exit`. Piped output larger than the pipe buffer now reaches the consumer in full, and an early-closing consumer (EPIPE) still lets the process exit promptly with the command's exit code. `test/cli/piped-output.test.ts` runs the real CLI as a subprocess and covers three cases (R1, R2): a slow consumer receives more than 1 MB of JSON, byte-identical to the file-redirect output; an early-closing reader does not hang the process; and a piped failure keeps exit code 2.

Bun's `process.stdout` reports `writableLength` 0 and fires an empty write's callback immediately, so `end()` is the flush that actually waits. The other `process.exit` sites (MCP server shutdown, native worker) do not follow large piped output and were left unchanged. The session import child exits through the same `cleanupAndExit`, so the fix covers it too. With a slow consumer on Bun 1.4.2 and 1.3.14, `gno get --json` on a 1.5 MB document returned 8192 bytes piped before the fix and 1520833 bytes (the file-redirect size) after it. Windows and macOS were not run.

Tier: session

stage: impl-review - ran (codex gpt-6-astra medium, 3-draw fan-out, SHIP in round 1)
## Evidence
- Commits: 183b8a1ac3ea2023933a63c99c9104b05fb247a8
- Tests: baseline: not captured pre-edit (full suite run post-change only), mise exec bun@1.4.2 -- bun test test/cli/piped-output.test.ts (red before fix, green after), mise exec bun@1.3.14 -- bun test test/cli/piped-output.test.ts (red before fix, green after), mise exec bun@1.4.2 -- bun test (5750 pass, 2 skip, 0 fail), mise exec bun@1.4.2 -- bun run lint:check (0 errors, 38 pre-existing warnings)
- PRs: