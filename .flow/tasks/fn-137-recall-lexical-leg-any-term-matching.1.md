# fn-137-recall-lexical-leg-any-term-matching.1 Implement Recall lexical leg: any-term matching for question-shaped queries

## Description
TBD

## Acceptance
Satisfies the spec's goal, requirements and triage notes; judge against the spec directly.

## Done summary
Recall's lexical leg now answers question-shaped queries without vectors. It drops question and function words, requires every remaining content word first, and falls back to any-term BM25 with a 0.1 relative score floor, so a word shared by most facts cannot flood the result. The recall budget is now filled in retrieval-rank order; the shared selector had been picking the shortest facts first. An empty recall's hint now says whether the scope is empty, nothing matched, or the matches did not fit the token budget. The same hints appear on the CLI, MCP, REST and SDK.

- Fixture: recall.json gains question-shaped queries q13-q19, and the manifest pins are refreshed. On base code all seven return nothing; now each returns the relevant fact first. The agent-day golden t13 changed order only: it is now BM25 order where it was shortest-first. The golden is documented as recording rank order.
- Tests: 7 new regression tests in test/core, test/cli and test/mcp memory.test.ts. They cover question queries, the no-match and over-budget hints, and no flood. All 7 fail on base code.
- Docs: docs/MEMORY.md (the "embed the collection" workaround is removed), docs/CLI.md, spec/cli.md, spec/mcp.md, the recall schema description, the skill recipe (3 copies), evals/README.md, the Hermes provider warning and README, and CHANGELOG Unreleased/Fixed.
- gno.sh: commit d8c32c6 on branch fix/fn-137-recall-question-queries in worktree ~/work/gno-sh-fn137. It is local only.
- Gates: lint:check, bun test (5908 pass), docs:verify and eval:memory (100%) are all green.
- Follow-up (not built): searchBm25 infers date ranges from the query text (resolveTemporalRange). A recall question containing "last week" could therefore apply a time filter to memory facts. This behavior predates the change and was not touched.

stage: impl-review - skipped(config: REVIEW_MODE=none, user instruction: no model review)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: fc10a2833e18b6d2ecda500b502e60869b6c7ae5
- Tests: mise exec bun@1.4.2 -- bun run lint:check, mise exec bun@1.4.2 -- bun test (5908 pass, 3 skip, 0 fail), mise exec bun@1.4.2 -- bun run docs:verify, mise exec bun@1.4.2 -- bun run eval:memory (100%, 20 recall queries, recall@5 1.000, golden match), live QA: .flow/tmp/qa-fn-137-recall-lexical-leg-any-term-matching/{before,after}.txt, gno.sh d8c32c6 on fix/fn-137-recall-question-queries: check, typecheck, test (431 pass), build
- PRs: