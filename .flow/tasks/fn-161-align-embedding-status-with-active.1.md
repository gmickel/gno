# fn-161-align-embedding-status-with-active.1 Fix authoritative embedding status and regression coverage

## Description
Implement R1-R3 of the parent spec; host owns R4 release and downstream documentation reconciliation. Inspect variant identity/activation contracts before choosing the shared read-only status implementation.

Touches: src/store/sqlite/adapter.ts, src/store/vector/**, src/cli/commands/status.ts, src/serve/status.ts only if required, test/store/**, test/cli/status*, test/serve/status*, and new narrowly scoped status regression fixtures. Avoid unrelated files.

Quick: focused status/vector regression suites, bun run lint:check. Use Bun 1.4.2 from node_modules/.bin/bun, not the host default 1.3.14.

## Acceptance
- [ ] Complete verified variants with missing legacy vectors report zero backlog and correct collection counts.
- [ ] Missing/changed owners, stale partition identity, shared content and inactive documents behave correctly; legacy path remains covered.
- [ ] Status performs no model load, vector mutation or forced regeneration.
- [ ] Focused tests and lint pass. Host validates read-only live status and release gates.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
