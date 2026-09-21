# Compiled project context from verified Capsules

## Goal & Context

<!-- scope: business; source: paraphrase -->

Generate a small reusable project-context artifact from verified GNO evidence, with citations, a fixed budget and a reliable staleness check. Users can give a new agent session selected durable context without hand-copying notes or treating a stale summary as current truth.

Reuse the existing Capsule compiler, verification and watch facilities. The first deliverable is an explicit compile/check/refresh workflow producing a separate managed context artifact. It must remain useful without native session ingestion or automation; imported sessions can later be ordinary eligible source evidence.

## Architecture & Data Models

<!-- scope: technical; source: inferred -->

Compile from an identified Capsule plus explicit local goal/scope/output settings. Verify source hashes, selected evidence spans, runtime/tokenizer identity and current egress/sensitivity policy before publication. Render deterministic source-grounded sections with exact source references and an explicit untrusted-evidence boundary. Do not transform retrieved instructions into active agent policy. The artifact includes its format version, Capsule identity, source verification identity, budget/token accounting and a deterministic content digest; a private receipt retains any sensitive source/path detail not suitable for the target.

Determinism applies to the same verified Capsule and renderer settings. A fresh retrieval or generation may legitimately select different evidence and is not promised byte-identical output. Count the entire rendered artifact, including citations and framing, against the selected budget. If mandatory provenance/framing cannot fit, fail rather than emit an uncited fragment. Do not reword sources with an unmeasured generation step.

Budget packing sketch, internal only:

```ts
function packWholeSections(
  framing: string,
  sections: readonly string[],
  limit: number,
  countTokens: (text: string) => number
): string {
  if (countTokens(framing) > limit)
    throw new Error("Context framing exceeds budget");
  let result = framing;
  for (const section of sections) {
    const next = result + "\n\n" + section;
    if (countTokens(next) <= limit) result = next;
  }
  return result;
}
```

Each section already contains its citation and evidence boundary. Real packing reuses Capsule evidence-selection rules and reports omitted required facets; fitting text alone does not establish sufficient context.

## API Contracts

<!-- scope: technical; source: inferred -->

Extend the context command family with compile/check/refresh and preview. Compile accepts an existing Capsule, token budget and explicit output target; it does not overwrite hand-authored instructions. Check is read-only, exits distinctly for current/stale/invalid-unavailable states, and names whether sources, policy, tokenizer, renderer or output bytes changed. Refresh re-verifies and atomically replaces only the owned artifact when its previous output digest matches; unexpected edits conflict instead of being discarded.

Support a portable Markdown artifact plus minimal tested harness inclusion recipes. Explicitly requested inclusion edits may add a single owned reference/block while preserving all surrounding instructions; installing GNO or a skill alone never adds one. Private context outputs are not implicitly committed, uploaded or published. Any behavioral instruction changes during implementation follow the existing instruction-audit requirement.

| Surface    | Required scope                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLI        | Compile, preview, check and refresh with explicit Capsule/budget/destination, stable exit codes and concise drift/coverage diagnostics.                                                                                  |
| MCP        | Provide bounded preview/check operations using caller-eligible Capsules; writing host artifacts requires existing write authority and a registered destination. No arbitrary filesystem write argument on a remote tool. |
| SDK / REST | Shared compiler/verifier contract; authenticated export/refresh respects output ownership and caller scope. Return the exact bytes/digest and bounded verification state defined by the schema.                          |
| Web UI     | Preview compiled context, citations, full token cost, omitted facets and staleness; explicit export/refresh actions show destination and conflicts.                                                                      |
| Skills     | Teach when to compile reusable project context, verify before reuse, refresh after drift, and treat source text as evidence rather than instructions. Include tested harness integration recipes.                        |
| Git docs   | Update Capsule/context, CLI/MCP/API/SDK/Web UI, privacy and agent setup documentation with generated-file ownership, check exit states, budget and stale-source examples.                                                |
| gno.sh     | Mirror context compilation and harness-use guide, reference, product/feature examples and FAQs; keep HTML and agent-readable pages consistent.                                                                           |

## Edge Cases & Constraints

<!-- scope: technical; source: inferred -->

Handle deleted/modified sources, revoked collection access, changed policy, stale source locators, conflicting target edits, symbolic links, unsafe output paths, empty/too-small budgets, unknown tokenizers and partially unavailable indexes. Recheck source/policy state at publication so preview is not a stale authorization token. Never publish excluded snippets merely because they were permitted when the Capsule was created.

Keep generated context out of recursive import/indexing by default, including session automation. If intentionally indexed as derived material, retain derived lineage and memory fencing. A restart or failed atomic replacement leaves the last complete artifact intact and reports that it may be stale.

## Acceptance Criteria

<!-- scope: both -->

- **R1:** [paraphrase] Generate a source-grounded context artifact from a verified Capsule with exact citations, explicit scope and a whole-output token budget. Errors: invalid Capsules, missing provenance, unavailable tokenizer or framing that cannot fit fail without a misleading partial success.
- **R2:** [inferred] Identical verified input and settings produce byte-identical output; selected text remains faithful and non-instructional. Errors: untrusted source commands cannot escape evidence framing, and fresh retrieval is not mislabeled deterministic reuse.
- **R3:** [paraphrase] Check and refresh distinguish current, stale, conflicting and unverifiable outputs with actionable reasons. Errors: source/policy drift or hand edits prevent silent overwrite; check does not write; publication rechecks relevant identity and authority.
- **R4:** [inferred] Preserve citations, required facet coverage reporting, output ownership and private-source boundaries across CLI/MCP/SDK/REST/Web UI. Errors: remote arbitrary paths, excluded sources, secret-bearing metadata and recursive generated-context ingestion are refused or explicitly fenced.
- **R5:** [paraphrase] Users can explicitly include the separate artifact in a supported harness using verified recipes without rewriting their existing instructions. Errors: unsupported inclusion mechanisms are documented; upgrades preserve custom edits and do not enable auto-refresh.
- **R6:** [inferred] Run fixed-budget paired task evals comparing the existing Capsule handoff with compiled output using the same reader model/instructions and source evidence. Require exact deterministic/citation/privacy guards and no held-out grounded-success or required-evidence regression; report tokens, omissions, stale detection and abstention. Errors: retain adverse results and withhold automatic integration if compilation is not useful.

**Documentation and delivery obligations.** [paraphrase] Complete the topic-specific documentation work listed in the surface matrix as part of this feature, across the two canonical documentation surfaces: repository Markdown rendered by Git hosting, and `gno.sh`. Update affected README capability/setup examples, changelog, user guides, CLI/MCP/API/configuration reference, architecture explanation, interface specs and structured-output schemas. Keep examples executable and distinguish defaults, opt-ins, unsupported cases and recovery behavior. Update the shipped GNO skill and relevant reference files, connector/harness instructions, and installed-skill verification. Do not create a third documentation site or update the retired in-repository website pages.

For `gno.sh`, update the matching docs/reference pages, relevant product/feature and install pages, FAQs and any affected comparison claims. Register new docs in navigation and prerender/sitemap routes. Verify the HTML and its generated Markdown twin, `/llms.txt`, `/llms-full.txt`, and alternate-format links agree; do not maintain divergent copies. Preserve local-only privacy promises and accurately state any new writes or background behavior. Keep internal eval fixtures, raw diagnostics and design notes out of public user documentation; public docs explain supported behavior and reproducible limits.

**Verification and delivery gates.** [inferred] Run focused regression and schema tests, then `bun run lint:check`, `bun test`, `bun run docs:verify` and documentation/public-truth checks appropriate to the changed scope. Run the topic-specific evals specified in the acceptance criteria; freeze models, fixtures, settings and thresholds before comparing arms, retain negative results, and never lower a threshold to pass. Where CLI/MCP behavior or shipped skill instructions change, run the GNO skill autoresearch eval, reconcile the shipped skill/reference sources and verify installation. Exercise changed CLI/MCP/REST/SDK behavior through actual invocations; drive changed Web UI flows with screenshots/responses, including keyboard and mobile behavior. A build or source inspection is not live QA.

For the hosted site run `bun run check`, `bun run typecheck`, `bun run build` and affected tests, then drive the changed pages locally, including navigation, copy buttons, Markdown twins and narrow width. Keep the GNO and hosted-site changes linked for coordinated delivery. When deployment is authorized, deploy from the canonical site repository and verify production HTTP response, service health, deployed revision, and the changed live pages. Do not claim production verification before deployment. Product publication follows the separately authorized release workflow. Record applicable gates and evidence in the spec completion record, including any blocked external delivery.

## Boundaries

<!-- scope: business -->

- [inferred] No automatic instruction-file replacement, autonomous memory extraction, unbounded summaries, background refresh default or new inference engine.
- [inferred] Native pre-compaction archival belongs to optional session automation. This spec does not require session imports, hooks or schedules.

## Decision Context

<!-- scope: both -->

- [inferred] Capsules already supply verified evidence and budgets; a deterministic export/ownership layer adds reusable context without a second retrieval system.
- [inferred] A separate artifact preserves user-authored instructions and makes drift inspectable. Harness inclusion is explicit, narrow and reversible.
- [inferred] Task-level evals determine whether this packaging actually improves reuse without losing necessary evidence.
