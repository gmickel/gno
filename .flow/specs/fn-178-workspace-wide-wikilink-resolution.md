# Workspace-wide wikilink resolution across collections sharing a vault root

## Conversation Evidence

> user (turn 1, part 1): "Spec topic: \"Resolve plain wikilinks across collections that share a vault root (Obsidian/workspace semantics)\", plus two small related bugs."
> user (turn 1, part 2): "Evidence gathered today (2026-09-23) on Gordon's Obsidian vault ([redacted path], 25 collections, each collection is a subfolder of the same vault, e.g. Spaces/AI -> `ai`, [redacted work folder] -> `[redacted]`)"
> user (turn 1, part 3): "`gno audit links` reported 2,535 unresolved + 98 ambiguous links. Resolving them with Obsidian semantics (vault-wide basename match, or path-suffix match for links containing '/'), ~1,590 were VALID links: (a) plain `[[Note]]` whose target lives in another collection of the same vault, (b) vault-root-relative path links like `[[Spaces/AI/Agents/_index]]` which GNO fails to match because it resolves paths relative to the collection root and then falls back to basename (producing false \"ambiguous\" findings, 85 of 98 ambiguous were this)."
> user (turn 1, part 4): "Docs confirm current behaviour: docs/ARCHITECTURE.md \"Resolution\" section (wiki links: normalized title match with path fallbacks within collection; cross-collection only via `[[collection:Note]]`), docs/GLOSSARY.md \"Cross-Collection Link\"."
> user (turn 1, part 5): "Consequence: graph neighbour expansion (on by default in query/ask/Context Capsules), backlinks, `gno impact`, orphan detection (`links.orphans`) and `links.local-targets` all miss or misreport exactly the links that tie Spaces together."
> user (turn 1, part 6): "Decision (Gordon): do NOT ask users to rewrite links into `[[collection:Note]]` (breaks Obsidian rendering/backlinks/rename handling and couples content to index topology that changes). Obsidian, Logseq, Foam, Dendron all resolve workspace-wide; collection-scoped resolution is a GNO artefact."
> user (turn 1, part 7): "R1. When multiple collections' paths sit under a common workspace/vault root (detect via shared ancestor containing `.obsidian/`, or an explicit config option e.g. `workspaceRoot` / collection group — pick and justify in the spec), resolve plain `[[Target]]` across all collections in that group using Obsidian rules: exact path-suffix match for targets containing '/', interpreted relative to the workspace root as well as the collection root; otherwise case-insensitive basename match; ambiguity tie-break like Obsidian (prefer same folder as source, then shortest path) and only report ambiguity when genuinely tied."
> user (turn 1, part 8): "R2. `[[collection:Note]]` stays as an explicit override. Collections outside any shared root keep current behaviour (backward compatible)."
> user (turn 1, part 9): "R3. Security/confidentiality: resolving an edge must NOT widen retrieval scope. Graph neighbour expansion in query/ask/Context Capsule/replay must only include neighbour documents that are within the caller's requested collection scope AND allowed by each collection's egress policy (e.g. local_only, remote). A [redacted work-collection]-scoped capsule must never pull in documents from another collection unless that collection is in scope. Backlinks/impact CLI output may list cross-collection sources only when those collections are in scope (define default scope)."
> user (turn 1, part 10): "R4. `gno audit links`: unresolved/ambiguous/orphans computed with the new resolver; add a finding kind or evidence field for cross-collection resolution; orphans should count inbound cross-collection links."
> user (turn 1, part 11): "R5. Incremental graph reconciliation (2.0.0 added incremental owner/referrer updates) must handle cross-collection referrers (a rename in collection A updates referrers in B)."
> user (turn 1, part 12): "R6. Bug: `gno <cmd> --json` output is truncated when stdout is a pipe (observed cut at exactly 8192 bytes for `gno audit links --json | python3 ...`, and at 159,741 bytes for full `gno audit --json`); `--output <file>` works. Likely process exit before stdout drain in Bun. Acceptance: piping multi-MB JSON yields complete, parseable output."
> user (turn 1, part 13): "R7. Minor: `gno audit --max-findings` hard-caps at 1000 (\"maxFindings must be an integer between 1 and 1000\"); consider allowing larger caps or pagination/cursor so complete finding lists can be exported."
> user (turn 1, part 14): "Acceptance should include a fixture vault with two collections under one Obsidian root, cross-collection links, vault-root path links, same-basename ambiguity, and an egress/scope test proving no scope widening."

## Goal & Context

<!-- scope: business; source: 60% [user], 40% [paraphrase] -->

Users who index one Obsidian vault as several GNO collections (one collection per Space or project folder) lose most of the links that connect those collections. A plain `[[Note]]` whose target sits in a sibling collection, and a vault-root path link such as `[[Spaces/AI/Agents/_index]]`, either fail to resolve or resolve as falsely ambiguous. On a real 25-collection vault, `gno audit links` reported 2,535 unresolved and 98 ambiguous links; about 1,590 of those were valid under Obsidian semantics, and 85 of the 98 ambiguous findings were vault-root path links. Graph neighbour expansion (on by default in query, ask and Context Capsules), backlinks, `gno impact`, orphan detection and local-target auditing all miss or misreport exactly the links that tie the vault together.

Obsidian, Logseq, Foam and Dendron all resolve links workspace-wide. Collection-scoped resolution is a GNO artefact, and the fix belongs in GNO: users must not be asked to rewrite links into `[[collection:Note]]`, which breaks Obsidian rendering, backlinks and rename handling, and couples content to an index topology that changes over time.

Resolving an edge is not permission to retrieve its target. Confidential collections (for example a work-client collection next to personal collections in the same vault) must stay inside the caller's requested scope and their egress policy, even when a link now points across the boundary.

The same capture carries two small defects found during this investigation: `--json` output truncates when stdout is a pipe, and `gno audit --max-findings` cannot export a complete finding list.

## Architecture & Data Models

<!-- scope: technical; source: 40% [paraphrase], 60% [inferred] -->

**Link workspace.** A link workspace is a set of collections whose roots share one workspace root. Membership is derived, not stored in content. [inferred] Default detection: for each collection, the workspace root is the nearest ancestor-or-self of the collection's real path that contains a `.obsidian/` directory; collections with the same workspace root form one workspace. An explicit per-collection configuration value overrides detection: an absolute workspace root path (for non-Obsidian trees such as Logseq/Foam/Dendron or a vault without `.obsidian/`), or an explicit opt-out that keeps the collection on today's collection-scoped behaviour. A collection with no detected or configured root is a workspace of one and behaves exactly as today. [paraphrase]

Justification for this choice [inferred]: `.obsidian/` is how Obsidian itself defines a vault, so the dominant case works with zero configuration and tracks folder moves without config edits; the explicit value covers other tools and lets an owner deliberately isolate a collection. A named group-only option was rejected because it duplicates what the filesystem already states and can drift from it.

**One resolver contract.** Every link consumer uses the same resolution: seed-scoped graph neighbours, full graph export, backlinks, `gno links`, `gno impact` traversal, audit link snapshots, frontmatter relation targets, and incremental graph reconciliation. [inferred] Resolution stays query-time over stored link rows, as today; stored link rows keep their normalized target reference and optional explicit collection prefix.

**Resolution order for a plain wiki target inside a workspace** [paraphrase, ordering details inferred]:

1. Explicit `[[collection:Target]]` resolves only inside the named collection (unchanged override).
2. Target containing `/`: exact match of the target (with or without `.md`) against each candidate's path relative to the workspace root, and against the path relative to the source's own collection root; then a path-suffix match on `/` boundaries across the workspace.
3. Target without `/`: case-insensitive file basename match (with or without `.md`) across all collections in the workspace.
4. Tie-break among equal-strength matches: same folder as the source document first, then shortest workspace-relative path. Ambiguity is reported only when candidates remain tied after the tie-break.
5. Fallback when no filename or path match exists: today's normalized frontmatter-title match, restricted to the source's own collection. [inferred]

Workspace-relative path is the collection's path under the workspace root joined with the document's collection-relative path; it is derivable from configuration and stored document paths, so no schema change is required for resolution itself. [inferred]

**Scope filter after resolution.** Resolution yields an edge; a separate, mandatory filter decides whether the edge's other endpoint may be surfaced to the caller. [paraphrase] The filter applies the caller's requested collection scope and each endpoint collection's egress policy with the same eligibility and egress checks already applied to primary retrieval candidates.

## API Contracts

<!-- scope: technical; source: 30% [paraphrase], 70% [inferred] -->

- **Configuration** [inferred]: a per-collection optional workspace setting accepting an absolute path or an explicit opt-out value; absent means auto-detect. Collection status/list output reports each collection's effective workspace root and whether it was detected or configured.
- **Audit findings** [paraphrase]: link findings gain a resolution-scope evidence field with values `same-collection`, `cross-collection` (plain link resolved in a sibling collection of the workspace) and `explicit-collection` (`[[collection:Note]]`); ambiguous findings list the tied candidates. Orphan evaluation counts inbound links from any collection in the workspace. [inferred]
- **`--max-findings`** [inferred]: accepts `all` in addition to a positive integer; `all` returns every finding for each rule. The numeric ceiling is raised to at least 100,000. Per-rule totals and a truncation flag stay in the report so a capped export is never mistaken for a complete one. The per-rule finding caps used by individual audit families follow the same limit.
- **Graph-facing outputs** [inferred]: backlinks, graph neighbours, `gno links`, `gno impact` and graph export entries for cross-collection edges carry the endpoint's collection and URI so callers can see where a neighbour came from.
- **CLI output** [paraphrase]: any command's stdout, including `--json`, is fully written before the process exits, whether stdout is a TTY, file or pipe. No flag is required.

## Edge Cases & Constraints

<!-- scope: technical; source: 30% [paraphrase], 70% [inferred] -->

