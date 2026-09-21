# Adversarial retrieval evidence coverage gate

## Goal & Context

<!-- scope: business; source: paraphrase -->

Protect useful evidence through GNO's existing retrieval ladder. A result can match the right document while omitting the passage needed to answer, or retrieve one correct source while losing the rest. Add a small reproducible acceptance corpus and paired evaluation that expose these failures before defaults change.

This spec owns the reusable evidence gate and its diagnostics. `fn-165-existing-path-retrieval-quality-and` owns its existing ranking/passage/performance experiments. Reuse the shipped paired-acceptance model-input capture and manifest/case facilities. The native capture already records the exact reranker query and document arguments; do not add a second capture hook just because runtime diagnosis has no reranker-text field. This spec owns the new adversarial evidence scoring and extends the shared case manifest. fn-165 owns ranking/passage/performance experiments and can consume this gate when available; neither spec needs to wait for the other to build another capture producer or baseline corpus. Reference shared cases by stable identity rather than copying them. `fn-78-future-external-retrieval-eval-corpus` remains responsible for licensed external-corpus curation; this spec authors original focused fixtures and requires no external fixture import.

## Architecture & Data Models

<!-- scope: technical; source: inferred -->

Extend the existing paired retrieval acceptance and agentic eval facilities. The source anchor for this reuse decision is `evals/acceptance/native-capture.ts`, whose rerank wrapper records its first two arguments before executing the model. Each versioned, content-hashed case names its query, intent when relevant, eligible scope, required source spans or explicitly acceptable alternative evidence sets, answerability, and fixed usable token budget. Keep retrieval-only and fixed-reader task results separate. Retain original, expansion, semantic and graph provenance through candidate fusion, actual reranker input selection, final ranking and Capsule packing.

Cover exact identifiers/phrases, punctuation and multilingual near-matches; paraphrased concepts against popular hub pages; relevant graph relationships absent from page prose; multi-source and temporal questions; weak lexical matches versus strong semantic evidence; intent text contaminating expansions; duplicate expansion votes; no-contribution cached expansions; source eligibility before top-K; stale/missing sources; and correct abstention. Graph cases must carry valid cited evidence, not unsupported synthetic answers.

Internal scoring sketch, not a new wire format:

```ts
function completeEvidence(
  acceptableSets: readonly (readonly string[])[],
  deliveredSpanIds: ReadonlySet<string>
): boolean {
  return acceptableSets.some(
    (required) =>
      required.length > 0 && required.every((id) => deliveredSpanIds.has(id))
  );
}
```

Span IDs represent sufficient, verified source ranges within the declared budget. Evidence survives only when the actual text supplied at that stage covers the entire required range and verifies its source-span hash after clipping. Partial overlap and clipped tails are misses. Adjacent fragments may jointly cover a span only when supplied together in the same evaluated model input or final handoff; separate reranker invocations cannot pool evidence. A partial line cannot pass merely because its line number matches. Record partial, split-across-inputs and clipped losses distinctly. Document/session presence alone does not satisfy this predicate. Abstention cases use their own outcome rule rather than an empty evidence set. Pin the usable token budget and any independent model-visible byte cap separately in the case manifest.

## API Contracts

<!-- scope: technical; source: inferred -->

Keep public query syntax and retrieval modes stable. Extend developer eval result schemas with per-case all-required-evidence coverage, any-evidence coverage, loss stage, grounded answer/abstention outcome, actual input/output token accounting, latency and resource observations. Attribute failures without publishing raw private content. Exact schema definitions and fixtures must precede implementation; version structured changes compatibly.

| Surface    | Required scope                                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI        | Existing search/query/ask/context/diagnose behavior remains stable; diagnostics explain missing evidence where existing contracts support it. Developer eval commands reproduce paired comparisons. |
| MCP        | Preserve tool catalog and modes; validate diagnostic/result parity and bounded agent projections. Add fields only when the shared diagnosis contract requires them.                                 |
| SDK / REST | Reuse shared evaluation/diagnosis semantics and schemas; no evaluation-only production endpoint.                                                                                                    |
| Web UI     | Verify existing query, answer, source and Capsule displays expose affected evidence/diagnostic states accurately. No benchmark dashboard.                                                           |
| Skills     | Explain when to diagnose missing evidence, collect multiple required sources, and abstain; do not add another retrieval rung or prescribe unproven ranking knobs.                                   |
| Git docs   | Update retrieval/eval guidance, diagnosis examples, evidence-budget semantics and developer reproducibility instructions; retain public claims only when supported.                                 |
| gno.sh     | Reconcile search/ask/context/diagnose docs, relevant feature claims and FAQs about completeness and citations, plus generated agent-readable docs.                                                  |

## Edge Cases & Constraints

<!-- scope: technical; source: inferred -->

Separate cold/fresh generation from cached results; compare identical model/runtime/fixture identities. Pin test queries separately from development cases. Run title/path realism checks so synthetic naming does not accidentally reveal gold evidence. Missing neural execution, dropped cases, contaminated holdouts, unresolved source hashes and unavailable judge models are explicit invalid/blocked comparisons, never passes. Use tiny fixtures for deterministic guards and one bounded native-model acceptance run for finalist checks.

The required paired smoke compares current behavior with the existing noExpand option, proving that the gate can compare real arms without adding a mechanism. Other arms, such as a fixed total expansion contribution, intent isolation or evidence selection, are supplied by their owning implementation specs and are optional consumers of this gate. This spec ships the gate and findings, not candidate ranking code or new product options.

## Acceptance Criteria

<!-- scope: both -->

- **R1:** [paraphrase] Ship a reproducible acceptance set spanning the failure families above with required answer-bearing spans and multi-source evidence sets. Errors: missing gold provenance, empty required sets, stale hashes or duplicate case IDs fail fixture validation; abstention is scored separately.
- **R2:** [inferred] Score evidence survival through candidate retrieval, fusion, reranker input and final budgeted delivery using the shipped paired-acceptance capture records, with complete verified text coverage as defined above. Errors: unknown stages or unavailable raw inputs remain unclassified failures, not invented diagnoses; bounded diagnostics do not disclose excluded content.
- **R3:** [paraphrase] Compare current behavior with the existing noExpand arm using fixed models, scope, usable token budgets and explicit byte caps; report paired gains/losses, all-evidence coverage, grounded task success, abstention, tokens and latency. Errors: degraded neural paths, incomparable budgets and failed executions invalidate the comparison.
- **R4:** [inferred] Freeze guards before candidate runs: all deterministic identity/scope/exclusion/provenance cases pass, every designated must-cover evidence set survives, and no candidate reduces held-out all-evidence or grounded-task success against its pinned baseline. Errors: an existing baseline miss is retained as a failing finding; average score gains cannot conceal guard failures.
- **R5:** [inferred] Verify existing original-query weights, strong-signal expansion bypass, graph evidence and strict lexical behavior without assuming a new policy wins. Errors: no default or public option changes on the strength of an unverified external claim or a single aggregate score.
- **R6:** [paraphrase] Produce replayable per-candidate adoption/rejection evidence for later retrieval changes, extending the shipped acceptance case set and capture format, reusable by fn-165 without a circular dependency. Errors: preserve negative results and limitations; source-only inspection, session-level hits and model-disabled runs cannot be labeled answer-quality success.

**Documentation and delivery obligations.** [paraphrase] Complete the topic-specific documentation work listed in the surface matrix as part of this feature, across the two canonical documentation surfaces: repository Markdown rendered by Git hosting, and `gno.sh`. Update affected README capability/setup examples, changelog, user guides, CLI/MCP/API/configuration reference, architecture explanation, interface specs and structured-output schemas. Keep examples executable and distinguish defaults, opt-ins, unsupported cases and recovery behavior. Update the shipped GNO skill and relevant reference files, connector/harness instructions, and installed-skill verification. Do not create a third documentation site or update the retired in-repository website pages.

For `gno.sh`, update the matching docs/reference pages, relevant product/feature and install pages, FAQs and any affected comparison claims. Register new docs in navigation and prerender/sitemap routes. Verify the HTML and its generated Markdown twin, `/llms.txt`, `/llms-full.txt`, and alternate-format links agree; do not maintain divergent copies. Preserve local-only privacy promises and accurately state any new writes or background behavior. Keep internal eval fixtures, raw diagnostics and design notes out of public user documentation; public docs explain supported behavior and reproducible limits.

**Verification and delivery gates.** [inferred] Run focused regression and schema tests, then `bun run lint:check`, `bun test`, `bun run docs:verify` and documentation/public-truth checks appropriate to the changed scope. Run the topic-specific evals specified in the acceptance criteria; freeze models, fixtures, settings and thresholds before comparing arms, retain negative results, and never lower a threshold to pass. Where CLI/MCP behavior or shipped skill instructions change, run the GNO skill autoresearch eval, reconcile the shipped skill/reference sources and verify installation. Exercise changed CLI/MCP/REST/SDK behavior through actual invocations; drive changed Web UI flows with screenshots/responses, including keyboard and mobile behavior. A build or source inspection is not live QA.

For the hosted site run `bun run check`, `bun run typecheck`, `bun run build` and affected tests, then drive the changed pages locally, including navigation, copy buttons, Markdown twins and narrow width. Keep the GNO and hosted-site changes linked for coordinated delivery. When deployment is authorized, deploy from the canonical site repository and verify production HTTP response, service health, deployed revision, and the changed live pages. Do not claim production verification before deployment. Product publication follows the separately authorized release workflow. Record applicable gates and evidence in the spec completion record, including any blocked external delivery.

## Boundaries

<!-- scope: business -->

- [inferred] No ranking-default adoption, model replacement/training, public leaderboard, new retrieval mode, automatic relaxed search, or general benchmark dashboard.
- [inferred] No duplicate implementation of fn-165 experiments or the shipped reranker capture producer/baseline task set and no licensed external corpus collection under this spec.

## Decision Context

<!-- scope: both -->

- [inferred] A separately shippable evidence gate supplies reusable regression coverage to several retrieval changes without conflating a better metric with a better algorithm.
- [inferred] Original fixtures and actual delivered passages expose failures cheaply; larger public benchmark results remain supplemental and must not replace task grounding.
- [inferred] Maintainability (plan review): duplication - the shipped acceptance native-capture facility records reranker inputs already; fn-167 scores those records and extends the shared manifest while fn-165 owns mechanism experiments. Structure - score captured records outside the production hybrid pipeline; no new parallel tracing framework.
- [inferred] CLI/MCP/UI changes are limited to necessary evidence and diagnosis parity. Unchanged surfaces receive verification and accurate documentation rather than decorative new controls.
