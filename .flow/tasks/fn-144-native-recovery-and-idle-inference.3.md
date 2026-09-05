---
satisfies: [R1, R2, R4, R6]
---
# fn-144-native-recovery-and-idle-inference.3 Route native model ports and command lifetime through child

## Description
Route native model ports and command lifetime through child. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/llm/native-worker/ports.ts (new), src/llm/nodeLlamaCpp/adapter.ts, src/llm/nodeLlamaCpp/embedding.ts, src/llm/nodeLlamaCpp/generation.ts, src/llm/nodeLlamaCpp/rerank.ts, test/llm/native-worker-ports.test.ts (new)
**Touches:** [src/llm/native-worker/ports.ts, src/llm/nodeLlamaCpp/adapter.ts, src/llm/nodeLlamaCpp/embedding.ts, src/llm/nodeLlamaCpp/generation.ts, src/llm/nodeLlamaCpp/rerank.ts, test/llm/native-worker-ports.test.ts]

### Approach

- Return parent proxy ports for native models and construct actual node-llama-cpp ports only inside child. Keep HTTP adapters on their existing path.
- Invalidate embedding worker/tokenizer caches on model/context generation changes. Preserve dimensions, model identity, structured-output capability, vectors and rerank index mapping.
- Use command-lifetime owner disposal for CLI native calls and persistent owner reuse for resident/stdio MCP. Parent-side model selection/cache discovery must avoid native tokenizer/GPU initialization.
- Document affected adapter/SDK semantics with this behavior change; coordinate native files with fn-145, without creating a second reranker process.

### Investigation targets

**Required:**
- `src/llm/nodeLlamaCpp/adapter.ts:71`
- `src/llm/nodeLlamaCpp/embedding.ts:340`
- `src/llm/types.ts:84`
- `test/llm/node-generation-structured.test.ts`
- `src/llm/registry.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/llm/native-worker-ports.test.ts test/llm/embedding.test.ts test/llm/node-generation-structured.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Record/replay equality through fn-143 compares actual port inputs and full deterministic outputs across all operations.
- [ ] Malformed/late/aborted responses cannot become successful vectors or scores; no automatic write replay.
- [ ] Packed entrypoint resolves worker from installed package; HTTP model calls are not accidentally proxied to native child.

## Done summary
# fn-144.3 handover

Implemented native proxy ports and one owned NativeWorkerClient per LlmAdapter. Parent retains model selection, cache/download policy and HTTP adapters; actual embedding/tokenization/generation/reranking remain in the native child. Shared warm generations support added roles, explicit model disposal drains and retires the complete native child, request leases hold idle retirement, and adapter disposal terminates the child without replay.

Status: in_progress. Host owns Flow, git, integration, full gates and aggregate QA. This worker made no commits, Flow mutations, worktrees, subagents, external communications or hosted-site edits.

### Files and ownership

- `src/llm/native-worker/ports.ts` — new parent proxies; exact full vectors/scores/params/schema; dimensions and generation-bound optional identity; dimension mismatches fail closed and retire the worker.
- `src/llm/nodeLlamaCpp/adapter.ts` — parent-side canonical approval and lazy registration; native-free disposal/lease facade; all native factories return proxy ports, HTTP branches preserved.
- `src/llm/native-worker/client.ts` — approved ownership extension for lease-aware retirement, drained explicit model disposal and compiled-executable recursion guard; unused disposal cannot spawn a fresh worker.
- `src/llm/nodeLlamaCpp/embedding.ts` — disposed context reacquisition; tokenizer/dimension/warning invalidation; pre-load lifecycle snapshot prevents late publication; actual child context/truncation/runtime settings.
- `src/llm/types.ts`, `src/llm/native-worker/protocol.ts` — optional EmbeddingPort.getIdentity contract and closed validated native metadata.
- `src/llm/native-worker/embedding-identity.ts` — new child-only streamed artifact hash, inode/mtime/ctime guard and runtime fingerprint.
- `src/llm/native-worker/dispatcher.ts` — child artifact identity checks, actual embedding metadata returned by init; changed files force generation failure rather than stale context reuse.
- `test/llm/native-worker-ports.test.ts` — new actual IPC fake-child all-port transcript comparison, failure/recovery and ownership regressions.
- `docs/SDK.md`, `docs/CONFIGURATION.md` — child lifetime, error/no-replay behavior, metadata availability, cold reload and packaged runtime requirements.

Generation and rerank implementation files were inspected but unchanged; df9ffe64 sized-rerank semantics preserved.

### Integration contract / hooks

- `LlmAdapter.acquireModelLease()` is an idempotent worker lease. `getManager()` is now a native-free facade exposing only `dispose(uri)` and `acquireLease()`, not a native backend or global manager. Explicit model disposal retires the whole child after pending work drains; other roles reload lazily.
- Existing resident runtime still separately owns its old global ModelManager; task4 must move resident ownership/leases to the adapter worker. This task does not claim that whole serve/MCP parent is already native-free.
- Optional `EmbeddingPort.getIdentity()` after init returns `{contextSize,truncationPolicy,modelFingerprint,runtimeFingerprint}`. Native policy includes effective `min(trainContextSize,contextSize)-4`, e.g. `truncate-tail-tokens-v1:limit=2044`. Model fingerprint hashes actual child-opened GGUF bytes. Runtime fingerprint includes actual backend, Bun/native dependency versions, platform/architecture, context count and configured effective threads/context.
- Parent identity becomes unavailable after retirement/generation changes until init refreshes it. HTTP/custom ports can omit metadata. Coordinated with fn147 worker: missing metadata keeps legacy compatibility only before activated variant authority; no HTTP request/policy changes here.
- Hashing is streamed and once per child embedding-port creation, with before/after inode/size/mtime/ctime checks. Its cold cost is not hidden; native smoke init totals below include it. No global latency claim.
- Parent ModelCache.download uses node-llama-cpp's JS-only resolveModelFile resolver. Inspected installed resolver source: filesystem/model downloader path, no getLlama/tokenizer/backend initialization. Download credentials remain parent-side. Importing library JS exports is not itself native GPU allocation.
- npm and desktop run source entrypoints with a real Bun executable. Verified desktop resolveServeRuntime chooses bundled Bun plus packaged source. Standalone compiled `$bunfs` launch fails explicitly to avoid recursively spawning the CLI; no unshipped standalone binary support claim.
- Actual child-aware capture still required: parent proxy inputs alone cannot establish native tokenizer/context/backend receipts. NativeWorkerClient.processId/currentGeneration remain runtime hooks; smoke inspected the adapter's internal worker only from the isolated QA script.

### Verification

Baseline existing Quick paths: 16 pass, 0 fail; green before edits. New deliverable test did not exist at baseline.

Final focused IPC/protocol/lifecycle/embedding/structured-generation suite: 42 pass, 0 fail, 217 assertions. Existing rerank parity/context/format and generation context suite: 22 pass, 0 fail, 2259 assertions. Targeted typed lint and formatting check: green. Full project gates remain host-owned.

The fake child actually receives framed IPC, records exact operation inputs and returns full deterministic outputs. fn143 compareAcceptance compares complete synthetic transcripts for all inference operations through warm reuse and restart. New synthetic fixture identity; existing frozen fn143 fixtures/baselines untouched. This is mechanical transport equivalence, not native physical paired retrieval acceptance.

Malformed, wrong-dimension, exited and late responses fail without automatic replay; next explicit request recovers. Tests also cover lease-held idle periods/idempotent release, dispose draining, parent HTTP path, production entry metadata, invalid embedding identities, stale tokenizer/context reacquisition and disposal during model loading.

`bun pm pack --ignore-scripts --filename /home/gordon/.cache/agent-tmp/gno-fn144-ports/native-ports.tgz --quiet` passed. Extracted tarball worker init ran successfully from its package-relative entrypoint (child PID4080509), using a symlink to the existing installed dependency tree. This checks packed source resolution, not fresh dependency installation or native packaged inference.

### Actual CUDA smoke — owned slot released

Evidence root `/home/gordon/.cache/agent-tmp/gno-fn144-ports/`; script `native-smoke.ts`, full responses/identity/NVIDIA samples `native-smoke.json`, raw stdout/stderr siblings. Synthetic text only; cached models; CUDA_PATH=/opt/cuda; Bun1.3.14; 150s watchdog; exit0; no stderr fatal. Parent PID4062425 stayed out of NVIDIA compute-process rows throughout observed samples. Pre-existing PIDs1475083/4007014 were untouched.

- First/default TTL300000: child4062524 handled embedding, structured generation and reranking; GPU1560→2620→3592MiB. Immediate repeated full1024-vector embedding exactly equal. Explicit disposal restored the original NVIDIA process list. First init3968ms, including worker startup/model fingerprint/loading.
- Separate TTL100 stratum: child4068965, init2660ms; warm full vector equal; after1500ms owned child absent and original GPU process list restored; next embedding child4070518 returned exactly the same complete1024-vector. Disposal again removed its allocation.
- Actual child model fingerprint matched cached artifact `06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439`; policy limit2044. Role inputs and all raw outputs retained.

Limitations: no full native fn143 paired comparator run, original-scope Ivan3/3, resident REST/MCP recovery, native crash injection/Ask pure-virtual resolution, or full native child capture instrumentation. Smoke source was a shared uncommitted integration checkout, not a frozen QA source archive; later edits only tightened failure paths/tests/docs. No universal performance/reclamation claim or aggregate QA verdict.

stage: impl-review - skipped(policy: user disabled formal reviews; host owns acceptance)
## Evidence
- Commits: cbaa49c000f08e13ac680e59cdab9c608ecf2996
- Tests: TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn144-ports timeout 600 bun test ./test/llm/native-worker-ports.test.ts ./test/llm/embedding.test.ts ./test/llm/node-generation-structured.test.ts ./test/llm/native-worker-lifecycle.test.ts ./test/llm/native-worker-protocol.test.ts (42 pass, 0 fail), TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn144-ports timeout 600 bun test ./test/llm/node-rerank-parity.test.ts ./test/llm/node-rerank-context-size.test.ts ./test/llm/node-rerank-format.test.ts ./test/llm/node-generation-context-size.test.ts (22 pass, 0 fail), bunx oxlint --type-aware --type-check src/llm/native-worker/ports.ts src/llm/nodeLlamaCpp/adapter.ts src/llm/native-worker/client.ts src/llm/nodeLlamaCpp/embedding.ts src/llm/types.ts src/llm/native-worker/protocol.ts src/llm/native-worker/embedding-identity.ts src/llm/native-worker/dispatcher.ts test/llm/native-worker-ports.test.ts (green), bunx oxfmt --check src/llm/native-worker/ports.ts src/llm/nodeLlamaCpp/adapter.ts src/llm/native-worker/client.ts src/llm/nodeLlamaCpp/embedding.ts src/llm/types.ts src/llm/native-worker/protocol.ts src/llm/native-worker/embedding-identity.ts src/llm/native-worker/dispatcher.ts test/llm/native-worker-ports.test.ts docs/SDK.md docs/CONFIGURATION.md (green), bun pm pack --ignore-scripts --filename /home/gordon/.cache/agent-tmp/gno-fn144-ports/native-ports.tgz --quiet (green), TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn144-ports timeout 15 bun /home/gordon/.cache/agent-tmp/gno-fn144-ports/packed-smoke.ts (exit 0), TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn144-ports CUDA_PATH=/opt/cuda GNO_LLAMA_GPU=cuda GNO_LLAMA_BUILD=never GNO_OFFLINE=1 GNO_ALLOW_DOWNLOAD=0 timeout 150 bun /home/gordon/.cache/agent-tmp/gno-fn144-ports/native-smoke.ts (exit 0)
- PRs: