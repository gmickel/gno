---
satisfies: [R3, R4, R6]
---
# fn-94-retrieval-proven-setup-and-connector.2 Add read-only connector verification adapters

## Description
Deliver add read-only connector verification adapters as one implementation-sized increment.

**Size:** M
**Files:** `src/core/connector-verifier.ts`, `src/core/activation-probe.ts`, `src/core/activation-verifier.ts`, `src/store/types.ts`, `src/store/activation-receipts.ts`, `spec/output-schemas/activation-verification.schema.json`, `src/serve/connectors.ts`, `src/cli/commands/mcp/status.ts`, `test/core/connector-verifier.test.ts`, `test/serve/connectors.test.ts`, `test/cli/mcp.test.ts`, `test/spec/schemas/activation-verification.test.ts`

### Approach
- Extend the shipped `ActivationVerificationReceipt@1.0` stage/code schema; do not create a parallel connector result. Preserve the fn-94.1 invariant that `ready` means index + lexical proof only. Persist target-specific copies through the existing `(collection, connector_target)` receipt key and `connectorTarget` evidence field.
- Refactor the fn-94.1 probe selection into a shared internal, ephemeral probe plan used by both local BM25 and connector verification. The raw term may cross the local ephemeral verifier boundary (including stdio to the verified child) and appear in isolated corpus test input, but must never enter receipts, logs, errors, serialized snapshots, or public results; reuse the existing corpus-keyed digest and exact expected URI/source identity.
- For MCP targets, read the installed `serverEntry` from `checkMcpTargetStatus`, accept only known local GNO command shapes, and reject arbitrary commands or network bootstrap forms (`bunx`, `bun x`, `npx`) without spawning. Use the official MCP SDK `StdioClientTransport` with a bounded timeout/teardown; require `tools/list`, `gno_status`, then a collection-scoped `gno_search` whose results contain an expected URI. Discard snippets/content immediately.
- Treat skill installation truthfully: file presence proves installation only. Until a target client exposes a safe read-only runtime hook, return `skipped` with `target_runtime_unverifiable`; never claim the target consumed the skill and never shell out to an agent client to simulate that proof.
- Derive a connector receipt fingerprint from the fn-94.1 lexical fingerprint plus a connector-verifier implementation ID and a digest of normalized target kind/id/scope, resolved config-path identity, and accepted local command/args. Use a non-path-leaking target key such as `<kind>:<target>:<scope>:<config-path-digest>` so project/user configs cannot collide. A config, command, scope, path, or verifier change must invalidate prior connector success.
- Add stable connector codes for not configured, unsupported/unsafe config, start failure, timeout, missing tools, status failure, search failure, and result mismatch. Store only the code in the strict receipt; provide one bounded deterministic code + target → remediation mapper for CLI/REST/Web consumers. Never persist arbitrary process errors. Configuration and trust/auth prompts remain untouched.

### Shipped fn-94.1 contract to reuse
- `verifyLexicalActivation(store, collection, options)` and the internal tokenizer-aware probe helpers in `src/core/activation-verifier.ts` / `src/core/activation-probe.ts`.
- `ActivationVerificationReceipt`, `ActivationStageReceipt`, `ActivationVerificationCode`, and `StorePort.getActivationReceipt/upsertActivationReceipt` in `src/store/types.ts`.
- SQLite migration 012 stores one bounded receipt per `(collection, connector_target)`; no new receipt table or migration is expected.
- The base fingerprint already covers schema version, FTS tokenizer/state, and sorted active URI/source/mirror hashes. Connector rows extend it with hashed target/config identity and must not weaken stale-row eviction or the strict readiness/evidence invariant.
- R3 execution support means a local MCP target whose installed config passes the safe command policy, or a future skill client exposing a safe read-only runtime hook. A skill file without that hook is not execution-capable and satisfies R4 through a truthful skipped result, never a fabricated R3 pass.

### Investigation targets
**Required** (read before coding):
- `src/serve/connectors.ts:135-260`
- `src/cli/commands/mcp/status.ts`
- `src/cli/commands/mcp/config.ts`
- `src/mcp/server.ts:84-160`
- `src/core/activation-verifier.ts`
- `src/store/activation-receipts.ts`
- `spec/output-schemas/activation-verification.schema.json`

**Optional** (reference as needed):
- `test/serve/connectors.test.ts`

## Acceptance
- [ ] Supported local MCP fixtures execute `tools/list`, `gno_status`, and a real collection-scoped `gno_search` through the installed command path; the expected URI is observed and no returned content is persisted.
- [ ] Skill targets without a verifiable runtime hook explicitly return `skipped/target_runtime_unverifiable`; installation presence is never reported as execution proof.
- [ ] Unavailable, timeout, malformed, auth/trust-blocked, arbitrary-command, network-bootstrap, missing-tool, and mismatched-result targets remain truthful pending/failed/skipped states with stable codes.
- [ ] Verification never changes connector configuration or bypasses a user trust boundary.
- [ ] Target-specific receipts reuse the fn-94.1 fingerprint/store contract, remain under 16 KiB, and contain no raw probe term, query, snippet, passage, command output, or unrestricted error text.
- [ ] Changing target kind/id/scope, config path, accepted command/args, or connector-verifier version invalidates cached connector success; project and user targets cannot collide.
- [ ] Every non-pass code maps to deterministic bounded remediation without adding arbitrary text to the persisted receipt.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
