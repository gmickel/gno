# Native recovery and idle inference reclamation

## Conversation Evidence

> user: "before we capture all of this into flow-next specs (decide on no-plan vs plan specs and how many specs based on complexity and risk etc), we need to also be sure that nothing will cause a worsening in retrieval performance"
> user: "you can easily creat new longer inputs to do a bit more testing if needed and yes i agree we need to detail the tradeoffs between memory and slightly slower cold next query etc, in general people use gno agentically ie. through claude code/codex etc and are not expecting instant results probably"
> user: "ok, great we will be implementing with heavy QA and not impl-reviews/plan-reviews, more fitting here i think, we should set the review backend to none in flow next and esure QA is turned on, also deactivate plan sync if activated"
> user: "commit and push, then capture all specs, again decide on no-plan, plan based on our needs"

## Goal & Context
<!-- scope: business; source: [inferred] from the authorized audit synthesis -->

Resident GNO should release native RAM/GPU allocations during idle periods and transparently resume useful semantic retrieval. Ivan returned 20 API query results before model expiry and zero afterward, still HTTP 200 with vectorsUsed=true; a fresh serve process restored the identical result array. Linux full backend disposal retained 434–436 MiB GPU, while child exit reclaimed it. This scope carries forward fn-141 native Metal abort requirements as well as the newly confirmed recovery defect.

## Architecture & Data Models
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Own native inference in one persistent child per existing resident runtime. Keep stores, watchers, jobs, policy and transports in a native-free parent. Start models lazily, preserve warm reuse, and retire the child only after actual inference inactivity and completed work. Initially retain the existing five-minute idle grace. One owner coordinates initialization, model/context generations, leases, retirement and restart. Native embedding, reranking and generation use the same boundary; ordinary CLI process exit remains natural cleanup.

## API Contracts
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Preserve supported CLI, SDK, MCP and REST retrieval/error contracts. A failed vector operation must not become an empty successful answer claiming vectors were used. Map abnormal child exit to a stable structured host error and keep resident clients/services alive. Parent enforces caller identity, index/model selection and egress policy. Do not silently retry writes.

## Edge Cases & Constraints
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Deduplicate backend initialization, dispose late timeout results exactly once, invalidate cached contexts/tokenizers with their owner, and prevent old initialization from publishing after shutdown. Requests racing retirement acquire a valid generation or await retirement completion. Active calls, pending responses and native jobs prevent retirement; metadata traffic must not renew unrelated models. Startup dimension discovery uses validated index/model metadata when available and initializes lazily otherwise. All supported platforms need safe paths; unavailable native capability stays visible.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** The same actual semantic API request returns the same complete results before expiry, after expiry and after repeated idle/reload cycles. Include the Ivan 20-result reproduction and corresponding CLI/MCP use. Errors: stale disposed contexts trigger safe acquisition; failed reload follows the documented error/fallback contract without false vectorsUsed success. [paraphrase]
- **R2:** Concurrent backend initialization creates one owned backend, late completions are cleaned exactly once, and model/context generations cannot be reused after disposal or model/config change. Errors: initialization failure, timeout, teardown races and concurrent single/batch calls leave no orphaned or stale live owner. [inferred]
- **R3:** A lightweight parent holds no native GPU allocation; the idle child exits and its process allocation disappears, while active agent bursts reuse the child. Retain five-minute grace initially and measure any optional shorter policy separately. Errors: active native work or pending delivery prevents idle exit; metadata-only requests do not extend model residency. [inferred]
- **R4:** Embedding, reranking and generation preserve actual model inputs and deterministic outputs through warm calls and child restart, with bounded transport capacity. Errors: malformed responses, oversized batches and unexpected child exit surface explicit failures and release resources without leaking caller data or replaying writes. [inferred]
- **R5:** Retain fn-141 R1: the original Ivan query completes 3/3 with expansion and reranking after embedding has loaded; retain R2: regression evidence pins the configuration avoiding GGML_ASSERT(buft). Errors: normal child retirement, Linux success or stable error containment alone cannot satisfy the original crash-resolution requirement. [inferred]
- **R6:** Test abnormal native child termination and resident recovery, including the prior Ask pure-virtual crash scenario where reproducible. Errors: the host survives, callers get a stable structured failure, subsequent valid requests recover, and raw native termination cannot destroy CLI JSON output. [inferred]
- **R7:** Retain fn-141 R3 and document the symptom, fix, idle policy, actual warm/cold tradeoff and resource accounting across affected product surfaces. Errors: evidence must state unreproduced native cases and measured coverage; do not promise universal memory or latency numbers. [inferred]

## Boundaries
<!-- scope: business -->

No machine-wide broker, automatic live client-registration changes, CPU-only default, lower precision, reduced candidate depth or process-per-tool default. Child isolation does not itself prove the Metal root cause fixed. Cancellation/scheduling extensions belong to the dependent cancellation scope using this ownership contract. [inferred]

## Decision Context
<!-- scope: both -->

Plan required for cross-surface native lifecycle, concurrency, crash handling and physical platform validation. Ivan released about 839 MiB RSS for about 535 ms extra next-embedding time; Linux child prototype added 0.31–0.44 ms warm messaging overhead and 1.36–1.51 s cold response time. These embedding-only probes justify the boundary, not universal full-query budgets. The original fn-141 evidence remains authoritative for its failure. Related prior memory records an Ask pure-virtual abort with unspecified root cause. [inferred]

## Validation and QA

Drive serve/API semantic calls across real expiry, metadata traffic, concurrent calls and restart on Ivan and CUDA. Test direct CLI and stdio/resident MCP, all native ports, bounded batches and fault containment. Record full result arrays and memory/latency states. Use isolated data and owned processes; never induce a crash in the live service. [inferred]

Use heavy live QA and focused regression tests, with the full project lint/typecheck/test/docs gates before handoff. Formal plan-review and impl-review stages are disabled by the user; QA stays enabled and plan sync stays disabled. A reachable running surface and captured evidence are required for a QA pass. Missing physical coverage is explicit incomplete acceptance. [paraphrase]

Update affected public behavior/API contracts and product documentation with implementation, including hosted guidance when applicable. Keep private fixtures and machine-local indexes out of committed evidence. [inferred]

## Evidence and provenance

[Canonical audit, final recommendations and probe results](gno://projects/gno/GNO%20Performance%20and%20System%20Cost%20Audit%20-%202026-09-04.md). Research date 2026-09-04; capture date 2026-09-05. Measurements establish the proposed work, not shipped correctness. The audit preserves report names and reproducible synthetic evidence locations. Source tags distinguish user intent from research-derived criteria.

## Requirement coverage

| Requirement | Task |
|---|---|
| R1 | TBD during planning |
| R2 | TBD during planning |
| R3 | TBD during planning |
| R4 | TBD during planning |
| R5 | TBD during planning |
| R6 | TBD during planning |
| R7 | TBD during planning |
