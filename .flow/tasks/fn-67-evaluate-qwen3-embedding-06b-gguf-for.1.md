# fn-67-evaluate-qwen3-embedding-06b-gguf-for.1 Create multilingual public markdown benchmark fixtures for general collections

## Description

Build a reproducible public markdown corpus for evaluating embedding models on normal collections.

Start here:

- `evals/fixtures/code-embedding-benchmark/`
- `evals/helpers/code-embedding-benchmark.ts`
- `evals/multilingual.eval.ts`
- `docs/USE-CASES.md`

Requirements:

- no Gordon/private content
- use public OSS/public-doc markdown only
- provenance must be pinned and documented
- benchmark should run offline once fixture files are in the repo
- multilingual coverage is required

Recommended fixture shape:

- new fixture family under `evals/fixtures/general-embedding-benchmark/`
- vendored markdown snapshots grouped by language
- manifest with:
  - source repo/site
  - upstream commit/version/date
  - license
  - local file path
  - language
  - topic/category
- query/relevance files separated from the corpus

Target benchmark mix:

- same-topic docs in multiple languages
- distractor docs on nearby but distinct topics
- factual lookup queries
- concept/explanation queries
- exact-entity queries
- cross-language queries where query and relevant doc differ in language

Suggested minimum language set:

- English
- German
- French
- Spanish
- Italian
- one non-Latin-script language if licensing/sourcing stays clean

Tests:

- fixture manifest validation
- file existence/shape validation
- deterministic fixture materialization test if any build step is used

Docs:

- new fixture README with sourcing policy
- make explicit that this fixture exists because product-default decisions must not rely on private corpora

## Acceptance

- [ ] A new general markdown benchmark fixture exists with no private content.
- [ ] Source provenance and license info are pinned for every vendored source.
- [ ] The fixture covers multiple languages and cross-language retrieval cases.
- [ ] Query/judgment files are deterministic and repo-local.
- [ ] Fixture docs explain why this lane is separate from the code benchmark.

## Done summary

Built the new public multilingual markdown benchmark fixture for general collections.

Delivered:

- vendored a FastAPI multilingual docs slice under `evals/fixtures/general-embedding-benchmark/corpus/`
- added pinned provenance/license metadata in `sources.json`
- added same-language and cross-language benchmark cases in `queries.json`
- added fixture README and harness smoke coverage

## Evidence

- Commits:
- Tests: bun test test/research/general-embedding-benchmark.test.ts, bun run lint:check
- PRs:
