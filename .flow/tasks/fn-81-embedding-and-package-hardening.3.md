---
satisfies: [R4]
---

<!-- Updated by plan-sync: fn-81-embedding-and-package-hardening.1 kept duplicate embed loops in cli/sdk helpers, not only the old top-level cursor path -->

## Description

Make transient embedding failures retry within the same command run in both the shared backlog processor and the CLI embed loop. Preserve cursor safety, avoid infinite loops, and keep final failure reporting actionable.

**Size:** M
**Files:** `src/embed/backlog.ts`, `src/embed/batch.ts`, `src/cli/commands/embed.ts`, `test/embed/backlog.test.ts`, `test/embed/batch.test.ts`, `test/cli/*embed*`

## Approach

- Reuse `embedTextsWithRecovery()` from `src/embed/batch.ts:56`; do not introduce a second embedding recovery implementation.
- Add retry state outside the forward cursor loop in `src/embed/backlog.ts:54`.
- Align the separate CLI loop in `src/cli/commands/embed.ts:166` (`processBatches`) so CLI and shared paths do not diverge.
- Audit the force-only SDK batch loop in `src/sdk/embed.ts:116`; it now duplicates batch iteration and fingerprint writes, so retry behavior there must either stay intentionally out of scope or be kept explicitly aligned.
- Retry only after later progress or final backlog drain; cap per-chunk attempts and preserve sample failure messages.
- Treat retry state as in-memory only. Interrupted runs should still resume from normal backlog state on the next invocation.

## Investigation targets

**Required**

- `src/embed/backlog.ts:54` — shared backlog processor.
- `src/embed/batch.ts:56` — batch recovery helper.
- `src/cli/commands/embed.ts:166` — CLI `processBatches()` loop.
- `src/cli/commands/embed.ts:221` — CLI batch failure/retry branch.
- `src/cli/commands/embed.ts:330` — CLI fallback/sample reporting.
- `test/embed/backlog.test.ts:215` — partial success storage coverage.
- `test/embed/batch.test.ts:86` — fallback tests.

**Optional**

- `src/serve/embed-scheduler.ts:106` — shared backlog caller.
- `src/mcp/tools/embed.ts:123` — MCP embed caller.
- `src/sdk/embed.ts:116` — SDK force-only batch loop.
- `src/sdk/embed.ts:291` — SDK shared-backlog caller.

## Key context

Do not blindly retry validation/configuration errors, missing models, or unsupported dimensions. Transient classification may start conservative; permanent failures must remain visible in final summaries.

## Acceptance

- [ ] Shared backlog retry queue retries failed chunks after later progress or final drain.
- [ ] CLI embed loop uses matching retry semantics and summary counts.
- [ ] Retry attempts are capped per chunk and cannot loop forever.
- [ ] Permanent failures include sample metadata and clear rerun/verbose guidance.
- [ ] Tests cover one transient chunk failure that succeeds on retry and one permanent failure that stays counted as an error.

## Done summary

_Not started._

## Evidence

_Not started._
