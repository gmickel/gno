---
satisfies: [R2, R4, R6]
---
# fn-144-native-recovery-and-idle-inference.1 Define native worker protocol and ownership failures

## Description
Define native worker protocol and ownership failures. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/llm/native-worker/protocol.ts (new), src/llm/native-worker/errors.ts (new), test/llm/native-worker-protocol.test.ts (new)
**Touches:** [src/llm/native-worker/protocol.ts, src/llm/native-worker/errors.ts, test/llm/native-worker-protocol.test.ts]

### Approach

- Define a closed versioned protocol with request and worker-generation IDs, approved local model descriptors, embedding/reranking/generation operations, capability/dimension metadata and one settlement per request.
- Keep protocol output separate from diagnostics. Start with64 queued logical operations, 8MiB transport frames and64MiB logical operation ceiling; split embedding batches preserving order and reject irreducible oversized requests using existing structured errors. Test multibyte boundaries.
- Use the same protocol for resident and command-lifetime CLI children. Do not expose DB handles, network credentials, downloads or caller authorization to the child. Parent owns policy/model selection; child may only load approved native model paths.

### Investigation targets

**Required:**
- `src/llm/errors.ts:12`
- `src/llm/types.ts:84`
- `src/cli/detach.ts:575`
- `test/mcp/context-lifecycle.test.ts:56`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/llm/native-worker-protocol.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Closed schema rejects unknown version/op/generation, malformed results, over-budget payload and duplicate completion.
- [ ] Protocol preserves full vectors, scores, structured generation schema and errors; no native discovery runs in parent.
- [ ] Record queue/frame limits as internal operational bounds with explicit overload behavior, not retrieval truncation.

## Done summary
# fn-144.1 handover

Implemented the internal version-1 native worker contract in `src/llm/native-worker/protocol.ts`, stable ownership errors in `src/llm/native-worker/errors.ts`, and focused tests in `test/llm/native-worker-protocol.test.ts`. No native imports, discovery, fixture changes, Flow mutations, Git mutations, or native workloads.

Baseline: none (task Quick command targets the new test deliverable). Pre-edit HEAD: `9285e523e207e465c22d434d52df73880fe95c49`. Shared checkout; other agents' changes excluded from ownership.

Verification: `bun test ./test/llm/native-worker-protocol.test.ts`: 6 pass, 0 fail, 69 assertions. Targeted `bunx oxlint --type-aware --type-check` and `bunx oxfmt --check` over the three owned files pass. Log: `/home/gordon/.cache/agent-tmp/gno-fn144-protocol/test.log`. No native QA verdict; physical acceptance remains with later tasks and host.

Contract and runtime integration:

- `parseNativeRequest` validates closed operation envelopes against generation and approved model IDs/types. Approved descriptors contain only ID, URI, absolute local path, model type. Parent owns canonical path selection and policy; child must recheck actual file identity before loading (protocol string validation is not filesystem approval).
- `init` returns `{dimensions?, structuredOutput}`; embedding init must report dimensions. `dispose` succeeds with wire `null` (map to port `void`). Other operations preserve actual port input/output values, including generation JSON Schema and structured errors. GenerationPort currently returns complete strings; no streaming public port is invented.
- `frameNativeMessage` / `NativeFrameDecoder`: binary Uint8Array frames for dedicated Bun IPC, preserving message boundaries. Do not feed arbitrary partial/coalesced stdout reads into this decoder. stdout/stderr remain diagnostics. Each frame includes version/generation/request ID/total byte length/offset and is at most 8 MiB. Logical UTF-8 JSON is at most 64 MiB. A decoder assembles one ordered logical message per direction. Reset/discard partial assembly on transport termination.
- `splitEmbeddingRequest`: exact ordered text groups; individual large texts remain intact and use multiple transport frames. Count the original operation once in the admission ledger and combine all group results in original order before settling; do not reuse the logical request ID as multiple ledger admissions. Never truncate or partially return a batch.
- `NativeRequestLedger`: monotonic positive safe-integer request IDs, one active plus 64 waiting logical operations; runtime serializes execution. `settle` validates identity/result before deleting a pending entry. Runtime must treat malformed responses as worker failures and use `failAll` to settle/release callers. `failAll` provides structured failure responses once and clears retained input snapshots. No automatic retries. New worker/model configuration requires a new generation/ledger; runtime must not admit after retirement.
- `NativeWorkerError.detail` maps timeout to existing TIMEOUT and other ownership failures to INFERENCE_FAILED, with stable sanitized messages and retryability. Never append raw child diagnostics or payloads.
- Spawn with Bun IPC `serialization: "advanced"` to preserve Uint8Array frames. Runtime activity accounting must distinguish actual model initialization/native work from an `init` returning cached metadata; metadata-only traffic must not renew unrelated model residency or blindly extend TTL.

R2 coverage: generation identity, one settlement, immutable admitted input snapshot, late response rejection and draining. R4 coverage: full port round trips, strict malformed result checks, queue overload, multibyte framing/splitting, 64 MiB rejection. R6 contract coverage: exit/timeout stable errors and late completion rejection. Actual native lifecycle/abnormal exit and recovery require tasks 2 onward.

stage: impl-review - skipped(policy: user disabled formal reviews; host owns acceptance)

Status remains in_progress for host validation/commit/Flow completion.
## Evidence
- Commits: 9ee4f238aecb2e13fa53c3ce33f75eeca973deb5
- Tests: baseline: none (new test deliverable), bun test ./test/llm/native-worker-protocol.test.ts — 6 pass, 0 fail, 69 assertions, bunx oxlint --type-aware --type-check src/llm/native-worker/protocol.ts src/llm/native-worker/errors.ts test/llm/native-worker-protocol.test.ts, bunx oxfmt --check src/llm/native-worker/protocol.ts src/llm/native-worker/errors.ts test/llm/native-worker-protocol.test.ts
- PRs: