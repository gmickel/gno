---
satisfies: [R2, R3, R6]
---
# fn-144-native-recovery-and-idle-inference.2 Implement child ownership and safe native lifecycle

## Description
Implement child ownership and safe native lifecycle. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/llm/native-worker/client.ts (new), src/llm/native-worker/entry.ts (new), src/llm/nodeLlamaCpp/lifecycle.ts, test/llm/native-worker-lifecycle.test.ts (new), test/llm/lifecycle.test.ts
**Touches:** [src/llm/native-worker/client.ts, src/llm/native-worker/entry.ts, src/llm/nodeLlamaCpp/lifecycle.ts, test/llm/native-worker-lifecycle.test.ts, test/llm/lifecycle.test.ts]

### Approach

- Own one child generation, one in-flight startup and exactly-once late-result cleanup; prevent startup/disposal races from publishing stale ownership. Child exits on parent EOF/death and parent fails pending calls exactly once on abnormal exit.
- Implement actual-model lease/timestamp primitives here. Five-minute idle grace starts after native operation and response settlement; metadata does not refresh it. Explicitly dispose backend/model/context before normal retirement, but rely on process exit for native floor reclamation.
- Initially admit one top-level native operation at a time per child with bounded waiting; internal embedBatch retains existing batching. This is a correctness-first operational design, subject to concurrent baseline QA before default promotion; do not silently accept warm throughput regression.

### Investigation targets

**Required:**
- `src/llm/nodeLlamaCpp/lifecycle.ts:169`
- `src/llm/nodeLlamaCpp/lifecycle.ts:212`
- `src/llm/nodeLlamaCpp/lifecycle.ts:460`
- `test/llm/lifecycle.test.ts:195`
- `src/cli/detach.ts:575`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/llm/native-worker-lifecycle.test.ts test/llm/lifecycle.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Concurrent startup creates one child/backend; timeout loser and parent shutdown cannot orphan native ownership.
- [ ] Idle exit is blocked by native work and pending responses; subsequent acquisition starts a valid generation.
- [ ] Adversarial startup/exit/response schedules preserve queue capacity and one-settlement semantics; native stdout cannot corrupt host JSON.

## Done summary
# fn-144.2 handover

Implemented one persistent Bun native child with dedicated framed IPC, one active operation plus 64 waiting operations, startup deduplication, stable failure draining, retirement/reacquisition and explicit normal teardown. Native model/backend lifecycle now deduplicates backend initialization, cleans timeout losers exactly once, blocks stale publication during disposal, removes retiring models before yielding and explicitly disposes the backend.

Status: in_progress; host owns commits, Flow, full gates and physical QA. No commits, Flow mutations, worktrees, subagents or native GPU workloads were performed by this worker.

### Owned files

- `src/llm/native-worker/client.ts`
- `src/llm/native-worker/entry.ts`
- `src/llm/native-worker/dispatcher.ts`
- `src/llm/native-worker/runtime-config.ts`
- `src/llm/nodeLlamaCpp/lifecycle.ts`
- `src/llm/nodeLlamaCpp/lifecycle-options.ts`
- `test/llm/native-worker-lifecycle.test.ts`
- `test/llm/lifecycle.test.ts`

### Integration contract

