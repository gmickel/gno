---
satisfies: [R1, R6]
---
# fn-132-wired-loop-capture-parity-changes.2 Capture parity: MCP/REST capture syncs before success

## Description
Capture parity: MCP/REST capture success = retrievable. **Size:** M. **Files/Touches:** src/mcp/tools/capture.ts, src/serve/capture-service.ts + routes (REST currently returns 202 before sync; MCP returns tool-success containing sync.status:"failed"), src/core/capture.ts sync helper, tests.
Success semantics (binding): capture succeeds ONLY when write + lexical sync complete under the lease; sync failure → tool error / non-2xx (no success-with-failed-sync); lease-busy behaves per the v1.38 contention contract; open_existing on an unindexed file syncs it before success. REST becomes synchronous for this path (or gains an explicit completed-state polling contract — pick one, document; default synchronous). Receipt splits write/sync; embed state stays separate per task 1's contract. Live one-turn capture→search-hit verification incl. a concurrent writer.

**Touches:** src/mcp/tools/capture.ts, src/serve/capture-service.ts, src/serve/routes capture path, src/core/capture.ts, spec/mcp.md capture section, docs/API.md, tests

## Acceptance
- [ ] MCP capture with failing sync returns an MCP error, not success (test); REST returns success only after retrievability
- [ ] Live one-turn loop: gno_capture → immediate gno_search hit, with a concurrent CLI writer running (lease serialisation observed)
- [ ] open_existing unindexed file case covered
- [ ] spec/mcp.md + API docs updated to the new semantics

## Done summary
MCP `gno_capture` and REST `POST /api/capture` now complete the write and its lexical sync under the shared write lease (`.mcp-write.lock`, 120s wait per the v1.38 contention contract) before returning, so a captured note is an immediate search hit in the same agent turn. The shared helper lives in `src/core/capture.ts` (`syncCapturedFile` / `ensureCapturedFileIndexed`, `CaptureSyncError` carrying the write half of the receipt); a written file whose sync fails is `CAPTURE_SYNC_FAILED` (MCP tool error / HTTP 500 with `details.absPath|relPath|uri|contentHash`), a busy lease is `LOCKED` (MCP error / HTTP 409, nothing written), and `open_existing` on an unindexed disk file syncs it before success. REST answers 201 on create and 200 on `opened_existing` (was 202 + sync job); `executeResidentCapturePlan` gained an explicit `mode: "await-sync" | "job"` and the browser-clip route (`clipper-capture.ts`, outside Touches) stays on the default `job` mode with its documented 202 contract. Embed state stays separate (`embed.status: not_requested`, task .1's `index_stage_state` untouched). Docs: spec/mcp.md gno_capture notes + error codes, docs/API.md capture section + error table, docs/MCP.md, one CHANGELOG bullet appended under the fn-132 entries.

Tests: `test/capture/rest-sync.test.ts` (201 + FTS hit, open_existing unindexed -> 200 completed, sync failure -> 500 CAPTURE_SYNC_FAILED with the write receipt and the file still on disk, lease busy -> 409 LOCKED with nothing written, clipper job mode keeps 202 pending); `test/mcp/tools/capture.test.ts` (sync failure -> isError with `error: CAPTURE_SYNC_FAILED`, open_existing unindexed synced + searchable); parity and lifecycle tests updated to the new status/receipt.

Live (AC2): `live-loop.ts` against an isolated home (1500 notes): CLI writer `gno index --no-embed` held the lease (holder sidecar pid 4105266, command "gno index"); `gno_capture` called 401ms in waited 3426ms and completed at +3826ms, 14ms before the writer's +3840ms exit, with `sync.status: "completed"`; `gno_search` for the unique token hit `captures/live-<token>.md` immediately.

baseline: green via handoff (full bun test 4700 pass at d5e4898f, fn-132.4); lint:check rc=0 pre-edit
gates: bun run lint:check rc=0; bun test rc=0 (4706 pass, 2 skip, 0 fail, 187s); green receipt written for unittest (9cf9ec2a-unittest)

Follow-ups (not built): browser-clip route (`/api/capture/clip`) still returns 202 + sync job - moving it to await-sync needs the extension client's status validation (202 = created) changed in the clipper repo; SDK `client.capture()` and CLI `gno capture` still return `sync.status: "failed"` / `"skipped"` receipts instead of throwing (outside Touches; core helper is ready for them).

stage: impl-review - skipped(policy: parallel-wave - conductor owns review after integration; REVIEW_MODE=none)

stage: impl-review - skipped(policy: review backend none)
stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 9cf9ec2a51d3d70144526a904c158e8270597a1b
- Tests: bun test (4706 pass, 2 skip, 0 fail, 187s; green receipt 9cf9ec2a-unittest), bun run lint:check, bun test test/capture test/mcp/tools/capture.test.ts test/serve/api-docs-lifecycle.test.ts test/clipper/routes.test.ts test/clipper/recovery.test.ts, live: live-loop.ts (MCP stdio client, isolated GNO_CONFIG_DIR/DATA_DIR/CACHE_DIR home, 1500-note collection) - gno_capture waited 3426ms behind a concurrent CLI writer 'gno index --no-embed' (lease holder sidecar pid 4105266), completed 14ms before the writer exited with sync.status completed, and the immediate gno_search hit the captured note
- PRs: