# fn-67-evaluate-qwen3-embedding-06b-gguf-for.4 Publish benchmark outcome and default-model recommendation if warranted

## Description

Close the loop once evidence and reindex semantics exist.

Start here:

- `research/embeddings/README.md`
- `docs/CONFIGURATION.md`
- `docs/USE-CASES.md`
- `README.md`
- `website/features/benchmarks.md`
- `website/features/hybrid-search.md`
- `website/_data/features.yml`

This task should publish one of three outcomes clearly:

1. keep `bge-m3` as the normal-collection default
2. recommend `Qwen3-Embedding-0.6B-GGUF` as the new global default candidate
3. keep Qwen as a specialized recommendation only, not a default

Requirements:

- do not overstate the result
- explain multilingual/general-collection evidence, not just code evidence
- if recommendation changes, document the reindex flow users must follow
- if recommendation does not change, say why

Docs/website updates to own if outcome is publishable:

- `research/embeddings/README.md`
- `docs/CONFIGURATION.md`
- `docs/USE-CASES.md`
- `README.md`
- `website/features/benchmarks.md`
- `website/features/hybrid-search.md`
- `website/_data/features.yml`
- `bun run website:sync-docs`

Possible follow-up from this task:

- if Qwen really looks like a default replacement, open a separate implementation epic for changing shipped presets and release notes
- if UI work is needed for the new recovery flow, cross-link to `fn-66`

## Acceptance

- [ ] Published docs say clearly whether Qwen should remain specialized or become the new general recommendation.
- [ ] Any recommendation change includes the required reindex/recovery guidance.
- [ ] Benchmark pages and research docs agree with README/configuration copy.
- [ ] Website benchmark/retrieval pages are updated if the outcome is user-visible enough.
- [ ] If evidence is not strong enough to change defaults, the docs say so plainly.

## Done summary
Published the benchmark outcome and the current recommendation.

Delivered:
- documented the new general multilingual benchmark lane in README, research docs, configuration docs, and website benchmarks page
- published the actual comparison numbers for `bge-m3` vs `Qwen3-Embedding-0.6B-GGUF`
- recorded the current stance: Qwen is the strongest general multilingual candidate, but GNO keeps `bge-m3` as the shipped default until a deliberate default-switch follow-up lands
## Evidence
- Commits:
- Tests: bun run docs:verify, make -C website sync-docs, bun run lint:check
- PRs: