---
satisfies: [R1, R2, R3, R4, R5, R6, R7]
---
# fn-170-durable-receipts-for-safe-mutation.1 Implement Durable receipts for safe mutation retries

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Callers can now send an opt-in `requestId` with capture, remember add/supersede and REST document update. The ID is recorded in a private per-index SQLite ledger (`<dataDir>/write-receipts/`, kept by `gno reset`), so a retry after a lost response replays the retained outcome, finishes an interrupted write, or refuses a changed intent or changed target. Admission and recovery reuse the existing write lease, content dedup, predecessor hashes and revision guards; there is no second lock and no general job framework.

### R1 evidence: legacy retry behaviour (fault-injection probe, before the change)

| Mutation | Retry after lost response | Retry after crash between file publication and lexical sync |
| --- | --- | --- |
| remember add | returns `existing` (outcome not stable); after a supersede in between, re-adds the old fact | writes a second record (duplicate fact) |
| remember supersede | `MEMORY_SUPERSEDE_CONFLICT` (caller cannot tell it was their own success) | writes a second successor (double supersede) |
| capture, titled, `error` policy | 409 "already exists" (ambiguous) | 409, and the note is left unindexed |
| capture, `create_with_suffix` | duplicate file | - |
| capture, untitled | `opened_existing` (safe on the same day) | - |
| MCP capture with `overwrite` | overwrites a newer foreign edit | - |
| doc update with expectedSourceHash | 409 CONFLICT (ambiguous) | - |
| doc update without a hash | overwrites a newer foreign edit | - |
| two concurrent doc updates from one base | both 200: lost update (the revision check ran outside the lease) | - |

The smallest missing guarantee: a durable per-request record of the admitted plan (destination plus expected pre/post hashes), written under the existing lease. That lets a retry replay, finish or refuse instead of re-planning. Document saves also needed their revision check and write inside the lease.

### Shipped
- **Core.** `src/core/request-receipts.ts` holds the ledger at `<dataDir>/write-receipts/<index db>`: mode 0600, 30-day full receipts, then permanent tombstones, one 100,000-row cap, no config. `src/core/capture-publish.ts` is the shared leased capture used by CLI, MCP, SDK and REST; the SDK capture now takes the lease. The remember refactor is in `src/core/memory-remember.ts`, and the REST document save now runs under the lease.
- **Surfaces.**
  - `--request-id` on CLI capture and remember, plus `gno request-status`.
  - MCP: `requestId` on capture and remember, plus a read-only `gno_request_status` on the full profile with `--enable-write`. HTTP MCP namespaces follow the authorized identity (loopback or bearer digest), so they survive restarts and are isolated per identity.
  - REST: `requestId` on capture, remember and doc update, plus `GET /api/requests/:id`.
  - SDK: `requestId` and `requestStatus()`.
  - Web UI: the capture dialog, editor save and tag save keep one ID per retried intent.
- **Tests.**
  - Fault matrix: 4 ops x 5 crash stages, retried from a new session. Durable files are counted, and a published document update is never rewritten.
  - Recovery conflicts per op. Ledger contract: validation, conflict, namespace isolation, pending, expiry tombstones, capacity, unavailable ledger, and rejected or unpublished retries leaving no receipt.
  - Separate-process SIGKILL at publication and 4-process concurrent callers per op.
  - Surface tests: CLI, REST (leased saves: one of two concurrent saves wins; LOCKED when busy), SDK, HTTP MCP namespaces across a restart, clipper refusing `requestId`, and a CaptureModal DOM test.
  - Mutation checks confirmed that recovery and the lease are load-bearing.
- **Docs.**
  - Repo: guide `docs/guides/retries-and-request-ids.md`, API/CLI/MCP/SDK/MEMORY/WEB-UI/CONFIGURATION/TROUBLESHOOTING/ARCHITECTURE, README, CHANGELOG.
  - Specs and schemas: spec/cli.md, spec/mcp.md, new request-status schema, optional `request` on the capture and remember schemas.
  - Skill: `assets/skill` and the project copies.
  - Site: gno.sh worktree `/home/gordon/work/gno-sh-fn170`, branch `fn-170-durable-receipts`, commits 1091c88, d263481 and ca17624. Not pushed or deployed.

### Audit and review fixes
- No-ID CLI/SDK capture again reports a lexical sync failure as a receipt (`sync.status: "failed"`, exit 0), and `open_existing` on an unindexed file still returns `skipped`. The sanctioned change remains: capture and document saves run under the lease (typed busy / `409 LOCKED`; one of two concurrent same-base saves wins).
- `gno reset` keeps `write-receipts/`, so a used ID still replays after a reset.
- A published target that was later deleted or reverted is a recovery conflict (published marker), never recreated.
- Supersede recovery refuses if the predecessor gained another successor.
- Tag-only recovery checks the file and tag state and resolves the document by URI, not by row ID.
- Expiry applies on lookup and replay; compaction survives a capacity rejection.
- The Web UI keeps an unconfirmed ID for the tab across a refresh.
- Refactors: the `localRequestLedger` helper, exported `isLeaseBusy`, shared request formatting, the document-update outcome split into body and target, the schema `request` via `$ref`, and docs single-sourced in `docs/guides/retries-and-request-ids.md`.
- Tests: HTTP MCP bearer/loopback identities and token rotation at the transport level.
- The SDK keeps REQUEST_PENDING as RUNTIME with `details.code`, the same way it maps lease contention (the SDK has no BUSY code). The CLI uses BUSY (exit 4), matching its own lease mapping. No new SDK error code was added.

### Follow-ups (not built)
- `error.schema.json` lacks the pre-existing CLI `BUSY` code.
- The gno.sh skills page could mention the new skill guidance.

stage: impl-review - ran [codex:gpt-6-astra:medium round 1 NEEDS_WORK (4 findings fixed) .. round 2 SHIP]

Tier: session (jev intelligent 0.72)
## Evidence
- Commits: 06b163cc6a9efe45a0e4d246ffcf8b76a8c8a445, 9e1674e6d6b81d4d2eff04717fd3de9ed820ba29, f8c78af0ff50c3feb3e252797c71420dcdc3dd4a, 376b709dfb0a6723da080d118f7d2ad4d3c95667, 9bba1895ba8cad226a523167ec7fa95722a26d0f, 2623571384b572f20ecdefaa8f6828a9a342a9bf
- Tests: baseline: green (bun test 5402 pass / 2 skip / 0 fail, pre-edit), bun test (5479 pass / 2 skip / 0 fail at 9bba1895), GATE_SKIPPED:unittest:green-receipt 9bba1895 - baseline reused from prior post-gate pass, bun run lint:check (0 errors, 34 pre-existing warnings), bun run docs:verify (15 passed, 2 skipped), bun run eval:memory (100%, threshold 100%), bun test test/core/request-receipts*.test.ts test/serve/api-request-ids.test.ts (fault matrix 4 ops x 5 stages; edited/deleted/reverted recovery conflicts; competing supersede; tag-only recovery; expiry/capacity; SIGKILL + 4-process concurrency), skill autoresearch uv run eval.py (100.0%, 47/47), gno.sh fn-170-durable-receipts @ ca17624: bun run check, typecheck, test (398 pass / 41 skip), build, impl-review codex:gpt-6-astra:medium: round 1 NEEDS_WORK (4 findings fixed), round 2 SHIP
- PRs: