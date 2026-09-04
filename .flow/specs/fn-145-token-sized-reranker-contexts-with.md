# Token-sized reranker contexts with score parity

## Conversation Evidence

> user: "before we capture all of this into flow-next specs (decide on no-plan vs plan specs and how many specs based on complexity and risk etc), we need to also be sure that nothing will cause a worsening in retrieval performance"
> user: "you can easily creat new longer inputs to do a bit more testing if needed and yes i agree we need to detail the tradeoffs between memory and slightly slower cold next query etc, in general people use gno agentically ie. through claude code/codex etc and are not expecting instant results probably"
> user: "ok, great we will be implementing with heavy QA and not impl-reviews/plan-reviews, more fitting here i think, we should set the review backend to none in flow next and esure QA is turned on, also deactivate plan sync if activated"
> user: "commit and push, then capture all specs, again decide on no-plan, plan based on our needs"

## Goal & Context
<!-- scope: business; source: [inferred] from the authorized audit synthesis -->

Reduce avoidable reranker allocation while retaining every prepared query/document input and score. Auto context selected 40,960 tokens; a short-input comparison saved about 4.2 GiB whole-device allocation at 2K. Extended EN/DE/CJK tests preserved 122 scores and 69 rankings exactly with contexts of 512–2,560 tokens. Twelve controlled CJK inputs exceeded 2K and a separate long query required 6,025 tokens.

## Architecture & Data Models
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Size contexts from the full native formatted query/document token requirement, including native padding and model constraints. Reuse compatible contexts safely without shortening inputs to force a smaller allocation. Establish a supported or pinned/tested formatter contract; the research helper alone is not a production API. Preserve a safe auto fallback whenever exact sizing cannot be established.

## API Contracts
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Keep reranker ordering, scores, candidate preparation, deduplication and caller-visible error semantics intact. Expose only policy/config changes justified during planning; no new output shape is assumed. Any capacity error must remain visible rather than silently losing candidates.

## Edge Cases & Constraints
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Cover EN/DE/CJK and mixed scripts, long queries, model/template changes, empty inputs and near-model-limit formatting. Production preparation may truncate oversized custom chunks; this scope must not add truncation. Default ingestion bounds ordinary chunks below the tested clipping threshold. A context resize must not race active scoring or other model retirement.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** Determine capacity from complete formatted native tokens with required padding and the model maximum; use safe auto fallback when exact sizing is unavailable. Errors: invalid/unsupported formatter or over-model-limit input never silently truncates additional evidence or returns partial scoring success. [inferred]
- **R2:** Reproduce the frozen 45-case long-input matrix and repeated pairs, preserving all prepared scores and rankings exactly on deterministic runs. Include CJK above 2K and long-query cases. Errors: every changed input, score, dedup outcome or order is a failure unless independently explained as pre-existing behavior. [paraphrase]
- **R3:** Demonstrate lower native allocation for short representative inputs against auto sizing on CUDA and physical Metal, while measuring context creation plus scoring and cold/warm states. Errors: retain slower pairs and inconclusive measurements; do not generalize the earlier 4.2 GiB observation to every workload. [paraphrase]
- **R4:** Repeated batches, growing/shrinking inputs and idle reload preserve safe ownership and complete scoring across public retrieval surfaces. Errors: cancellation, concurrent use and disposal never score through an invalid context or report omitted candidates as success. [inferred]
- **R5:** Run real hybrid/Ask quality checks with unchanged model weights, candidate counts and passage text, and update user-facing model/resource guidance where behavior changes. Errors: lexical-only evaluation or reduced retrieval depth cannot satisfy parity. [paraphrase]

## Boundaries
<!-- scope: business -->

No universal 2K/512 cap, model quantization change, reduced rerank depth, new chunking policy or claim to fix fn-141 solely through smaller contexts. [inferred]

## Decision Context
<!-- scope: both -->

Plan required because native templates, exact tokens, context reuse and maximum capacities interact. Dynamic sizing has positive measured parity; a fixed cap is disproven by long/CJK input. Keep this separate from lifecycle ownership so resource and scoring effects can be isolated. [inferred]

## Validation and QA

Drive actual query and Ask with short, long and multilingual evidence, inspect ordered candidates/citations, record per-process memory and paired latency, and repeat after native idle reload. Preserve all negative and slower cases. [inferred]

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