- `NativeWorkerClient({models, loadTimeout, inferenceTimeout, warmModelTtl?})`; default grace 300000ms. `request({op,modelId,...})` returns the protocol result union, `dispose()` waits for exit, `processId`/`currentGeneration` expose process ownership. `entryPath` is an internal fake-child test seam, never caller configuration.
- `registerModel(ApprovedModel)` adds a parent-approved canonical local descriptor without replacing a warm child. The closed registration control only adds IDs; replacing an existing ID with a changed descriptor drains pending work and retires the generation. Parent selection/cache/policy checks MUST precede registration. Child rechecks realpath and existence before every port acquisition, including metadata calls. It performs no model discovery/download.
- Parent module graph has no native imports. Child dispatcher reuses existing embedding/generation/rerank classes, exact params/text, ordered complete batches, existing structured capability/result contracts. Wire error cause is retained only when JSON-compatible; all normal error detail fields are preserved.
- Child environment uses a native/runtime allowlist and explicitly passes `--no-env-file`; no inherited DB/auth/proxy/model-download credentials. CUDA_PATH is retained only for an existing canonical absolute directory. Bootstrap, registration and aggregate descriptor registry are explicitly bounded to 16 KiB to stay below platform argv limits; large inference operations retain the separate framed transport bounds. Native stdout is ignored so it cannot corrupt CLI JSON; stderr remains diagnostic.
- Child sends idle proposal only after native work and parent response acknowledgement. Parent accepts only when no pending or delivering call remains. Metadata/dispose traffic does not renew last-native-activity time. One persistent manager lease disables independent child model TTLs; process retirement disposes contexts/models/backend then exits to reclaim native floor. Shutdown is finite (900ms child watchdog, 1000ms parent kill fallback).
- Existing lifecycle resolver exports remain compatible via `lifecycle-options.ts`. The test os mock retains TMPDIR support. No adapter/port integration or rerank file edits.

### Verification and coverage

Baseline existing lifecycle suite: 9 pass, 0 fail. Final focused suite: 21 pass, 0 fail, 78 assertions. Typed lint: zero warnings/errors. Oxfmt check: green. Exact commands and paths in `notes/fn144.2-evidence.json`; suite log `/home/gordon/.cache/agent-tmp/gno-fn144-runtime/focused.log`.

Actual Bun subprocess tests cover shared startup, 65 admitted calls/overload, ordered batch results, diagnostic stdout isolation, abnormal exit, malformed responses, operation timeout, restart, idle reaping, shutdown during startup, startup timeout, lazy descriptor addition/replacement, production-entry response acknowledgement, metadata TTL and parent IPC disconnect. Lifecycle tests cover concurrent backend startup/shutdown, late backend timeout disposal, model removal before retirement yield, late model timeout disposal and existing lease drain/load stats behavior.

### Native QA limitations

No native binding initialization or GPU inference was executed. The production entry probe uses generation metadata against a synthetic placeholder file and verifies ownership/IPC only. This is not physical reclamation, performance, complete port equality or original Ivan crash acceptance. No parent-only capture can establish child-native execution. Child backend/model/context capture hooks and descendant resource sampling must be integrated by later QA tasks; stdout diagnostics are currently discarded and child stderr uses inherited diagnostics. Direct IPC disconnect was tested; an external hard-killed parent during blocked native execution still needs physical fault coverage. Full project gates and public behavior documentation remain host/task3+task6 integration responsibilities because runtime is not yet wired into public adapters.

stage: impl-review - skipped(policy: user disabled formal reviews; host owns acceptance)
## Evidence
- Commits: e9027dbcf451987d9d10c997cee5be82891c3378
- Tests: TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn144-runtime bun test ./test/llm/native-worker-lifecycle.test.ts ./test/llm/lifecycle.test.ts, bunx oxlint --type-aware --type-check src/llm/native-worker/client.ts src/llm/native-worker/entry.ts src/llm/native-worker/dispatcher.ts src/llm/native-worker/runtime-config.ts src/llm/nodeLlamaCpp/lifecycle.ts src/llm/nodeLlamaCpp/lifecycle-options.ts test/llm/native-worker-lifecycle.test.ts test/llm/lifecycle.test.ts, bunx oxfmt --check src/llm/native-worker/client.ts src/llm/native-worker/entry.ts src/llm/native-worker/dispatcher.ts src/llm/native-worker/runtime-config.ts src/llm/nodeLlamaCpp/lifecycle.ts src/llm/nodeLlamaCpp/lifecycle-options.ts test/llm/native-worker-lifecycle.test.ts test/llm/lifecycle.test.ts
- PRs: