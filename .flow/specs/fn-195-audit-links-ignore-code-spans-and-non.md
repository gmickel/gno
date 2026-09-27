# Audit links: ignore code spans and non-Markdown sources, classify Markdown links to unindexed files

## Goal & Context
<!-- scope: business; source: user -->

After fn-194 (2.8.1), `gno audit links` on the same real vault dropped from 526 to 38 `links.local-targets` findings and now also catches genuine damage an external checker missed (a wiki link left unclosed mid-edit that spans several lines). The remaining false positives come from three narrow causes, and removing them would let the audit serve as the vault's single link authority. [user]

Classification of the 38 (paraphrased):

- 25: link-like strings in non-Markdown files that a collection indexes with a `**/*` pattern, such as test fixtures and f-string templates in Python scripts (`"[[{stem}{anc}]]"`, `[[Cross Link Target\|x]]` inside a test string). Obsidian does not parse links in non-Markdown files. [paraphrase]
- 2: wiki links written inside inline code spans in Markdown prose, for example a log line that documents syntax as `` `[[Note]]` ``. Obsidian does not treat code spans or fenced code blocks as links. [paraphrase]
- 4: relative Markdown links to files that exist beside the note but are not indexed, for example `[scripts/doctor.sh](scripts/doctor.sh)` in a skill copy whose collection pattern is `**/*.md`. fn-194 classifies wiki links and embeds to such files as `links.outside-index`; Markdown links still report `unresolved`. [paraphrase]
- The rest are genuine: a template placeholder, an unclosed multi-line wiki link, converted-book anchors, and a Markdown link whose target text was never a path. [paraphrase]

## Acceptance Criteria
<!-- scope: both -->

- **R1:** [paraphrase] Link extraction for the graph, backlinks, `gno links`, impact and audit ignores inline code spans and fenced or indented code blocks in Markdown, matching Obsidian. A link outside code on the same line still counts.
- **R2:** [paraphrase] Documents whose source is not Markdown (for example `.py`, `.sh`, `.json`, `.txt`, converted Office/PDF text) produce no wiki or Markdown link edges and no link audit findings. Their content stays searchable as today.
- **R3:** [paraphrase] A relative Markdown link whose target exists on disk inside the link workspace but is not an indexed document is reported as `links.outside-index` (informational), under the same existence-only rules as fn-194: no indexing, opening or returning of the file.
- **R4:** [inferred] A fixture covers a code span and a fenced block containing wiki links, a Python file with wiki-link-shaped strings in a `**/*` collection, and a Markdown link to an existing unindexed `.sh` file; the audit reports none of them as unresolved, while an unclosed multi-line wiki link and a genuinely missing target still are.
- **R5:** [inferred] The audit rule docs describe R1-R3.

## Boundaries
<!-- scope: business -->

- [inferred] No change to search indexing of non-Markdown files, workspace resolution order, or egress.
- [inferred] Converted-book anchor links and genuinely missing targets stay reported.

## Resolved via Codebase

- Link parsing and inventory: `src/core/links.ts`, `src/core/link-inventory.ts`, `src/core/link-inventory-markdown.ts`, `src/core/link-destination-parse.ts`.
- Audit link rule: `src/core/audit-links.ts`; `links.outside-index`: `src/core/audit-outside-index.ts`.
- `src/core/link-inventory-markdown.ts` already computes `codeContextReason`, yet 2.8.1 still reports a wiki link inside an inline code span as `unresolved`, so the audit's finding path apparently does not apply it (to confirm).
- Predecessor: fn-194-audit-links-obsidian-parity-for-escaped.
