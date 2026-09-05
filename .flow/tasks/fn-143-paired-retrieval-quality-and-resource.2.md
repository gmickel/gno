---
satisfies: [R1, R2, R5]
---
# fn-143-paired-retrieval-quality-and-resource.2 Promote isolated audit fixtures and exhaustive oracles

## Description
Promote isolated audit fixtures and exhaustive oracles. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** evals/fixtures/acceptance/ (new), evals/acceptance/fixtures.ts (new), test/eval/acceptance/fixtures.test.ts (new)
**Touches:** [evals/fixtures/acceptance/, evals/acceptance/fixtures.ts, test/eval/acceptance/fixtures.test.ts]

### Approach

- Promote sanitized deterministic audit generators for eligible-top-k, 1000-chunk hydration, EN/DE/CJK reranking, expiry/restoration and title-conditioned duplicates. Preserve original negative/slower cases in provenance.
- Hash corpus, queries and expected eligible evidence. Build independent baseline/candidate temporary indexes from identical source fixtures so schema changes do not share an index.
- Keep memory fixtures/thresholds unchanged. Scenario owners may add separately identified cases; they must not overwrite an established baseline manifest.

### Investigation targets

**Required:**
- `evals/helpers/setup-db.ts:171`
- `evals/helpers/memory-harness.ts:64`
- `evals/agentic/native-fixture-store.ts:62`
- `evals/fixtures/memory/manifest.json`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/eval/acceptance/fixtures.test.ts test/eval/memory-fixtures.test.ts
bun run eval:memory
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Generation is repeatable by hash and both isolated indexes contain identical source corpus identities.
- [ ] Exhaustive eligible oracle includes document ownership and chunk language; title-variant fixture tests both ingestion orders.
- [ ] Negative controls leave original fixtures and real HOME/XDG/GNO state untouched.

## Done summary
Implemented deterministic synthetic acceptance fixtures, pinned corpus/query/exhaustive-oracle hashes, and two independently built temporary SQLite indexes. Corpus: 296 documents, 51 scenarios; includes rare eligibility, 1,000 chunks, EN/DE/CJK conflicting boundary/tail claims, long query, lifecycle recipes, and both title ingestion orders. README records sanitized provenance and preserves negative/slower observations without copying private data or measurements.

Files: evals/acceptance/fixtures.ts; evals/fixtures/acceptance/{generate.ts,manifest.json,README.md}; test/eval/acceptance/fixtures.test.ts.

Baseline: 6 existing memory fixture tests passed before edits. Final focused command: bun test test/eval/acceptance/fixtures.test.ts test/eval/memory-fixtures.test.ts — 9 passed, 84 assertions. Logs: /tmp/fn-143.2-baseline.log and /tmp/fn-143.2-tests.log. Targeted repo-config oxlint passed, but evals are ignored by repo config. Explicit whole-project tsc check returned unrelated errors (no owned-file diagnostics), captured /tmp/fn-143.2-types.log. eval:memory deferred to host to avoid port 3006 concurrency; host reports initial 100% baseline.

R1: memory fixture pins unchanged; native/model-backed claims deferred to adapter and host gates.
R2: exhaustive evidence owns URI, title, source/mirror hash, chunk sequence/language/span/text; no top-k truncation. Both index ingestion orders preserve shared-body ownership and title-conditioned embedding inputs.
R5: candidate-only inactive control proves baseline index, generated corpus, memory manifest and process HOME/XDG/GNO environment remain untouched. Existing comparator negative controls remain unchanged.

stage: impl-review - skipped(config: user requested no reviews)
Shared-checkout override: no git/Flow state mutations; host commits, validates full gates, and completes task. No GPU/native execution or semantic pass claimed.

Host follow-up: bun run eval:memory passed unchanged threshold100, 19 evaluations; /tmp/fn1432-memory.log. Implementation model: gpt-6-astra medium.
## Evidence
- Commits:
- Tests: bun test test/eval/acceptance/fixtures.test.ts test/eval/memory-fixtures.test.ts — 9 pass,84 assertions, bun run eval:memory —100% unchanged threshold100;19 evaluations, targeted format and repository-config lint passed; full integration typecheck pending .3 completion
- PRs: