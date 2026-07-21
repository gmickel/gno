# fn-91 Bun serve shutdown crash triage

## Goal & Context

Eliminate or correctly classify the reproducible segmentation fault seen after `gno serve` receives SIGINT under Bun 1.3.6. Determine whether it remains on the current supported Bun release before changing GNO lifecycle code.

## Architecture & Data Models

Use a subprocess lifecycle harness against source and packed/global-style execution. First compare Bun 1.3.6 with the current stable Bun release. Minimize the reproduction across HTML bundling, development mode, watcher, SSE/event clients, SQLite, and model-context teardown. Apply a deterministic GNO workaround only for resources proven causal; otherwise document the runtime floor and file an upstream-quality reproduction.

## API Contracts

`gno serve` must stop on SIGINT and SIGTERM without panic output, orphan processes, or an occupied port. Exit status may be zero or the platform's expected signal status.

## Edge Cases & Constraints

- Test production and development HTML server modes separately.
- Cleanup order remains idempotent under repeated signals.
- Tests must use isolated config/data/cache directories and bounded timeouts.
- Do not pin an obsolete Bun version if the current release fixes the crash.

## Acceptance Criteria

- **R1:** A repeatable harness captures stdout, stderr, exit status, and port release for SIGINT and SIGTERM.
- **R2:** The harness compares the installed Bun 1.3.6 and current stable Bun before attributing the crash to GNO.
- **R3:** Supported execution exits without Bun panic/segfault output and without orphan processes.
- **R4:** Any GNO lifecycle change has a regression test proving the causal resource and deterministic cleanup order.
- **R5:** Runtime requirements and troubleshooting docs reflect the verified outcome.

## Boundaries

No replacement of Bun.serve, no unrelated daemon lifecycle rewrite, and no speculative resource teardown changes without reproduction evidence.

## Decision Context

The installed runtime is several releases behind current stable. Version comparison prevents maintaining an application workaround for an already-fixed runtime defect while still producing a narrow regression if GNO owns the failure.
