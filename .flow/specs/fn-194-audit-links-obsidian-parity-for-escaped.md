# Audit links: Obsidian parity for escaped table aliases, attachments and targets outside the index

## Goal & Context
<!-- scope: business; source: user -->

Workspace link resolution (fn-178, shipped in 2.8.0) makes cross-collection wiki links resolve, so `gno audit links` could replace external link checkers for an Obsidian vault. On a real vault of about 2,000 indexed notes in 24 collections under one `.obsidian` root, an Obsidian-semantics checker finds 2 genuine problems (1 dangling link, 1 ambiguous basename). `gno audit --max-findings all` reports 526 `links.local-targets` findings on the same vault, so the audit is not yet usable as a link authority and every real problem is buried. [user]

Classifying the 526 findings against the vault's files (paraphrased):

- About 305: the target is an existing Markdown note in the same vault, outside every indexed collection or excluded by a collection pattern (an excluded `_internal/` folder, unindexed top-level folders, archive folders). Obsidian resolves these; GNO reports them as unresolved. [paraphrase]
- About 177: the target is an existing non-Markdown file in the vault (pasted images, PDFs in attachment folders), usually an embed `![[image.png]]` or a wiki link to an attachment. [paraphrase]
- 96: a wiki link inside a Markdown table written with Obsidian's escaped alias separator, `[[Target\|Alias]]`. `WIKI_LINK_REGEX` in `src/core/links.ts` captures the target as `Target\`, which never resolves. Obsidian treats `\|` inside a wiki link as the alias separator. [paraphrase]
- About 29: genuinely missing targets, plus Markdown links whose text contains nested brackets (for example `[title [x] (site](url)`) that the parser splits into a bogus target, and deliberate fixtures in test files. [paraphrase]

## Acceptance Criteria
<!-- scope: both -->

- **R1:** [paraphrase] `[[Target\|Alias]]` parses as target `Target` with alias `Alias` in every surface that reads wiki links (link graph, backlinks, `gno links`, impact, graph neighbours, audit), matching Obsidian. A plain `[[Target|Alias]]` is unchanged. Errors: none new; a malformed link stays unresolved as today.
- **R2:** [paraphrase] For a collection in a link workspace, a wiki link or embed whose target is an existing file inside the workspace root but not an indexed document (non-Markdown attachment, a note in an unindexed folder, or a note excluded by a collection pattern) is not reported as `unresolved`. The audit reports it under a distinct, non-warning status (for example `outside-index`), counted separately, with no graph edge created and no document content read or returned. Resolution still never widens retrieval scope, and an excluded path is never indexed or surfaced beyond its existence as a link target. Errors: a target that does not exist on disk stays `unresolved`; filesystem errors during the existence check degrade to `unresolved` with a single diagnostic, not a failed audit.
- **R3:** [paraphrase] The existence check for R2 honours the same resolution order as workspace links (exact path, same folder, fewest folders above) and Obsidian's attachment rules (extension required for non-Markdown targets, `.md` optional for notes), and is bounded: one workspace file listing per audit run, not a filesystem walk per link.
- **R4:** [inferred] Markdown links whose link text contains balanced or unbalanced square brackets do not produce a bogus target; either the link parses as Obsidian renders it or it is skipped as unparseable, never reported as a missing target named after its text.
- **R5:** [user] A fixture vault covers escaped table aliases, image and PDF embeds, a link into an excluded folder, a link into an unindexed folder, a genuinely missing target, and nested-bracket Markdown link text; on it `gno audit links` reports exactly the genuinely missing target as unresolved and every other case with its intended status.
- **R6:** [inferred] Docs (audit rule reference and link workspace section of CONFIGURATION) describe the `outside-index` status and state that Obsidian's escaped table alias is supported.

## Boundaries
<!-- scope: business -->

- [inferred] No indexing of non-Markdown attachments or excluded folders; R2 is existence-only.
- [inferred] No change to workspace resolution order, egress policy, or which documents retrieval returns.
- [inferred] Orphan detection (`links.orphans`) is out of scope except that it must not count `outside-index` links as edges.

## Decision Context
<!-- scope: both -->

The audit is the natural single link authority once links resolve across collections; the remaining gap to Obsidian is mostly classification, not resolution. Existence-only handling of files outside the index keeps the privacy model intact: an excluded folder stays unindexed, and the audit only learns that a path exists. [paraphrase]

## Resolved via Codebase

- Wiki link parsing: `src/core/links.ts` (`WIKI_LINK_REGEX = /\[\[([^\]|]+(?:\|[^\]]+)?)\]\]/g` keeps a trailing backslash on the target; `MARKDOWN_LINK_REGEX` does not allow brackets in link text).
- Audit link rule and finding kinds: `src/core/audit-links.ts` (`unresolved-target`).
- Workspace resolution: fn-178-workspace-wide-wikilink-resolution.
