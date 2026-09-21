# Typed metadata predicates across retrieval surfaces

## Goal & Context

<!-- scope: business; source: paraphrase -->

Allow precise retrieval over user-defined document metadata, such as approved decisions for one project or records above a numeric confidence threshold. Extend the existing tags, dates, categories, authors and scope filters without weakening their semantics or changing unfiltered retrieval.

## Architecture & Data Models

<!-- scope: technical; source: inferred -->

Add bounded typed metadata extraction, storage and a shared predicate validator/compiler. Support strings, finite numbers, booleans and homogeneous flat arrays of these scalars. Distinguish missing keys from present false/zero/empty values; null and nested arbitrary objects are unsupported in the initial typed namespace. Use an opt-in `gno.metadata` frontmatter namespace and a matching record-adapter metadata contract; existing ordinary frontmatter and fixed filters continue to behave as before.

Metadata extraction has its own version/backfill state. Parse changes need not re-embed unchanged text; actual source content changes retain existing embedding identity rules. Invalid opted-in metadata is diagnosed and excluded from typed-filtered retrieval until corrected, while ordinary search remains available. Documents without the namespace have an empty valid metadata map. Bound key counts, string/array lengths, nesting and total predicate size.

Predicate vocabulary: logical `and`, `or`, `not`; scalar `eq`, `ne`, `gt`, `gte`, `lt`, `lte`; set membership `in`, `nin`, `all`; and `exists`. Define one recursive discriminated contract before implementation. Comparisons are type-strict; numeric ordering never compares number-like strings. Ordered comparisons accept numbers only initially. Text equality is exact and case-sensitive; fixed author/tag behavior remains unchanged. No custom executable predicates, SQL fragments or regex evaluation.

Missing-field sketch, internal only:

```ts
function typedEquals(
  fields: Readonly<Record<string, string | number | boolean>>,
  key: string,
  expected: string | number | boolean
): boolean {
  return Object.hasOwn(fields, key) && fields[key] === expected;
}
```

Positive comparisons and `ne`/`nin` require presence; `exists` tests presence explicitly. Logical `not` negates the complete child predicate, so `not(eq(...))` can include a missing field; document this distinction with truth tables. Array equality is not implicit: membership operations state scalar/array behavior explicitly. `all` requires an array field and every distinct requested member; mixed-type, empty membership operands and empty logical groups are invalid. `in` accepts a scalar or array field and matches any member; `nin` requires presence and no member match. `eq`/`ne` accept scalar fields only.

## API Contracts

<!-- scope: technical; source: inferred -->

Introduce one `filter` predicate across supported search, vector, hybrid, structured, ask and context-building inputs, using CLI JSON input and typed SDK/MCP/REST schemas. Every backend intersects the predicate with caller authority, collection/path scope, exclusions and managed-memory visibility before candidate limits, fusion, reranking and packing. No selective post-filter approximation that silently loses eligible results. Explain/diagnose exposes bounded invalid/missing/backfill/filter reasons without leaking excluded metadata.

| Surface    | Required scope                                                                                                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI        | Shared `--filter` input on applicable retrieval commands, clear validation paths, help examples, backfill/invalid-metadata status and diagnostic parity.                                                                                     |
| MCP        | The same predicate schemas for relevant query/ask/context tools with bounded schema cost; scopes cannot be expanded by a filter.                                                                                                             |
| SDK / REST | Versioned typed inputs/results and reusable validation; invalid predicates are client errors with a stable field path, never silently ignored.                                                                                               |
| Web UI     | Accessible common field/operator/value controls plus an advanced nested-filter editor; active predicates survive navigation/shareable query state where current privacy policy allows. Show typed metadata and validation/backfill warnings. |
| Skills     | Teach fixed versus custom filters, exact types, missing-field semantics, and diagnose-before-relaxing a filter; add eval cases for cross-surface usage.                                                                                      |
| Git docs   | Update frontmatter/source-adapter/configuration, CLI/MCP/API/SDK/Web UI, output schemas and retrieval docs with truth tables, migration/backfill and limits.                                                                                 |
| gno.sh     | Mirror metadata guide/reference, searchable examples, UI help, capability/product claims and FAQs; verify generated Markdown/LLM pages.                                                                                                      |

## Edge Cases & Constraints

<!-- scope: technical; source: inferred -->

Canonicalize validated predicates for reproducible comparison/cache keys without changing logical meaning. Parameterize all storage access and defend reserved/property-prototype keys. Handle NaN/infinity, numeric extremes, Unicode keys, invalid YAML, alias expansion limits and malformed imported records. Invalid global filter syntax rejects the query; individual invalid documents are excluded and counted. Metadata output follows source eligibility and existing privacy controls.

Backfill must be resumable and report incomplete filtered coverage. Queries during backfill explicitly report coverage limitations instead of claiming an authoritative absence. A present but invalid namespace is distinct from missing metadata. Top-K filtered results must match an exhaustive eligible-set oracle on small fixtures; no index migration may silently rewrite source documents.

## Acceptance Criteria

<!-- scope: both -->

- **R1:** [paraphrase] Persist and retrieve bounded typed custom metadata without changing existing fixed filters or ordinary search. Errors: invalid namespace/type/size is diagnosed, excluded from custom-filtered queries and remains recoverable by correction/backfill.
- **R2:** [inferred] One validated predicate contract implements the stated type, missing-value, logical and membership semantics everywhere. Errors: incompatible types, invalid ordering, empty groups/operands, excessive depth and executable input fail before retrieval with a useful field path.
- **R3:** [paraphrase] Apply predicates together with authority/scope/exclusions before candidate limits in all applicable retrieval paths. Errors: highly selective queries, duplicate owners, memory visibility and metadata hydration failures cannot leak excluded hits or consume the eligible top-K window.
- **R4:** [inferred] Metadata versioning/backfill is resumable and source-preserving; unchanged text does not trigger unnecessary embedding. Errors: interruptions, stale schema and partially extracted corpora remain explicit in status and relevant query warnings.
- **R5:** [paraphrase] CLI, MCP, SDK, REST and Web UI expose equivalent predicates and useful validation; agent instructions explain how to use them. Errors: malformed UI/JSON values are never dropped, remote scope remains authoritative, and generated clients cannot widen access.
- **R6:** [inferred] Run exhaustive small-corpus predicate truth-table tests and paired filtered-retrieval evals with typed distractors and selective scopes. Require exact membership/top-K parity with the eligible-set oracle, zero scope leaks, and no unfiltered output regression on pinned fixtures. Errors: latent backfill gaps or degraded model execution cannot be scored as successful completeness.
- **R7:** [inferred] Benchmark selective versus unfiltered retrieval at pinned corpus sizes and report extraction/query memory and latency. Errors: prohibit unbounded scans/materialization introduced without measured justification; preserve correctness rather than hiding cost with incomplete post-filtering.

**Documentation and delivery obligations.** [paraphrase] Complete the topic-specific documentation work listed in the surface matrix as part of this feature, across the two canonical documentation surfaces: repository Markdown rendered by Git hosting, and `gno.sh`. Update affected README capability/setup examples, changelog, user guides, CLI/MCP/API/configuration reference, architecture explanation, interface specs and structured-output schemas. Keep examples executable and distinguish defaults, opt-ins, unsupported cases and recovery behavior. Update the shipped GNO skill and relevant reference files, connector/harness instructions, and installed-skill verification. Do not create a third documentation site or update the retired in-repository website pages.

For `gno.sh`, update the matching docs/reference pages, relevant product/feature and install pages, FAQs and any affected comparison claims. Register new docs in navigation and prerender/sitemap routes. Verify the HTML and its generated Markdown twin, `/llms.txt`, `/llms-full.txt`, and alternate-format links agree; do not maintain divergent copies. Preserve local-only privacy promises and accurately state any new writes or background behavior. Keep internal eval fixtures, raw diagnostics and design notes out of public user documentation; public docs explain supported behavior and reproducible limits.

**Verification and delivery gates.** [inferred] Run focused regression and schema tests, then `bun run lint:check`, `bun test`, `bun run docs:verify` and documentation/public-truth checks appropriate to the changed scope. Run the topic-specific evals specified in the acceptance criteria; freeze models, fixtures, settings and thresholds before comparing arms, retain negative results, and never lower a threshold to pass. Where CLI/MCP behavior or shipped skill instructions change, run the GNO skill autoresearch eval, reconcile the shipped skill/reference sources and verify installation. Exercise changed CLI/MCP/REST/SDK behavior through actual invocations; drive changed Web UI flows with screenshots/responses, including keyboard and mobile behavior. A build or source inspection is not live QA.

For the hosted site run `bun run check`, `bun run typecheck`, `bun run build` and affected tests, then drive the changed pages locally, including navigation, copy buttons, Markdown twins and narrow width. Keep the GNO and hosted-site changes linked for coordinated delivery. When deployment is authorized, deploy from the canonical site repository and verify production HTTP response, service health, deployed revision, and the changed live pages. Do not claim production verification before deployment. Product publication follows the separately authorized release workflow. Record applicable gates and evidence in the spec completion record, including any blocked external delivery.

## Boundaries

<!-- scope: business -->

- [inferred] No arbitrary query language, schema inference by an LLM, nested user object database, custom SQL/regex, source rewrites or new model/backend.
- [inferred] No replacement for authorization, egress policy, existing tags or managed-memory scope.

## Decision Context

<!-- scope: both -->

- [inferred] A namespaced bounded type system prevents accidental interpretation of every frontmatter key while preserving established metadata behavior.
- [inferred] Shared pre-limit eligibility keeps filtered queries complete under the same contract as ordinary scoped retrieval.
- [inferred] Explicit missing-field truth tables prevent inconsistent negative filtering across storage, agents and UI.
