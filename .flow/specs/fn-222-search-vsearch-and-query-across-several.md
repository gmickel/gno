# Search, vsearch and query across several collections

## Conversation Evidence

> user (turn 2): "Assume we'll build the pure wins (#313 multi-collection search, #314 gno convert, #316 audit link/path rules) ourselves"
> user (turn 2): "reference the original PR(s) and say it supersedes them"
> user (turn 2): "if a shape looks wrong for gno (API surface, config keys, limits like the 1024 bound, naming), redesign it and say why"
> user (turn 2): "stay inside gno's strategy and non-goals (STRATEGY.md, PRD §3.2, fn-99)"
> user (turn 3): "Just say the spec supersedes the referenced PR(s) and uses them as reference for the intended outcome."

## Goal & Context
<!-- scope: business -->

<!-- Source: 10% user / 30% [paraphrase] / 60% [inferred] -->

This spec supersedes #313 and uses it as reference for the intended outcome. Its CHANGELOG entry credits @ArnauvGilotra for the idea and the original pull request.

`gno search`, `gno vsearch` and `gno query` can be scoped to one collection or to all of them. Searching a subset (for example `work` and `notes` but not `archive`) takes one call per collection, followed by a manual merge. The other option is to search everything and drop unwanted hits afterwards, by which point other collections have already used up result slots, graph neighbours and rerank budget. This spec adds a collection allowlist to those three retrieval commands. The allowlist applies before any candidate limit, on every surface: CLI, MCP, REST and SDK.

## Architecture & Data Models
<!-- scope: technical -->

<!-- Source: 100% [inferred] -->

- Today a single collection filter is applied once, in the shared document-eligibility query that BM25 and vector candidate selection use before their limits. The allowlist extends that same eligibility input from one name to a set, so every leg is filtered by the same predicate.
- Paths that filter by collection outside the eligibility query must apply the same set. These are result hydration by mirror hash, the vector leg's in-memory document filter, and graph expansion, whose neighbour allowlist already accepts several collections. Reranking only sees fused candidates that passed eligibility.
- Model resolution: collections can override embed, expand and rerank models. When every listed collection resolves to the same model for a role, that model is used. Otherwise the request resolves models the way an unscoped request does today.
- One bound for the list, defined once: 256 collections, the same bound `gno audit` and `gno_impact` already use for collection scopes.

## API Contracts
<!-- scope: technical -->

<!-- Source: 100% [inferred] -->

**CLI.** `-c, --collection <name>` becomes repeatable on `search`, `vsearch` and `query`. One `-c` behaves exactly as today. Two or more form the allowlist.

```bash
gno search "deploy" -c work -c ops --json
```

**MCP** (`gno_search`, `gno_vsearch`, `gno_query`), **REST** (`POST /api/search`, `POST /api/query`) and **SDK** (`search`, `vsearch`, `query` options) each gain an optional `collections` array of collection names. The existing `collection` string is unchanged.

**Normalization.** Names are trimmed, lowercased and de-duplicated, then sorted. Order never changes results.

**Output.** When `collections` is given, `meta.collections` echoes the normalized list. `meta.collection` keeps its current meaning and is set only when the request used `collection` or a single `-c`.

```json
{ "meta": { "query": "deploy", "mode": "bm25", "collections": ["ops", "work"] } }
```

**Errors** (each uses the surface's existing validation envelope: CLI `VALIDATION` exit 1, MCP `invalid_input`, REST 400 `VALIDATION`):

| Input | Result |
|---|---|
| `collection` and `collections` both given | Validation error naming both fields |
| `collections` empty | Validation error |
| More than 256 names after normalization | Validation error stating the bound |
| One or more names not configured | The existing unknown-collection error, listing every unknown name |
| Non-string member | Validation error |

**HTTP MCP egress.** A call with `collections` is checked against exactly the listed collections, not against every configured collection. The most restrictive listed collection decides, as for any scoped call. The existing collection-limit denial still applies to large lists over HTTP.

## Edge Cases & Constraints
<!-- scope: technical -->

<!-- Source: 100% [inferred] -->

- With no `collections` input, every surface's requests and outputs are byte-identical to today. A test pins this for each surface.
- A collection that is configured but has no indexed documents is valid and contributes nothing.
- The allowlist never widens scope. Graph expansion cannot reach a collection outside it, and neither can hydration or rerank.
- Docs, specs (`spec/cli.md`, `spec/mcp.md`), the search-results output schema and its contract test, `docs/CLI.md`, `docs/MCP.md`, `docs/API.md`, `docs/SDK.md`, CHANGELOG and the hosted gno.sh docs ship with the change. Re-run the skill autoresearch eval, since search scoping is in its coverage.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** On CLI (repeatable `-c`), MCP, REST and SDK, `search`, `vsearch` and `query` accept a `collections` allowlist and return only documents from those collections. Errors: the table in API Contracts.
- **R2:** The allowlist applies before every candidate limit. A fixture where an excluded collection holds the top-scoring matches still returns the full requested number of hits from the listed collections, for BM25, vector and hybrid. This holds with graph expansion and rerank enabled. [paraphrase] Errors: no error surface beyond R1.
- **R3:** Graph expansion and hydration never surface a document outside the allowlist, including through a link from a listed collection into an unlisted one. [inferred] Errors: no error surface beyond R1.
- **R4:** Supplying both `collection` and `collections` is rejected with a validation error on every surface, and the request is never served as an intersection. [inferred] Errors: as stated.
- **R5:** The bound is 256 names, defined once and used by every surface. A list of 257 is rejected and 256 is accepted. [inferred] Errors: over-bound → validation error stating the bound.
- **R6:** Responses echo the normalized list in `meta.collections`. Without `collections`, outputs on all surfaces are byte-identical to the pre-change output for the same request. [inferred] Errors: no error surface beyond R1.
- **R7:** HTTP MCP egress for these three tools is evaluated against the listed collections. A remote caller listing only remote-allowed collections is served even when another configured collection is `local_only`, and a list containing a `local_only` collection is denied. [paraphrase] Errors: the existing redacted egress denial.
- **R8:** When listed collections resolve to different models for a role, the request uses the unscoped resolution for that role. When they all agree, it uses their shared model. [inferred] Errors: no error surface beyond R1.

## Boundaries
<!-- scope: business -->

- `ask`, `gno_ask`, the Web UI search page and Context Capsule scope (which already accepts `collections`) are not changed. [inferred]
- No change to egress bounds or policy semantics. [inferred]
- No collection exclusion (deny-list) syntax. [inferred]

## Decision Context
<!-- scope: both — conditionally substructured -->

The intended outcome follows #313: an allowlist enforced before the limit, on all four surfaces. These shape changes from #313 are deliberate: [inferred]

- **Bound 256, not 1024.** gno already uses 256 for audit and impact collection scopes, and 64/128 for egress and Context Capsule scopes. Nothing in gno needs 1024. One shared, already-used value keeps the bounds legible. Raising collection-count bounds for deployments with hundreds of collections is a separate question (fn-227, D5).
- **Reject `collection` with `collections`, don't intersect.** No gno surface intersects two collection inputs. Graph scoping lets the list win. An intersection silently returns nothing when the two disagree, so rejecting both is clearer and costs callers nothing.
- **Reject an empty list.** gno uses `[]` for "all" (audit) and for "deny all" (graph scoping) in different places. Rejecting it avoids picking either meaning by accident.
- **Echo shape.** #313 dropped `meta.collection` when the list was used. Keeping `meta.collection` unchanged and adding `meta.collections` means existing readers never see a changed meaning.
- **Model rule.** #313 does not address per-collection model overrides. The rule above never picks one listed collection's override for the others.

## Strategy Alignment

- Coherent agent and application surfaces: the same allowlist contract on CLI, MCP, REST and SDK. [strategy:Coherent agent and application surfaces]
- Trustworthy retrieval and evidence: filtering before limits keeps the result budget on the evidence the caller asked for. [strategy:Trustworthy retrieval and evidence]
