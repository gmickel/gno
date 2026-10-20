# Decide how GNO handles multi-user gateway scope

## Conversation Evidence

> user (turn 3): "Add one umbrella or collection spec for everything the other specs don't cover"
> user (turn 3): "the B stack (#317 principals and asserted subject, #319 collection access, #320 subject-owned memory, #321 access hook, #322 MCP mutex change)"
> user (turn 3): "the derived_from provenance convention"
> user (turn 3): "the raised egress caps"
> user (turn 3): "the questions in issue #312 (especially Q1, whether this belongs in gno or in a wrapper or fork)"
> user (turn 3): "Its job is to work out how gno should handle this remaining scope, as options and decisions rather than a design to build, and it should reference those PRs and #312."
> user (turn 3): "Keep every spec neutral and public-safe."
> user (turn 2): "stay inside gno's strategy and non-goals (STRATEGY.md, PRD §3.2, fn-99)"

## Goal & Context
<!-- scope: business -->

<!-- Source: 30% user / 40% [paraphrase] / 30% [inferred] -->

Issue #312 proposes opt-in permissioned serving for multi-user gateway deployments: one shared index behind a shared assistant, where each person may retrieve only the notes they are allowed to read. Five pull requests implement the core of it, and two others carry pieces of it:

| PR | Topic |
|---|---|
| #317 | Named gateway principals and an asserted subject (`GNO-Subject`, `GNO-Context`) |
| #319 | Per-collection `access` rules and a `scoped` tool profile |
| #320 | Subject-owned memory with `refs` |
| #321 | A fail-closed external access hook |
| #322 | Releasing the MCP tool mutex while waiting on access-hook answers |
| #315 (part) | The `derived_from` provenance convention |
| #318 (part) | Raising the egress decision and lineage caps to 1024 collections |

This spec supersedes #317, #319, #320, #321 and #322, and the parts of #315 and #318 listed above. It uses them and #312 as reference for the intended outcome. Its deliverable is a set of recorded decisions on how GNO handles this scope, starting with whether multi-user authorization belongs inside GNO at all. It is not a design to build. [paraphrase] Any CHANGELOG entry for work that comes out of these decisions credits @ArnauvGilotra for the idea and the original pull requests.

The generic pieces of those PRs are covered by sibling specs: several-collection retrieval (fn-222), `gno convert` (fn-223), `gno ls --filter` (fn-224), opt-in link and path audit rules (fn-225), and the deterministic egress collection-limit denial (fn-226). Those specs ship on their own merits whichever way this spec decides. [inferred]

## Architecture & Data Models
<!-- scope: technical -->

What GNO has today that these decisions build on or change: [inferred]

- **Resident gateway:** one resident core per data directory, served over loopback by default. HTTP MCP accepts one bearer token. The resident gateway spec (fn-99) excludes "team tenancy", "trusted proxy mode" and "multi-user authorization" in its Boundaries.
- **Collections:** the unit of configuration, egress policy and retrieval scope. Egress policy decides per collection (`local_only` and wider levels), with a 64-collection decision bound and a 128-source lineage bound.
- **Provenance:** one shipped provenance model, structured `source:` frontmatter (kind, uri, externalId, observedAt and related fields), established by fn-82. Its R5 rules out two competing provenance systems.
- **Typed metadata:** `gno.metadata` with typed predicates, enforced before the result limit.
- **Memory:** `remember`/`recall` with caller-chosen scopes, supersession by hash, and a bounded recall budget.
- **MCP execution:** tool calls run one at a time behind one process-wide mutex.

## Edge Cases & Constraints
<!-- scope: technical -->

Constraints any option must respect or explicitly change: [inferred]

- **Strategy:** STRATEGY.md's primary audience is "Privacy- and evidence-conscious builders and knowledge workers". The Controlled portability track says local-first should enable deliberate sharing "without turning into opaque sync or accidental data movement". No current track covers a shared multi-user index.
- **Non-goals:** PRD §3.2 lists "Multi-user collaborative indices" as an MVP non-goal. The fn-99 Boundaries rule out multi-user authorization and trusted proxy mode. An in-GNO option reverses both and must update them in the same change that adopts it.
- **Leak surface:** an in-GNO authorization layer has to hold before the result limit and across BM25, vector, fusion, graph expansion and link resolution, rerank, `get`/`multi_get`, Context Capsules and their fingerprints, `supersededBy` chains, `egressLineage`, coverage warnings, status endpoints and stale-collection errors. #319 and #321 had to touch every one of those to avoid leaks, and that list is the main cost signal for the in-GNO option.
- **Cross-surface parity:** STRATEGY.md measures parity across CLI, Web UI, REST, SDK, MCP and daemon. #312 scopes access to HTTP MCP principals only (its Q6), which breaks that parity unless the decision accepts it explicitly.
- **Default behaviour:** whatever is chosen, single-user installs keep today's behaviour and wire output when no new key is set.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** A decision on #312 Q1 is recorded: multi-user authorization lives inside GNO as an opt-in capability, outside GNO (a wrapper or proxy over generic GNO primitives), in a fork, or behind a narrower generic seam in GNO (see Decision Context). The record gives the chosen option, the rationale, and its consequence for STRATEGY.md, PRD §3.2 and the fn-99 Boundaries. [paraphrase] Errors: a decision that puts authorization inside GNO without naming the strategy and non-goal edits it requires is incomplete.
- **R2:** For the chosen option, the GNO-side capabilities it needs are listed. Each one is marked as already shipped, covered by a sibling spec, or needing a new spec, and each needed spec is captured. [inferred] Errors: no error surface beyond an unlisted dependency, which fails this criterion.
- **R3:** Each open decision in Decision Context (identity, authorization model, derived-note provenance, collection-count bounds, per-subject memory, hook-wait concurrency, surface coverage, receipt retention) is either decided with a one-paragraph rationale or recorded as moot under the R1 choice. [inferred] Errors: no error surface beyond an undecided item, which fails this criterion.
- **R4:** Each question in #312 (Q1 to Q9) has a recorded answer, or is marked moot with the reason. [paraphrase] Errors: no error surface beyond a missing answer.
- **R5:** Each referenced PR (#317, #319, #320, #321, #322, and the #315 and #318 parts) has a recorded disposition: superseded by a named spec, declined, or deferred, with the deciding criterion. [inferred] Errors: no error surface beyond a missing disposition.

## Boundaries
<!-- scope: business -->

- No implementation design and no code in this spec. Anything the decisions call for gets its own spec. [inferred]
- The generic pieces already split into sibling specs (several-collection retrieval, `gno convert`, `gno ls --filter`, link and path audit rules, egress collection-limit denial) are not reopened here, except where a decision here needs a property they do not provide. [inferred]
- Vendor-specific identity, permission or document-store logic stays out of GNO under every option. #312 states the same aim. [paraphrase]

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

A multi-user deployment wants one shared index where each person retrieves only what they may read, with filtering applied inside retrieval rather than after the limit. #312 states the need and asks first whether GNO wants it inside the product. That answer determines whether most of the decisions below need answers at all. [paraphrase]

### Implementation Tradeoffs
<!-- scope: technical -->

Options per decision. These are inputs to the decision, not recommendations to build. [inferred]

**D1. Where multi-user authorization lives (#312 Q1)**

- **(a) Inside GNO, opt-in.** This is #312's proposal: named principals, asserted subject, collection access rules, an access hook and subject-owned memory. Filtering happens before the limit and inside graph, rerank and capsules. Cost: it reverses two non-goals, adds a security boundary GNO must defend on every retrieval path (see the leak surface in Edge Cases), and serves an audience STRATEGY.md does not name.
- **(b) Outside GNO, over generic primitives.** A proxy holds identity and per-user permissions and calls GNO with an explicit collection allowlist (sibling spec) and typed metadata filters. The proxy owns `get` checks and post-filters what generic primitives cannot express. Cost: graph expansion, `supersededBy`, lineage and capsule fingerprints can still reveal documents outside the caller's scope unless GNO offers a scope that governs them.
- **(c) A fork** maintained by the deployment. GNO carries nothing. Cost: the fork has to keep up with GNO's release pace.
- **(d) A narrower generic seam in GNO.** GNO enforces a caller-supplied or per-token collection scope consistently on every read path (retrieval, graph, links, supersession, lineage, capsules, status), with no notion of users, subjects, conversations or hooks. The deployment maps users to scopes outside GNO. Cost: it still extends fn-99's single-token model, but stays inside "Coherent agent and application surfaces" and creates no identity model.

**D2. Identity model (only if D1 is a or d).** Options: per-token scopes only; named principals; a trusted asserted subject (`GNO-Subject`), which is the trusted proxy mode fn-99 excludes. #317's `GNO-Context: 1to1|shared|public_only` encodes one assistant's conversation types into GNO's wire protocol. A neutral design would express conversation scope as data the caller resolves, not as an enum GNO interprets.

**D3. Authorization model (only if D1 is a).** Options: static per-collection rules (`public`, `owner`, external reference with a firm-wide flag); an external decision service called per request and fail-closed; or both. Decide whether a per-request network call on the retrieval path is acceptable under "every network boundary must be explicit", what latency budget it gets, and whether denial must be indistinguishable from absence (`NOT_FOUND` parity).

**D4. Provenance for derived notes (the #315 convention).** #315 documents `gno.metadata.derived_from` as a list of `<system>:<reference>` strings, and #319 and #321 make it mandatory in access mode. Options: extend the shipped `source:` provenance to hold several sources, keeping one provenance model as fn-82 R5 requires; bless a typed-metadata convention as a second model, which conflicts with fn-82 R5; or bless nothing and let deployments use typed metadata, which `ls --filter` (sibling spec) already supports without GNO naming a convention. "Rebuild every note derived from a changed source" is a generic second-brain need whichever option wins.

**D5. Collection-count bounds (the #318 caps).** Egress decisions are bounded at 64 collections and lineage at 128. #318 raises every bound to 1024 for "one collection per access boundary" deployments. Options: keep the current bounds (the sibling spec makes exceeding them a clean policy denial); raise them with measured latency, receipt-size and lineage-size evidence; or tie them to the multi-collection retrieval bound. A raise needs its own evidence, because the bounds limit persisted receipt and lineage size.

**D6. Per-subject memory (#320).** Options: subject-owned owner scopes set by the server; caller-chosen scopes only (today), with isolation handled by a proxy; or none. Also decide whether `refs` on remembered facts is a generic provenance need. If it is, it relates to D4.

**D7. Waiting without holding the tool mutex (#322).** This is only needed when a tool call waits on an external answer. Decide whether a generic "yield the tool mutex during an external wait" primitive has value beyond an access hook (for example remote model backends), or whether it follows D3.

**D8. Surface coverage (#312 Q6).** If any authorization or scope lives in GNO, decide whether REST, SDK and the Web UI enforce it too, or whether HTTP MCP alone is acceptable given the parity metric.

**D9. Receipt retention (#312 Q7).** Decide whether request-id write receipts keep remembered text for 30 days under per-subject scopes, or whether subject mode must not persist it.

## Strategy Alignment

- Coherent agent and application surfaces: D1(d) and D8 are framed against this track's one-index, one-contract aim. [strategy:Coherent agent and application surfaces]
- Controlled portability: D1, D3 and D5 are judged against "deliberate sharing without turning into opaque sync or accidental data movement". [strategy:Controlled portability]

## Strategy Conflicts

- D1(a) serves a shared multi-user audience that STRATEGY.md's "Who it's for" does not name, and it reverses PRD §3.2 and the fn-99 Boundaries. Choosing it requires a strategy update. This spec records the conflict and does not resolve it. [inferred]

## Parked unknowns

- The latency and index-size profile of a few hundred collections in one index beyond what #313 and #318 measured. A benchmark on a synthetic corpus would settle it if D1 or D5 needs it. [inferred]
