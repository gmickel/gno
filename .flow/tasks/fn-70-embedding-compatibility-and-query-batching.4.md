# fn-70-embedding-compatibility-and-query-batching.4 Document re-embed implications and benchmark outcomes

## Description

Close the loop with clear operator-facing guidance.

Start here:

- `docs/CONFIGURATION.md`
- `docs/TROUBLESHOOTING.md`
- `docs/CLI.md`
- `research/embeddings/README.md`
- `website/features/benchmarks.md`

Requirements:

- say clearly which embedding changes require re-embedding
- say clearly which runtime changes do not
- document the current compatibility story for:
  - Qwen
  - Jina-style challengers
  - Nomic-style challengers
- if benchmark conclusions change, keep docs consistent

Tests / smoke:

- run docs verification/lint gates
- include benchmark/smoke references in the task evidence
- verify the written guidance matches the actual implementation outcome

## Acceptance

- [ ] Docs distinguish re-embed-required changes from runtime-only changes.
- [ ] Compatibility guidance is consistent across docs and benchmark pages.
- [ ] The current Qwen recommendation remains clear and stable.
- [ ] Task evidence includes both regression/gate output and smoke references.

## Done summary

Updated docs and benchmark guidance for compatibility profiles and re-embed implications.

Delivered:

- documented that formatting-profile changes require re-embedding while batching/runtime-only changes do not
- removed stale code-only Qwen recommendation copy now that Qwen is already the global default embed model
- updated benchmark pages and research docs with current profile-aware smoke numbers
- documented current compatibility story for Qwen, Jina-style challengers, and Nomic-style challengers

## Evidence

- Commits:
- Tests: bun run docs:verify, bun run lint:check, make -C website build, .flow/bin/flowctl validate --all
- PRs:
