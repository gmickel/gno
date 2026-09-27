# Markdown links: honour escaped brackets and reject destinations with spaces

## Goal & Context
<!-- scope: business; source: user -->

After fn-195 (2.8.2), `gno audit links` on a real vault of about 2,000 notes reports one broken link that Obsidian does not render as a link at all: quoted prose of the form `\[-some clause -](vgl. Ziff. 10.1 von Beilage 4)`. Two CommonMark rules each make this plain text: a backslash-escaped `[` cannot open a link, and an inline link destination may not contain unescaped spaces unless it is wrapped in `<...>`. GNO still extracts it as a Markdown link to a file named `vgl. Ziff. 10.1 von Beilage 4` and reports it as `unresolved`. The same text without the backslash is also plain text under the second rule. [paraphrase]

## Acceptance Criteria
<!-- scope: both -->

- **R1:** [paraphrase] A `[` preceded by an odd number of backslashes does not open a Markdown link or image in link extraction (graph, backlinks, `gno links`, impact, audit).
- **R2:** [paraphrase] An inline link destination that contains an unescaped space is not a link unless it is wrapped in angle brackets (`[x](<my note.md>)`), matching CommonMark and Obsidian; `%20`-encoded and angle-bracketed destinations keep resolving as today.
- **R3:** [inferred] Fixture cases: an escaped-bracket clause, an unescaped clause with a spaced parenthetical, `[x](<my note.md>)` and `[x](my%20note.md)`; the audit reports no finding for the first two and resolves the last two.

## Boundaries
<!-- scope: business -->

- [inferred] No change to wiki-link parsing or workspace resolution.

## Resolved via Codebase

- Markdown link extraction: `src/core/link-inventory-markdown.ts`, `src/core/link-destination-parse.ts`, `src/core/links.ts` (`MARKDOWN_LINK_REGEX`).
- Predecessor: fn-195-audit-links-ignore-code-spans-and-non.
