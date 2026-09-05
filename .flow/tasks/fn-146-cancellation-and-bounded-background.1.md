---
satisfies: [R1, R4, R6]
---
# fn-146-cancellation-and-bounded-background.1 Define abort deadlines and native settlement contracts

## Description
Define abort deadlines and native settlement contracts. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/llm/types.ts, src/llm/native-worker/protocol.ts (from fn-144), test/llm/inference-cancellation-contract.test.ts (new), docs/SDK.md, docs/CONFIGURATION.md
**Touches:** [src/llm/types.ts, src/llm/native-worker/protocol.ts, test/llm/inference-cancellation-contract.test.ts, docs/SDK.md, docs/CONFIGURATION.md]

### Approach

- Add optional abort/deadline carriage without breaking existing port callers; distinguish caller cancellation, timeout and native failure using existing error vocabulary.
- Define configured inferenceTimeout from native execution start; caller deadline also covers queue/load. Native generation receives evaluation signal; embedding/ranking have creation signals only, so retain ownership while evaluation settles.
- Reuse5s drain plus5s abort settlement for resident shutdown, followed by at most1s owned-child forced-exit wait. These are operational shutdown bounds, not a universal query SLA.

### Investigation targets

**Required:**
- `src/llm/types.ts:50`
- `src/pipeline/expansion.ts:477`
- `src/config/types.ts:430`
- `src/serve/resident-runtime.ts:579`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/llm/inference-cancellation-contract.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Contract tests cover queued/native-active/response-pending phases and one settlement.
- [ ] No accepted timeout setting remains ignored; invalid configured values fail existing configuration validation.
- [ ] Document execution versus end-to-end deadline and unsupported mid-inference cancellation honestly.

## Done summary
# fn-146-cancellation-and-bounded-background.1

Implemented optional InferenceOptions carriage, internal one-delivery/native-ownership settlement contract, cancellation/execution-start IPC schemas, timer-range configuration validation, and honest staged SDK/configuration documentation. Existing inference inputs, GenParams, precision, ranking, model identity and dependencies are unchanged.

Status: implemented and accepted by host in50707752; runtime integration follows in task2. Worker made no Git or Flow mutations. Additional ownership granted for src/config/types.ts; runtime-config.ts was inspected but not changed.

stage: impl-review - skipped(config: user explicitly disabled formal reviews)

Baseline: host reported full gate green (5,150 tests) before dispatch. Task's new Quick-command test file did not exist pre-edit; first invocation after creation passed. No native/GPU/SSH probes performed. No relevant workspace-memory entry used.

Validation: 74 tests, zero failures, 325 assertions across inference-cancellation-contract, native-worker-protocol and config/project-profile. Owned-file type-aware lint and formatting pass; repository typecheck passes. Logs: notes/fn146.1-tests.log, notes/fn146.1-lint.log, notes/fn146.1-typecheck.log.

### Contract for task 2

- InferenceOptions carries signal and absolute epoch-ms deadlineAt. Optional argument position: init first; embed/embedBatch second; generate third after unchanged GenParams; rerank third. Do not place cancellation controls in GenParams or alter paired-fixture inference/model inputs to mask differences.
- InferenceSettlement<T>.completion delivers exactly once. startNative() marks native-active before loading; startExecution() starts the monotonic execution timeout after loading; nativeSettled(result) acknowledges actual native settlement or confirmed child exit; publish() validates the remaining caller deadline and delivers the response. Native-active cancellation delivers an error but ownsNative remains true until nativeSettled. Response-pending keeps caller cancellation/deadline live. Cancellation control/acknowledgement alone never proves native settlement.
- signal propagates a DOMException to backend creation/evaluation. Result errors use llmError's normalized plain {name,message} cause: INFERENCE_FAILED + AbortError for caller cancellation; TIMEOUT + TimeoutError for expiry. isInferenceCancellation is a structural predicate. wireError retention is regression-tested. Native failures preserve their original error and no cancellation reason from the caller is copied into diagnostics.
- NativeCancellationSchema carries version/generation/requestId/cancel ('abort'|'timeout') on the separate control lane; NativeExecutionStartedSchema carries matching identity and executionStarted:true. Native requests have optional deadlineAt. Control messages must be generation/request validated by their owning client/child integration; schema validation alone does not establish ownership. These schemas do not yet change runtime routing.
- Wire controls cannot settle NativeRequestLedger entries or free capacity. Start-execution receipt is not a success response. Child abort is cooperative for generation evaluation, but embedding/ranking may only abort creation; retain ownership for noncooperative evaluation.
- ModelConfigSchema now rejects zero, negative, fractional, nonfinite and overflowing loadTimeout/inferenceTimeout values (valid integer range 1..2147483647). No documented zero-disable semantics existed. Runtime bootstrap currently has weaker positive-number validation; align it when wiring the child. Do not sum large valid timers into an overflowing setTimeout.
- Critical negative: native completion after elapsed execution deadline must fail even if the JS timeout callback has not run. The helper checks monotonic elapsed time at nativeSettled.

### Remaining integration (not claimed complete here)

Task 2 must wire options through transports/pipeline/client/native implementations and replace the current dispatch watchdog (loadTimeout + inferenceTimeout). Task 4 must carry a shared 5s drain + 5s abort-settlement + at-most-1s forced-child-exit wait through shutdown. Current SDK/configuration text explicitly marks these pending rather than advertising unenforced controls; reconcile that text once integration is proven. Hosted-site reconciliation and live API/MCP/shutdown QA remain host-owned.

Focused negative coverage maps R1 to abort before admission, native-active ownership, response-pending suppression, one settlement, native failure preservation and delayed callbacks; R6 to invalid configuration/deadlines and honest documented controls. R4's shutdown budget is documented as a contract only; finite shutdown execution belongs to task 4.
## Evidence
- Commits: 50707752eae034b61dac4d94b845605dff7e3a71
- Tests: baseline: host reported full gate green (5150 tests); new task test path first run after creation, bun test test/llm/inference-cancellation-contract.test.ts test/llm/native-worker-protocol.test.ts test/config/project-profile.test.ts — 74 pass, 0 fail, 325 assertions, bunx oxlint --type-aware --type-check src/llm/types.ts src/llm/inference-cancellation.ts src/llm/native-worker/protocol.ts src/config/types.ts test/llm/inference-cancellation-contract.test.ts — pass, bunx oxfmt --check src/llm/types.ts src/llm/inference-cancellation.ts src/llm/native-worker/protocol.ts src/config/types.ts test/llm/inference-cancellation-contract.test.ts docs/SDK.md docs/CONFIGURATION.md — pass, bun run typecheck — pass
- PRs: