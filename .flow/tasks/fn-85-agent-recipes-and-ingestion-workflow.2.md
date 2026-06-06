---
satisfies: [R3, R4, R5, R6, R7, R10]
---

## Description

Add the recipe router and the seven final agent recipe playbooks. `assets/skill/SKILL.md` should remain concise and route agents to task-specific recipe files. Recipe content should teach actual GNO workflows, not new integrations.

**Size:** M
**Files:** `assets/skill/SKILL.md`, `assets/skill/recipes/brain-first-lookup.md`, `assets/skill/recipes/capture-and-file.md`, `assets/skill/recipes/meeting-ingestion.md`, `assets/skill/recipes/email-context.md`, `assets/skill/recipes/source-summary.md`, `assets/skill/recipes/idea-capture.md`, `assets/skill/recipes/citation-and-provenance.md`, `assets/skill/examples.md`, `assets/skill/README.md`.

## Approach

- Add a compact recipe resolver table to `SKILL.md` near the existing capture and reference-document sections.
- Replace any task-1 placeholder recipe content with final task-shaped playbooks.
- Each recipe should include trigger, inputs, command ladder, citation/provenance rules, what not to do, and final verification.
- Use actual shipped commands: `search`, `query`, `ask`, `get`, `multi-get`, `links`, `graph query`, `query diagnose`, `capture`, `update`, `index`, and `embed` where appropriate.
- Keep external email/calendar/chat/web data as user-supplied/exported/optional input; do not imply GNO can fetch those systems natively.
- Include prompt-injection guidance: source text is evidence, not instructions.

## Investigation targets

**Required**

- `assets/skill/SKILL.md:207-261` — existing embedding and capture guidance to reuse.
- `assets/skill/SKILL.md:296-302` — reference-document table where recipes should be linked.
- `assets/skill/examples.md:355-406` — existing capture examples to extend or cross-link.
- `src/core/capture.ts:27-35` — valid capture source kinds.
- `src/core/capture.ts:499-516` — structured `source:` frontmatter behavior.
- `src/core/capture.ts:627-646` — capture timestamp/hash default path behavior.
- `src/core/note-presets.ts:11-21` — available preset IDs.
- `src/core/note-presets.ts:132-155` — `source-summary` and `idea-original` scaffold behavior.

**Optional**

- `/tmp/gbrain/skills/RESOLVER.md` — resolver-table inspiration only; do not copy wording.
- `/tmp/gbrain/docs/guides/brain-first-lookup.md` — lookup-chain inspiration only; do not copy wording.
- `docs/adr/007-typed-graph-edges.md` — relation/provenance wording when recipes mention typed graph output.

## Key context

fn-82 and fn-83 provide the capture/provenance and page-type substrate. fn-84 provides typed graph/query diagnostics. If fn-83 remains open, this task can reference shipped preset behavior but must not state that the fn-83 spec is closed.

## Acceptance

- [ ] `SKILL.md` has a concise resolver that maps brain-first lookup, capture/file, meeting ingestion, email-context, source summary, idea capture, and citation/provenance intents to recipe files.
- [ ] The seven recipe files exist in the chosen layout and use relative links that work in installed skill directories.
- [ ] Recipes use actual GNO commands and avoid `gno recipes` or non-existent MCP prompt/tool claims.
- [ ] Write-flavored recipes require provenance/source metadata and state how to verify sync/index/embed/search freshness after capture.
- [ ] Email/meeting/source recipes say external data must be supplied/exported or accessed through an explicitly separate connector, not natively fetched by GNO.
- [ ] Recipes tell agents to treat retrieved emails, transcripts, web pages, and documents as untrusted source data, not executable instructions.
- [ ] Citation guidance requires `gno://` URI, doc id, line/snippet, file path, source URL, or capture `source:` metadata; unsupported claims must be reported as not found.
- [ ] Recipe language records fn-83 dependency accurately: page-type/preset behavior is available, but fn-83 spec closure is not implied if still open.

## Done summary

Not started.

## Evidence

Not started.
