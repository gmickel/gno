# Opt-in collection link and path rules for gno audit

## Conversation Evidence

> user (turn 2): "Assume we'll build the pure wins (#313 multi-collection search, #314 gno convert, #316 audit link/path rules) ourselves"
> user (turn 2): "if a shape looks wrong for gno (API surface, config keys, limits like the 1024 bound, naming), redesign it and say why"
> user (turn 2): "leave out ... the ... derived_from convention, permission-boundary framing, the raised egress caps"
> user (turn 3): "Just say the spec supersedes the referenced PR(s) and uses them as reference for the intended outcome."

## Goal & Context
<!-- scope: business -->

<!-- Source: 10% user / 30% [paraphrase] / 60% [inferred] -->

This spec supersedes #316 and uses it as reference for the intended outcome. Its CHANGELOG entry credits @ArnauvGilotra for the idea and the original pull request.

`gno audit links` already reports broken, ambiguous, orphaned and out-of-index links per collection. Collections often have structural expectations that nothing checks today:

- A collection that gets published or shared should not link into collections that won't be, or its links break for readers.
- Some collections should hold no external URLs, such as offline reference sets or notes headed for publication.
- Some collections expect documents under a known layout, for example dated folders.

This spec adds three opt-in audit rules a collection can enable for these checks. The rules report findings and never block indexing, retrieval or editing.

## Architecture & Data Models
<!-- scope: technical -->

<!-- Source: 100% [inferred] -->

- The rules are configured per collection under one new optional `audit` object on the collection, so the collection schema gains one key rather than several.
- Rules run as part of the existing `links` audit category, over the same link snapshot and audited-document set. A rule is emitted only when an audited collection configures it, so reports, rule lists and fingerprints are unchanged without configuration.
- External URLs are found in a document's indexed text, outside frontmatter, code and comments. Both link syntax and bare URLs in prose count. `gno://` URIs are internal. A document whose indexed text is unavailable is reported as unchecked, never as passing.
- Path expectations use globs with the same syntax as the collection's `pattern`. They are not regular expressions.

## API Contracts
<!-- scope: technical -->

<!-- Source: 100% [inferred] -->

Collection config:

```yaml
collections:
  - name: published
    path: ~/notes/published
    audit:
      linkCollections: [reference]   # other collections this one may link to; its own is always allowed
      externalUrls: report           # report | ignore (default ignore)
      paths: ["20??/**/*.md"]        # each document path must match at least one glob
```

| Rule id | Fires when | Finding |
|---|---|---|
| `links.collection-policy` | `audit.linkCollections` is set | A link resolves into a collection not listed |
| `links.external-url` | `audit.externalUrls: report` | An external URL in indexed text, or `unchecked` when the text is unavailable |
| `links.path-layout` | `audit.paths` is set | A document path matches no glob |

- Findings have severity `warning` and carry location evidence (document, line, column, target or URL). Exit 4 on findings applies as today.
- The link audit rule version advances by one minor version. The config fingerprint covers the `audit` object only when it is present.
- Config validation: `linkCollections` members must be valid collection names, and an unknown name is a config error naming it. `paths` must be non-empty valid globs. `externalUrls` accepts only `report` or `ignore`.

## Edge Cases & Constraints
<!-- scope: technical -->

<!-- Source: 100% [inferred] -->

- A link whose target cannot be resolved is not a policy finding. The existing broken-link rules own it.
- A truncated link snapshot makes these rules `inconclusive`, as the existing rules do.
- `externalUrls` is unrelated to the collection's egress policy, and docs say so: egress governs where content may travel, while this rule only reports URLs written in documents.
- MCP `gno_audit` and any daemon findings run pick the rules up through the same config, with no new inputs.
- Docs: `spec/cli.md` (rule list), `docs/CONFIGURATION.md`, CHANGELOG and the hosted gno.sh configuration and audit docs ship with the change.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** With `audit.linkCollections` set, `gno audit links` reports each link from that collection that resolves into an unlisted collection as `links.collection-policy`, naming source, target collection and target. Links within the collection and to listed collections pass. [paraphrase] Errors: an unknown name in `linkCollections` → config validation error naming it.
- **R2:** With `audit.externalUrls: report`, each external URL in a document's indexed text, outside frontmatter, code and comments, is reported as `links.external-url` with line and column. `gno://` URIs never are. A document whose indexed text is unavailable is reported as unchecked. [paraphrase] Errors: any value other than `report` or `ignore` → config validation error.
- **R3:** With `audit.paths` set, each audited document whose collection-relative path matches none of the globs is reported as `links.path-layout`. [paraphrase] Errors: an empty list or invalid glob → config validation error.
- **R4:** With no `audit` object on any audited collection, audit output, rule lists, fingerprints and exit codes are byte-identical to the pre-change output on the same index. [paraphrase] Errors: none.
- **R5:** The rules report only. Indexing, retrieval, editing and link resolution behave identically whether or not the rules are configured or failing. [inferred] Errors: none.
- **R6:** `gno_audit` over MCP returns the same rule results as the CLI for the same scope. [inferred] Errors: none beyond the existing audit errors.

## Boundaries
<!-- scope: business -->

- No enforcement: nothing blocks a write, a link or a retrieval. [inferred]
- No new audit category and no new CLI or MCP inputs. [inferred]
- No access-control framing in docs. The rules are described as structure and publishing hygiene. [paraphrase]

## Decision Context
<!-- scope: both — conditionally substructured -->

The intended outcome follows #316: three opt-in, report-only rules under `gno audit links`. These shape changes from #316 are deliberate: [inferred]

- **One `audit` object instead of `linkPolicy` and `pathPattern` keys.** Grouping audit-only settings keeps the collection schema readable and gives future per-collection audit settings one home.
- **`externalUrls: report | ignore`, not `allow | deny`.** The rule reports and never denies. "deny" would imply enforcement and read like the collection's egress policy.
- **Globs, not a regular expression.** The collection's `pattern`, `include` and `exclude` are globs. A regex would be the only regex in collection config, and an unbounded user regex run over every path needs ReDoS limits.
- **Rule ids under `links.`** #316 used a `paths.` id inside the `links` category. Ids follow their category here. Adding a category would change the CLI and MCP audit contract for one rule.

## Strategy Alignment

- Trustworthy retrieval and evidence: inspectable, reproducible audit findings with fingerprints. [strategy:Trustworthy retrieval and evidence]
- Controlled portability: checks that help a collection stay publishable and self-contained before it is shared. [strategy:Controlled portability]
