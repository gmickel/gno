# Native recovery and idle inference reclamation

## Conversation Evidence

> user: "before we capture all of this into flow-next specs (decide on no-plan vs plan specs and how many specs based on complexity and risk etc), we need to also be sure that nothing will cause a worsening in retrieval performance"
> user: "you can easily creat new longer inputs to do a bit more testing if needed and yes i agree we need to detail the tradeoffs between memory and slightly slower cold next query etc, in general people use gno agentically ie. through claude code/codex etc and are not expecting instant results probably"
> user: "ok, great we will be implementing with heavy QA and not impl-reviews/plan-reviews, more fitting here i think, we should set the review backend to none in flow next and esure QA is turned on, also deactivate plan sync if activated"
> user: "commit and push, then capture all specs, again decide on no-plan, plan based on our needs"

## Goal & Context
<!-- scope: business; source: from the authorized audit synthesis -->

Resident GNO should release native RAM/GPU allocations during idle periods and transparently resume useful semantic retrieval. Ivan returned 20 API query results before model expiry and zero afterward, still HTTP 200 with vectorsUsed=true; a fresh serve process restored the identical result array. Linux full backend disposal retained 434–436 MiB GPU, while child exit reclaimed it. This scope carries forward fn-141 native Metal abort requirements as well as the newly confirmed recovery defect.

## Architecture & Data Models
<!-- scope: technical; source: from the authorized audit synthesis -->

Own native inference in one persistent child per existing resident runtime. Keep stores, watchers, jobs, policy and transports in a native-free parent. Start models lazily, preserve warm reuse, and retire the child only after actual inference inactivity and completed work. Initially retain the existing five-minute idle grace. One owner coordinates initialization, model/context generations, leases, retirement and restart. Native embedding, reranking and generation use the same boundary; native CLI calls use the same command-lifetime child for structured crash containment; command exit cleans up that child.

## API Contracts
<!-- scope: technical; source: from the authorized audit synthesis -->

Preserve supported CLI, SDK, MCP and REST retrieval/error contracts. A failed vector operation must not become an empty successful answer claiming vectors were used. Map abnormal child exit to a stable structured host error and keep resident clients/services alive. Parent enforces caller identity, index/model selection and egress policy. Do not silently retry writes.

## Edge Cases & Constraints
<!-- scope: technical; source: from the authorized audit synthesis -->

Deduplicate backend initialization, dispose late timeout results exactly once, invalidate cached contexts/tokenizers with their owner, and prevent old initialization from publishing after shutdown. Requests racing retirement acquire a valid generation or await retirement completion. Active calls, pending responses and native jobs prevent retirement; metadata traffic must not renew unrelated models. Startup dimension discovery uses validated index/model metadata when available and initializes lazily otherwise. All supported platforms need safe paths; unavailable native capability stays visible.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** The same actual semantic API request returns the same complete results before expiry, after expiry and after repeated idle/reload cycles. Include the Ivan 20-result reproduction and corresponding CLI/MCP use. Errors: stale disposed contexts trigger safe acquisition; failed reload follows the documented error/fallback contract without false vectorsUsed success. [paraphrase]
- **R2:** Concurrent backend initialization creates one owned backend, late completions are cleaned exactly once, and model/context generations cannot be reused after disposal or model/config change. Errors: initialization failure, timeout, teardown races and concurrent single/batch calls leave no orphaned or stale live owner.
- **R3:** A lightweight parent holds no native GPU allocation; the idle child exits and its process allocation disappears, while active agent bursts reuse the child. Retain five-minute grace initially and measure any optional shorter policy separately. Errors: active native work or pending delivery prevents idle exit; metadata-only requests do not extend model residency.
- **R4:** Embedding, reranking and generation preserve actual model inputs and deterministic outputs through warm calls and child restart, with bounded transport capacity. Errors: malformed responses, oversized batches and unexpected child exit surface explicit failures and release resources without leaking caller data or replaying writes.
- **R5:** Retain fn-141 R1: the original Ivan query completes 3/3 with expansion and reranking after embedding has loaded; retain R2: regression evidence pins the configuration avoiding GGML_ASSERT(buft). Errors: normal child retirement, Linux success or stable error containment alone cannot satisfy the original crash-resolution requirement.
- **R6:** Test abnormal native child termination and resident recovery, including the prior Ask pure-virtual crash scenario where reproducible. Errors: the host survives, callers get a stable structured failure, subsequent valid requests recover, and raw native termination cannot destroy CLI JSON output.
- **R7:** Retain fn-141 R3 and document the symptom, fix, idle policy, actual warm/cold tradeoff and resource accounting across affected product surfaces. Errors: evidence must state unreproduced native cases and measured coverage; do not promise universal memory or latency numbers.

## Boundaries
<!-- scope: business -->

No machine-wide broker, automatic live client-registration changes, CPU-only default, lower precision, reduced candidate depth or process-per-tool default. Child isolation does not itself prove the Metal root cause fixed. Cancellation/scheduling extensions belong to the dependent cancellation scope using this ownership contract.

