---
satisfies: [R1, R2]
---
# fn-188-remote-status-and-collection-responses.1 Implement Remote status and collection responses expose owner config paths

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Remote REST callers (the fn-181 localClient rule) and every HTTP MCP caller no longer receive owner configuration paths: /api/status, /api/collections(/:name), /api/connectors(/install) drop configPath, dbPath and path fields through the existing redaction wrapper, and MCP gno_status omits configPath, dbPath and collection roots (its text summary drops the Config/Database lines). Local owners, stdio MCP, CLI and SDK are unchanged. The Web UI tolerates the omitted fields, the production SPA snapshot was rebuilt (the stale snapshot crashed the remote Collections page), and the disk health text no longer names the model cache folder for any caller. Schemas (status, collection-list), docs/API.md, docs/MCP.md, CHANGELOG [Unreleased] and gno.sh (branch fn-188-remote-config-paths, not pushed) are updated.

R-ID tests: test/spec/schemas/host-paths.test.ts ("REST owner config paths" and "MCP gno_status owner config paths": one local and one remote caller each, schema-validated).

Live QA evidence: .flow/tmp/qa-fn-188-remote-status-and-collection-responses/ (temp root /tmp/gno-qa188 on port 3871: remote REST and HTTP MCP responses contain 0 temp-root hits and 0 path keys; local and stdio keep them; Collections page renders locally with paths and remotely without, no page errors).

Follow-up (not built): document mutation routes still return a host `path` field to remote callers (create doc, rename, move, create folder, editable-copy file:// uri in src/serve/routes/api.ts); fn-181 only stripped `absPath`. Worth a separate spec.

Tier: session (actual_model: claude-opus-5-5)

stage: impl-review - ran (codex gpt-6-astra medium, 3-draw fan-out, SHIP first round)
## Evidence
- Commits: 29f1b79df173425aaaaf6b4e75825bb233b62ce4, 57606c014033af141ff401050b521b114c289d81
- Tests: baseline: green (focused: bun test test/spec/schemas/host-paths.test.ts test/spec/schemas/status.test.ts test/serve/api-status.test.ts test/mcp/tools/status.test.ts; spec defines no Quick commands), bun test test/spec/schemas/host-paths.test.ts (new REST /api/status + /api/collections and MCP gno_status local/remote tests; confirmed red on base code), bun test (full: 5794 pass, 2 skip, 0 fail), bun run lint:check, bun run docs:verify, live QA: .flow/tmp/qa-fn-188-remote-status-and-collection-responses/, gno.sh: bun run check, bun run typecheck, vitest src/lib, bun run build (branch fn-188-remote-config-paths @ abff779)
- PRs: