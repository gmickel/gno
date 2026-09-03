---
satisfies: [R2, R6]
---
# fn-132-wired-loop-capture-parity-changes.3 gno changes --follow --jsonl

## Description
gno changes --follow --jsonl. **Size:** M. **Files/Touches:** src/cli/commands/changes*, journal read path, NEW spec/output-schemas/changes-follow-event.schema.json, docs/CLI.md + spec/cli.md, tests.
Wire contract (binding): one JSON object per line = {event, postCursor} where postCursor is the cursor AFTER applying that event (checkpoint rule: consumer persists postCursor, resume with --cursor replays nothing before it); default start = current latestCursor (tail semantics) unless --cursor given; quiet periods emit nothing (no keepalive in v1; document); cursor-expiry → one terminal error record {error:"cursor_expired", earliestCursor} (the journal's documented resume floor — resuming from latestCursor would skip every retained event; consumer decides whether to backfill from earliestCursor or tail) then non-zero exit; SIGINT → clean exit. At-least-once with idempotent postCursor checkpointing documented as the delivery contract. Scripted-edit-sequence test: restart mid-stream, prove no gap/duplicate by event ids.

**Touches:** src/cli/commands/changes*, journal read path, spec/output-schemas/changes-follow-event.schema.json (new), docs/CLI.md, spec/cli.md, tests

## Acceptance
- [ ] Schema committed; per-line shape validated in tests
- [ ] Restart-resume test proves no gap/no duplicate against a scripted edit sequence
- [ ] Cursor-expiry and SIGINT behaviors verified
- [ ] docs/CLI.md + spec/cli.md in the same change

## Done summary
Added `gno changes --follow --jsonl [--cursor <c>] [--collection <n>]`: a cursor-polling stream over the change journal that emits one `{event, postCursor}` line per event (postCursor == event.id == the journal cursor after the event), starts at latestCursor unless `--cursor`, emits nothing in quiet periods, writes one terminal `{error:"cursor_expired", earliestCursor, latestCursor}` line then exits 2 (silent stderr) when the cursor falls below the retention floor, and exits 0 on SIGINT/SIGTERM. Delivery is at-least-once with idempotent postCursor checkpointing; documented in spec/cli.md, docs/CLI.md, CHANGELOG.

Files: src/cli/commands/changes-follow.ts (new loop), src/cli/commands/changes.ts (changesFollow adapter + signal wiring), src/cli/program.ts (flag registration inside the existing `changes` command only; `--limit` lost its commander default so follow can reject it, the one-shot path applies "100" itself), spec/output-schemas/changes-follow-event.schema.json (new; event branch $refs gno://schemas/changes@1.0#/definitions/change), test/spec/schemas/validator.ts (exactly one entry added: "changes-follow-event"), test/spec/schemas/changes-follow-event.test.ts, test/cli/changes-follow.test.ts (spawns the CLI against a real temp index: restart-resume by event id with the third delivered-but-unchecked line redelivered, tail start + quiet window, purge-driven cursor expiry, 7 flag-validation cases; stream tests skip on win32 because SIGINT is a hard kill there).

Acceptance: schema committed and per-line shape validated; restart-resume test proves seen ids == journal ids since start, no duplicate, order preserved; cursor-expiry and SIGINT verified against the spawned process; docs in the same commit.

baseline: none (spec lists no Quick commands; `bun run lint:check` and focused `bun test test/changes test/spec/schemas/knowledge-delta.test.ts` were green pre-edit)
gate classify: FULL (spec/cli.md unmatched) -> full gates run
verify: `bun test` suite_rc=0 (4652 pass, 2 skip, 0 fail, 543 files, 184.7s); `bun run lint:check` rc=0 (1 pre-existing oxlint warning in test/cli/query-text.test.ts, not mine); receipt .flow/tmp/green-receipts/3bafa8e7-unittest.json

Integration notes for the conductor: CHANGELOG.md [Unreleased]/Added gained one bullet (siblings will likely add adjacent bullets - trivial merge). program.ts edit is confined to `wireKnowledgeDeltaCommands` plus a new `runChangesFollow` helper directly above it. Follow-ups not built (outside Touches): assets/skill/cli-reference.md and its mirrors do not yet mention --follow (skill autoresearch eval per CLAUDE.md); ~/work/gno.sh website CLI reference; MCP subscription mapping is explicitly out of scope.

stage: impl-review - skipped(policy: parallel-wave - conductor owns the review after integration)

stage: impl-review - skipped(policy: review backend none)
stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 3bafa8e7bb4e7b84bfe30f5e2f03abad1da08d91
- Tests: bun test test/cli/changes-follow.test.ts, bun test test/spec/schemas/changes-follow-event.test.ts, bun test, bun run lint:check
- PRs: