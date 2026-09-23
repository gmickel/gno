# Existing-path retrieval quality and efficiency

## Conversation Evidence

> E1 [user]: "my point was more, we don't need to hillclimb against all languages later, we can focus on the languages of the benchmarks (english i assume), but are limited to using multilingual embeddings/rerankers etc as a product decision. we can still continue this if it is a valuable baseline for later"

> E2 [user]: "record all, then we need to talk about how to proceed, 4B models will surely be much slower at embedding and retrieval, embedding happens often."

> E3 [user]: "judge whether this is needed in our retrieval ladder"

> E4 [user]: "ok, record all and then thhink about how else we could improve"

> E5 [user]: "record these into a spec"

The final request captures the preceding four-part assessment: force-first lexical protection, repeated vector-path work, evidence supplied to the existing reranker, and actual retrieval-ladder task acceptance. Detailed criteria below distinguish captured direction from inferred verification requirements.

## Goal & Context
<!-- scope: business; source: [paraphrase] E1-E5 and the referenced four-part assessment -->

Improve the correctness, evidence efficiency and resource cost of GNO's existing retrieval paths while keeping current models and the user-facing retrieval ladder stable. Favor removing unnecessary mechanisms over adding modes or overlapping heuristics.

The completed relaxed-matching experiments produced large lexical-only gains but small or negative hybrid transfer and missing-anchor risks. Gordon accepted keeping relaxed matching research-only. That capability does not establish a need for another ladder step or public option.

Existing evidence identifies narrower opportunities:

- [inferred] Original lexical top-hit protection can confuse original-query rank with best rank across lexical expansions. A retained strict-control case has an original rank-two document promoted first after ranking first in an expansion, despite a higher-scored alternative. This proves a provenance mismatch, not that every proposed correction improves relevance.
- [inferred] Retained SciFact observations locate most query time in the vector stage. A single existing vector-integrity SQL check took roughly 1.8–2.2 seconds over 5,238 vectors. These shared-machine observations identify work to profile; they are not production latency targets.
- [inferred] One required conversation session moved from final rank five to ten and received a low reranker score. Actual model inputs must establish whether passage selection, clipping or another stage caused the loss.
- [strategy:Trustworthy retrieval and evidence] Success must include supported task completion and bounded, reproducible evidence, not just improved aggregate ranking scores.

## Architecture & Data Models
<!-- scope: technical; source: [paraphrase] captured assessment; [inferred] reuse and verification structure -->

Use one common baseline and four ordered workstreams. Define task-level acceptance before tuning; apply it to surviving candidates after the focused stage checks.

1. **Ranking-protection ablation.** Compare current behavior against removing only the final force-first lexical override. Preserve existing weighted fusion and blending. If exact lookups regress, assess narrower protection with actual original-query rank distinguished from best expanded-query rank. Do not add another heuristic or data field unless the evidence establishes a need.
2. **Vector-path cost decomposition.** Measure integrity checking, formatted-input validation, eligibility construction and distance ranking separately. Evaluate one correctness-preserving optimization at a time, such as work shared within one consistent request/read snapshot, batched searches over the same validated inputs, or a demonstrably better query plan. Cross-request global caching is not the starting design.
3. **Reranker evidence diagnosis.** Capture the actual candidate passages and model inputs for evidence-loss cases. Only pursue a passage-window or document-diversity change when the capture identifies a specific problem. Keep the candidate and context budgets fixed. Distinguish reranker-input changes from embedding-chunk changes that require re-embedding.
4. **Existing-ladder task acceptance.** Reuse the existing agentic and paired-retrieval acceptance foundations for exact lookup, uncertain wording, multi-source evidence and missing information. Hold the agent model, instructions and tool budget fixed while changing retrieval implementation.

Evidence records retain source, fixture, model and configuration identities; deterministic outputs; volatile observations separately; exact inputs and selected passages where relevant; positive and negative results; and the decision for each candidate. Replay is usable only when complete retained inputs reproduce the baseline exactly. Missing or truncated replay inputs require actual pipeline calls.

### Relationship to existing work

- [inferred] Reuse the completed paired quality/resource acceptance foundation in fn-143 and agentic outcome benchmark in fn-97; do not build parallel acceptance frameworks.
- [inferred] Preserve the guarantees established by fn-145 (reranker context/score parity), fn-148 (eligibility before top-K) and fn-149 (request-local hydration reuse). Establish what additional work remains on the selected current revision.
- [inferred] Coordinate with open fn-121 only where evidence shows an overlap. Display-snippet cleanup is distinct from the passages actually supplied to a model.
- [paraphrase] The independent recall-specific lexical work in fn-137 and model-training/corpus-expansion work are outside this scope.

## API Contracts
<!-- scope: technical -->

- [paraphrase] Preserve existing CLI, MCP, SDK and REST retrieval modes, input syntax, default model selection and the retrieval ladder. This work adds no relaxed-search option or new routing decision.
- [paraphrase] Preserve strict keyword/phrase/identifier behavior, exclusions, scopes, source identities, citation anchors and existing error/cancellation semantics.
- [inferred] Performance-only candidates must retain deterministic retrieval results and downstream model inputs. Timing/allocation observations may differ and must be reported separately from semantic parity.
- [inferred] A justified ranking or passage-selection change may intentionally change ordering or selected evidence; evaluate it against declared quality guards rather than falsely claiming byte-identical output. Any actual contract change must be specified and reconciled across supported surfaces before adoption.

## Edge Cases & Constraints
<!-- scope: technical -->

- [paraphrase] Distinguish original lexical rank from expansion rank, including duplicate appearances and tied ranks. Do not assume that correcting the provenance mismatch alone improves answer quality.
- [paraphrase] Preserve invalidation, stale-input rejection, vector corruption/missing-entry detection, tenant/collection eligibility, model identity and behavior under concurrent updates. Faster execution obtained by omitting these checks is unacceptable.
- [paraphrase] Request-local work must not outlive its valid snapshot or leak across callers, collections, models, completion or cancellation.
- [paraphrase] Preserve required evidence at the declared usable context budget. Whole-document or whole-session hits do not establish answer-bearing passage coverage or answer accuracy.
- [paraphrase] Retain realistic filenames, titles and structured query inputs. Synthetic path/title artifacts must not become field-weight tuning targets.
- [paraphrase] Keep current multilingual model identities fixed for comparisons. Routine development can focus on English; use targeted multilingual regressions for finalists or material changes.
- [paraphrase] Keep final holdouts out of tuning, isolate experimental indexes from normal collections, and do not stop healthy services or user workloads to manufacture a favorable result.
- [inferred] Qualify performance measurements by workload, corpus size, hardware, process/model residency and host load. Separate cached expansion from fresh generation and initial/incremental embedding from reused corpus vectors.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** [inferred] Establish a reproducible baseline with pinned source, fixtures, models, settings, evidence budgets and task inputs. Before comparisons, declare the measured benefit and guard criteria for each candidate. Reuse existing acceptance facilities and retain negative results. Errors: missing provenance, incomplete replay inputs, degraded neural execution or load-confounded timing cannot silently count as comparable acceptance evidence.
- **R2:** [paraphrase] Complete the force-first ablation with current models, strict matching, fusion weights and blending otherwise unchanged; cover the observed provenance mismatch and exact identifier/phrase regressions. Record whether deletion is supported or rejected. If narrower protection is pursued, distinguish actual original-query rank from expansion rank and test it separately. Errors: an expansion winner's mere presence in the original list must not be misrepresented as original rank one; no quality benefit may be inferred from that bookkeeping correction alone.
- **R3:** [paraphrase] Decompose vector-stage cost and evaluate a bounded, correctness-preserving candidate against the baseline, recording reads/work counts, latency and memory across single/multi-route and warm/fresh requests. Errors: corrupted/missing vectors, stale formatted inputs, concurrent mutation, cancellation and scope/model changes retain their correctness boundaries; a speedup obtained by skipping validation or eligibility fails acceptance. The already-slower materialized-query alternative remains a retained negative result.
- **R4:** [paraphrase] Capture actual reranker passages for the evidence-loss cases and either identify a supported input-selection problem and compare a fixed-budget correction, or record that no correction is justified. Errors: missing, clipped, split or duplicate-dominated evidence must remain visible; shortened context or corpus re-embedding cannot be hidden as a like-for-like input-selection optimization.
- **R5:** [strategy:Trustworthy retrieval and evidence] Run a small fixed task acceptance set covering exact lookup, uncertain wording, multi-source evidence and missing information, with the same agent model/instructions/tool budget on both sides. Report grounded task success, correct abstention, retrieval calls, elapsed time and model-visible context. Errors: unsupported answers, missed required evidence, premature stopping, scope violations and unnecessary reads are explicit outcomes; harness failures are not scored as successful retrieval.
- **R6:** [inferred] Produce a per-candidate adoption or rejection decision supported by stage metrics, exact regression cases and task outcomes. A small aggregate nDCG gain cannot override a new correctness or required-evidence guard failure. Document the source/version and applicable workload of every performance claim. Errors: development-only evidence, cached generation, synthetic microprobes or mixed-load observations cannot be relabeled as held-out or production acceptance; a rejected experiment is a valid recorded outcome.
- **R7:** [paraphrase] Keep the existing modes, current models and ladder intact, with no relaxed-search feature, new model sweep or unrelated interface expansion. Reconcile documentation and supported-surface verification for any candidate ultimately adopted. Errors: a research result must not silently change defaults, installed agent instructions or the meaning of an existing retrieval contract.

## Boundaries
<!-- scope: business -->

- [paraphrase] No relaxed-search CLI/MCP option, automatic fallback after failed exact lookup, or additional retrieval-ladder step.
- [paraphrase] No embedding/reranker model migration, broader model sweep, routine all-language hill-climbing, or new semantic backend.
- [paraphrase] No removal of integrity, eligibility, privacy, citation or snapshot guarantees; no general cross-request cache/invalidation framework.
- [paraphrase] No unrelated ingestion, graph-ranking, display-snippet or memory-management redesign.
- [paraphrase] No public leaderboard, representative-workload, production speed or final-answer accuracy claim unsupported by the corresponding evaluation.

## Decision Context
<!-- scope: both -->

- [paraphrase] A feasible optional capability is not sufficient evidence that the agent ladder needs it. Relaxed search remains research-only; its interface and instruction plans are deferred.
- [paraphrase] Prefer testing deletion of the final override before adding more ranking bookkeeping. Existing fusion weights, bonuses and blending already favor original results.
- [inferred] The captured strict-control observation concerns one case among 138 inspected queries. The true original lexical top hit was also not the gold evidence, so neither a corrected pin nor deletion is a predetermined winner.
- [paraphrase] The vector-integrity probe identifies a measurable cost. The materialized-query rewrite was slower and was rejected; it is not a candidate to ship without new evidence.
- [paraphrase] Passage selection and task-level acceptance help distinguish useful evidence from improved document-ranking proxies. Changing the reranker model is not the first response to a poorly scored passage.

## Strategy Alignment

- [strategy:Trustworthy retrieval and evidence] Improve inspectable retrieval, diagnosis and reproducible task-grounding evidence.
- [strategy:Coherent agent and application surfaces] Keep existing human and agent interfaces consistent while improving the shared retrieval implementation.

## Parked unknowns

- [inferred] Numeric latency/memory and task-quality promotion budgets, target hardware and repetition counts remain unset; declare them before candidate acceptance rather than inventing them here.
- [inferred] Whether any form of force-first protection remains necessary depends on the ablation and exact-lookup regressions.
- [inferred] Which vector substep can safely share work, and which reranker input correction is justified, remain experimental questions.

## Requirement coverage

| Requirement | Planned task mapping |
|---|---|
| R1 | TBD during task breakdown |
| R2 | TBD during task breakdown |
| R3 | TBD during task breakdown |
| R4 | TBD during task breakdown |
| R5 | TBD during task breakdown |
| R6 | TBD during task breakdown |
| R7 | TBD during task breakdown |
