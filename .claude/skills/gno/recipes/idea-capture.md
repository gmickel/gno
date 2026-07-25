# Idea Capture

Use this recipe when the user has a rough idea, product thought, prompt pattern, feature concept, or research direction to preserve.

## Inputs

- Exact idea phrasing.
- Context that triggered it.
- Related people, projects, sources, or prior notes.
- Whether the user wants storage only or light synthesis.

## Workflow

1. Search for adjacent notes first so duplicates and prior context are visible.

```bash
gno query "<idea keywords>" --json
gno similar <related-uri>
```

2. Preserve the original wording before synthesis.

3. Capture with `idea-original` or `prompt-pattern` when applicable.

```bash
gno capture "exact idea text" --preset idea-original --title "<idea title>" --json
gno capture --file ./prompt-pattern.md --preset prompt-pattern --title "<pattern title>" --json
```

4. Add provenance: origin, date, source/person if known, and related links.

5. Re-index and verify.

```bash
gno index
gno search "<distinctive phrase>"
```

## Guardrails

- Do not over-structure early ideas into fake decisions.
- Keep exact phrasing visible.
- Do not imply automatic propagation to project docs or trackers.
- Use links to related notes instead of inventing relationships.

## Done

- Original idea is saved.
- Related context is linked or named.
- Search finds the distinctive phrase.