- **Default scope** [inferred]: when a command or API call names no collection, its scope is all collections in the index (today's unscoped behaviour); when it names a collection, cross-collection endpoints outside that collection are excluded from the result even though the edge resolves. Egress-policy checks for remote destinations (for example `ask` with a remote model, MCP/REST responses) apply per neighbour document exactly as they would for a directly retrieved document; a denied neighbour is dropped and counted in graph retrieval diagnostics, never silently substituted.
- **Context Capsules and replay** [paraphrase]: capsule and replay graph expansion honour the capsule's declared collection scope. Neighbour-set changes that come from the resolver upgrade surface through existing replay drift reporting; they are expected drift, not a replay failure. [inferred]
- **Nested vaults** [inferred]: the nearest `.obsidian/` ancestor wins, so a nested vault forms its own workspace.
- **Symlinked collection roots** [inferred]: detection and workspace-relative paths use real paths; a collection whose real path leaves the workspace root is not a member.
- **Workspace membership changes** [inferred]: adding, removing or re-rooting a collection, or changing its workspace setting, reconciles graph references for every collection in the affected workspace(s) before the next graph read reports success.
- **Duplicate mirrors** [inferred]: mirrored duplicate rows keep today's exclusion from orphan claims; the same document content in two collections does not create a false ambiguity when both rows are the same source.
- **Case sensitivity** [paraphrase]: basename matching is case-insensitive; the existing ASCII-only caveat of SQL `lower()` stays documented.
- **Performance** [inferred]: resolution stays set-oriented and batched (no per-link query), keyed by workspace instead of collection; audit and graph expansion on a 25-collection, ~50k-link workspace stay within today's snapshot bounds and time budget.
- **Confidentiality of evidence** [inferred]: test fixtures are synthetic; no content from any real vault enters the repository, tests or docs.

## Acceptance Criteria

<!-- scope: both -->

- **R1:** [paraphrase] Collections whose roots share a workspace root (detected by the nearest `.obsidian/` ancestor, or set by the explicit per-collection workspace setting) form one link workspace, and a plain `[[Target]]` in any member resolves across all members. Errors: a configured workspace path that is not absolute, does not exist, or does not contain the collection root is a configuration validation error naming the collection; an explicit opt-out keeps the collection collection-scoped; a collection with no root behaves exactly as today.
- **R2:** [paraphrase] Targets containing '/' resolve by exact path-suffix match, interpreted relative to the workspace root as well as the collection root; otherwise by case-insensitive basename match. On the fixture vault, `[[Spaces/AI/Agents/_index]]`-style vault-root links from another collection resolve to the single correct document and produce no ambiguous finding. Errors: a path target with no match is reported unresolved; `..` segments never escape the workspace root.
- **R3:** [paraphrase] Ambiguity tie-break prefers the same folder as the source, then the shortest path; ambiguity is reported only when candidates are genuinely tied after the tie-break, and the finding lists the tied candidates. No error surface beyond R2.
- **R4:** [paraphrase] `[[collection:Note]]` stays an explicit override and resolves only inside the named collection; collections outside any shared root keep current behaviour, proven by the existing link, graph and audit test suites passing unchanged for non-workspace fixtures. Errors: an unknown collection prefix stays unresolved as today.
- **R5:** [paraphrase] Resolving an edge never widens retrieval scope: graph neighbour expansion in query, ask, Context Capsule build and replay includes a neighbour only when its collection is inside the caller's requested collection scope and its egress policy allows the destination. A fixture test with a `local_only` collection and a `remote` collection in one workspace proves that (a) a query or capsule scoped to one collection returns no neighbour from the other, and (b) a remote-destination ask with unscoped retrieval excludes `local_only` neighbours. Errors: an egress-denied neighbour is dropped and counted in graph diagnostics, never returned.
- **R6:** [paraphrase] Backlinks, `gno links`, `gno impact` and graph export list cross-collection sources or targets only when those collections are in the request's scope; the default scope with no collection named is all indexed collections, and each cross-collection entry names its collection. No error surface beyond R5.
- **R7:** [paraphrase] `gno audit links` computes unresolved, ambiguous and orphan findings with the workspace resolver; each link finding carries a resolution-scope evidence field (`same-collection` / `cross-collection` / `explicit-collection`); orphan evaluation counts inbound links from other collections in the workspace. On the fixture, links that resolve across collections are not reported unresolved, and a document linked only from a sibling collection is not an orphan. No error surface beyond the existing audit errors.
- **R8:** [paraphrase] Incremental graph reconciliation handles cross-collection referrers: renaming, moving, adding or deleting a document in collection A updates the resolved edges of referrers in collection B, and the incremental result matches a full graph projection for the fixture (global parity). Errors: when a workspace membership change cannot be reconciled incrementally, reconciliation falls back to the full projection and reports it, never leaving stale edges.
- **R9:** [paraphrase] Piping any command's JSON output yields complete, parseable output: a subprocess test pipes a multi-megabyte `--json` payload (e.g. `gno audit --json` on a large fixture) into a reader and parses it successfully, and byte length equals the `--output <file>` rendering. Errors: a broken pipe (reader closes early) exits without a stack trace and without hanging.
- **R10:** [paraphrase] `gno audit --max-findings` accepts `all` and numeric values above 1000 (ceiling at least 100,000), so a complete finding list can be exported; per-rule totals and truncation flags remain accurate. Errors: zero, negative, non-integer or non-`all` values are rejected with a validation message that states the accepted range.
- **R11:** [paraphrase] A synthetic fixture vault with two collections under one `.obsidian/` root covers cross-collection plain links, vault-root path links, a same-basename ambiguity resolved by the same-folder tie-break, a genuinely tied ambiguity, and the egress/scope cases of R5; it lives only in the test tree. No error surface beyond R1-R8.
- **R12:** [inferred] User-facing docs describe workspace resolution, the workspace setting, the resolution order and scope rules (ARCHITECTURE "Resolution", GLOSSARY "Cross-Collection Link" plus a workspace entry, CONFIGURATION, CLI audit options), replacing the statement that cross-collection linking requires `[[collection:Note]]`. No error surface.

Process: repo checks green, docs-verify passes, and the shipped skill (`assets/skill/`) is re-evaluated per the repo's skill/MCP optimization procedure if CLI/MCP behaviour descriptions change.

## Boundaries

<!-- scope: business; source: 40% [user], 60% [inferred] -->

- Rewriting user content into `[[collection:Note]]`, or recommending that users do so. [paraphrase]
- Resolving relative markdown links (`[x](../../Other/Note.md)`) that escape a collection root; they stay unresolved as today. Candidate follow-up. [inferred]
- Web UI wiki-link autocomplete and graph-view UI changes beyond consuming the shared resolver's output. [inferred]
- Cursor/pagination for audit findings; `all` plus a higher ceiling covers complete export. [inferred]
- Any change to egress policy semantics or defaults; this spec only applies existing policy to graph neighbours. [inferred]
- Obsidian aliases (`aliases:` frontmatter) and block/heading reference resolution. [inferred]

## Decision Context

<!-- scope: both; source: 50% [user], 50% [inferred] -->

Workspace-wide resolution over explicit prefixes: Gordon decided users must not rewrite links into `[[collection:Note]]` because it breaks Obsidian rendering, backlinks and rename handling and couples content to index topology that changes; every mainstream linked-notes tool resolves workspace-wide. [paraphrase]

Detection by `.obsidian/` ancestor with an explicit override (rather than config-only grouping): zero configuration for the dominant case, no drift between config and folder layout, and an explicit escape hatch for other tools or deliberate isolation. Confirmed (D1).

Separating resolution from scope: making an edge resolvable and deciding whether its endpoint may be returned are two different questions. Keeping the scope and egress filter mandatory and downstream of resolution means a more permissive resolver cannot leak confidential collections into a scoped query, capsule or remote answer. [paraphrase]

Filename-first ordering inside a workspace (title match only as same-collection fallback): matches Obsidian and avoids a frontmatter title in one collection capturing links meant for a file in another. [inferred]

`--max-findings all` instead of a cursor: simplest way to export complete lists; findings are already bounded by the audit snapshot limits. [inferred]

A split into three specs (workspace resolution; pipe truncation; audit finding cap) was considered because the two bugs ship independently. They stay in this spec as requested; the pipe fix can still land as its own early PR. [inferred]

## Resolved via Codebase

<!-- scope: technical; snapshot of v2.4.0 (commit 79e26e44), 2026-09-23; paths are evidence of current behaviour, not contracts -->

- Wiki target resolution is collection-keyed in both the SQL resolver and the bulk resolver (`src/store/sqlite/graph-link-resolver.ts` joins `d.collection = t.collection`; `src/store/sqlite/graph-link-bulk-resolver.ts` keys lookups by `collection\0value`). Title match ranks above path match; ties break by lowest document id, and `matchCount > 1` becomes an ambiguous finding.
- Seed-scoped neighbour expansion (`src/store/sqlite/graph-neighbors.ts`, called from `src/pipeline/graph-retrieval.ts` via `src/pipeline/hybrid.ts`) takes a single optional `collection`; incoming candidate links are gathered per seed collection.
- Backlinks (`getBacklinksForDoc` in `src/store/sqlite/adapter.ts`) treat a NULL `target_collection` as the source's own collection.
- Incremental reconciliation (`src/ingestion/graph-reconciliation.ts` relation resolver; `incomingLinkSources` in `src/store/sqlite/graph-reference-state.ts`) keys paths and local wiki names by collection; the incoming-referrer query already has one unqualified exact-name clause that can cross collections, but no path-suffix or workspace handling.
- Link parsing (`src/core/links.ts`) lowercases `collection:` prefixes and rejects markdown paths that escape the collection root; markdown cross-collection links are unsupported.
- Audit link rules live in `src/core/audit-links.ts` (`links.local-targets`, `links.ambiguous-targets`, `links.orphans`) over `captureAuditLinkSnapshot` (50,000 document/link bounds). `AUDIT_MAX_FINDINGS_LIMIT = 1000` in `src/core/audit-contract.ts`, validated in `src/core/audit.ts`; per-family caps of 1000 in `audit-links.ts`, `audit-freshness.ts`, `audit-provenance.ts`.
- Pipe truncation: `src/index.ts` calls `process.exit(code)` after `runCli` resolves, while commands write large payloads with `process.stdout.write` (e.g. the audit action in `src/cli/program.ts`); no drain is awaited, consistent with truncation at the 8 KiB pipe buffer.
- Egress policy is per collection (`local_only` default, `lan`, `remote`) in `src/config/types.ts`, enforced through `src/core/egress-enforcement.ts`.
- Prior related specs: fn-2 (Obsidian-compatible wiki link resolution), fn-150 (incremental graph reconciliation with global parity), fn-111 (collection egress policies), fn-79 (graph-aware retrieval), fn-86 (read-only knowledge integrity audits).

## Decisions (Gordon, 2026-09-23)

- **D1 Detection: confirmed.** Nearest `.obsidian/` ancestor, with the per-collection override (absolute root or opt-out).
- **D2 Match order: confirmed.** Path/filename first across the workspace; frontmatter-title match only as a fallback inside the source collection. Obsidian itself never resolves by title.
- **D3 Audit cap: confirmed.** `--max-findings all` plus a numeric ceiling of at least 100,000; no cursor.
- **D4 Out of scope: confirmed** as listed.
- **D5 Upgrade default: ON by default** for existing indexes, not a one-release opt-in. Reasons: the mandatory scope and egress filter (R5-R6) means resolution alone never returns a document outside the caller's collection scope or egress policy, so a user who split one vault into isolated collections keeps isolated retrieval; the only visible change for scoped calls is correct graph and audit results. Opt-in would leave the primary use case (Obsidian vaults split into collections) broken by default. Guard rails that ship with it: `gno status` / `collection list` show each collection's effective workspace root and whether it was detected or configured; the per-collection opt-out restores today's behaviour; the first sync after upgrade runs a full graph reconciliation; the changelog carries an explicit upgrade note.
- **D6 Delivery order:** one spec, but R9 (piped JSON truncation) and R10 (audit cap) land first as an independent early task and PR; resolution work follows.

## Parked unknowns

- None blocking. External review by GPT-6 Astra scheduled before implementation.