## Strategy Alignment

- **Trustworthy retrieval and evidence**: preserve per-case evidence and inspectable failure states.
- **Local knowledge lifecycle**: bound native/request resource lifetime without hidden loss of knowledge coverage.
- **Coherent agent and application surfaces**: verify actual supported CLI/MCP/API behavior and hosted documentation where changed.

## Decision Context
<!-- scope: both -->

Plan required for cross-surface native lifecycle, concurrency, crash handling and physical platform validation. Ivan released about 839 MiB RSS for about 535 ms extra next-embedding time; Linux child prototype added 0.31–0.44 ms warm messaging overhead and 1.36–1.51 s cold response time. These embedding-only probes justify the boundary, not universal full-query budgets. The original fn-141 evidence remains authoritative for its failure. Related prior memory records an Ask pure-virtual abort with unspecified root cause.

## Validation and QA

Drive serve/API semantic calls across real expiry, metadata traffic, concurrent calls and restart on Ivan and CUDA. Test direct CLI and stdio/resident MCP, all native ports, bounded batches and fault containment. Record full result arrays and memory/latency states. Use isolated data and owned processes; never induce a crash in the live service.

Use heavy live QA and focused regression tests, with the full project lint/typecheck/test/docs gates before handoff. Formal plan-review and impl-review stages are disabled by the user; QA stays enabled and plan sync stays disabled. A reachable running surface and captured evidence are required for a QA pass. Missing physical coverage is explicit incomplete acceptance. [paraphrase]

Update affected public behavior/API contracts and product documentation with implementation, including hosted guidance when applicable. Keep private fixtures and machine-local indexes out of committed evidence.

## Evidence and provenance

[Canonical audit, final recommendations and probe results](gno://projects/gno/GNO%20Performance%20and%20System%20Cost%20Audit%20-%202026-09-04.md). Research date 2026-09-04; capture date 2026-09-05. Measurements establish the proposed work, not shipped correctness. The audit preserves report names and reproducible synthetic evidence locations. Source tags distinguish user intent from research-derived criteria.

## Planning decisions

Use the same native protocol for a command-lifetime CLI child and a persistent child in resident/stdio runtimes. Parent remains native-free including discovery/tokenization. Initially one active native operation,64 queued operations,8MiB frames and64MiB logical-operation ceiling; split embedding batches without loss. Five-minute idle grace remains. Concurrent baseline QA must validate admission cost before default promotion; unexplained steady-state regression requires adjustment within this scope. Worker generations, one-settlement and model-specific leases are owned here.

All previously inferred requirements were grounded against current source and audit probes during this planning pass. Existing R-IDs and superseded acceptance remain unchanged. New operational bounds are implementation defaults to test, not universal performance promises.

## Execution and ownership

Tasks below form the implementation plan. Each task carries exact files, investigation anchors, focused tests and scope-specific QA. Shared native/store/migration/hosted-doc edits are serialized by ownership across otherwise independent specs. Native QA is serialized per GPU. fn-138 and fn-141 remain superseded evidence records and receive no work.

- Wave 1: fn-144-native-recovery-and-idle-inference.1
- Wave 2: fn-144-native-recovery-and-idle-inference.2
- Wave 3: fn-144-native-recovery-and-idle-inference.3
- Wave 4: fn-144-native-recovery-and-idle-inference.4
- Wave 5: fn-144-native-recovery-and-idle-inference.5
- Wave 6: fn-144-native-recovery-and-idle-inference.6

## Early proof point

fn-144-native-recovery-and-idle-inference.1 pins the governing contract and negative cases before dependent implementation. If this proof fails, correct the contract or fixture within that task before continuing; do not weaken parent acceptance.

## Requirement coverage

| Requirement | Tasks |
|---|---|
| R1 | fn-144-native-recovery-and-idle-inference.3, fn-144-native-recovery-and-idle-inference.4, fn-144-native-recovery-and-idle-inference.5 |
| R2 | fn-144-native-recovery-and-idle-inference.1, fn-144-native-recovery-and-idle-inference.2, fn-144-native-recovery-and-idle-inference.3 |
| R3 | fn-144-native-recovery-and-idle-inference.2, fn-144-native-recovery-and-idle-inference.4, fn-144-native-recovery-and-idle-inference.6 |
| R4 | fn-144-native-recovery-and-idle-inference.1, fn-144-native-recovery-and-idle-inference.3, fn-144-native-recovery-and-idle-inference.5 |
| R5 | fn-144-native-recovery-and-idle-inference.5, fn-144-native-recovery-and-idle-inference.6 |
| R6 | fn-144-native-recovery-and-idle-inference.1, fn-144-native-recovery-and-idle-inference.2, fn-144-native-recovery-and-idle-inference.3, fn-144-native-recovery-and-idle-inference.5 |
| R7 | fn-144-native-recovery-and-idle-inference.6 |
