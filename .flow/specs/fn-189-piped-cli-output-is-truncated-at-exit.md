# Piped CLI output is truncated at exit

## Goal & Context
<!-- scope: business; source: inferred -->

When a GNO command's stdout is a pipe, output larger than the pipe buffer is cut off: `gno search --json -n 50 | wc -c` prints 8192 on Bun 1.3.14 and 16384 on Bun 1.4.2, while redirecting to a file gives the full 87 KB. Agents and scripts that pipe JSON into `jq` or read it through a subprocess pipe receive invalid, truncated JSON. The CLI entry point calls `process.exit()` right after the command finishes, before asynchronous pipe writes drain.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** [inferred] Every CLI command's complete stdout and stderr reach a pipe consumer before the process exits, for outputs well above the pipe buffer (at least 1 MB), on Linux, macOS and Windows. Errors: a closed pipe (consumer exits early, EPIPE) still exits promptly with the command's exit code and no hang.
- **R2:** [inferred] A regression test runs a real CLI subprocess whose output exceeds 1 MB through a pipe and asserts byte-exact length and valid JSON, plus an early-closing consumer that must not hang; exit codes are preserved.

## Boundaries
<!-- scope: business -->

- [inferred] No change to command output formats; exit-time cleanup of native models keeps working.
