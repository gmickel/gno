---
satisfies: [R1, R2, R3, R4, R5]
---
# fn-196-consistency-follow-ups-after-28x.1 Implement Consistency follow-ups after 2.8.x

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
All five consistency follow-ups are implemented. Each has a regression test that fails on the pre-change code and a live before/after QA run.

- R1: a resident `gno serve` or `gno daemon` adopts `collections` and `contexts` from its config file without a restart.
  - When: before each REST read (`handleResidentRead`), `GET /api/collections`, HTTP MCP request and daemon status request, and every 2 s while idle.
  - How: `src/serve/resident-runtime.ts` `refreshConfig` reuses the sessions refresh (`readInstanceConfig` binding checks and `adoptServedConfig`, including egress-epoch invalidation). An unreadable config answers 500 `SESSIONS_RUNTIME_FAILURE` and is never served stale.
  - Scope: other settings keep their restart behaviour. A newly added collection is watched but not auto-indexed; run `gno update`.
  - Test: `test/serve/resident-config-reload.test.ts`.
- R2: `gno vec sync`, `gno vec rebuild` and the doctor fingerprint groups read the active vector partition.
  - Code: the new `src/store/vector/partition-index.ts` maintains `vec_v1_<partition>` from its variants. Legacy indexes keep the `content_vectors` path.
  - Test: `test/cli/vec-partition.test.ts`.
- R3: every similarity surface uses one source vector.
  - Rule: `readSimilaritySourceVectors` returns the first current chunk, unit-normalized, for CLI, MCP, REST and graph edges. MCP was averaging all chunks.
  - Why first chunk: CLI, REST, graph edges and the gno.sh trace-graph workaround already used it, so graph `--include-similar` scores equal `gno similar` scores. It is also cheaper.
  - Docs: specs and docs now describe the rule.
  - Test: the parity case in `test/cli/commands/similar-vectors.test.ts`.
- R4: the change journal records link deltas only for Markdown sources (the converter gate), including records.
  - Test: `test/ingestion/change-delta.test.ts` (.txt/.py).
- R5: `[x](Note)` matches an unindexed `Note.md` as `links.outside-index`. An indexed `Note.md` keeps its status.
  - Code: `src/core/audit-outside-index.ts`.
  - Test: `test/audit/link-workspace-audit.test.ts`.

Gates:
- `bun test`: 5968 pass, 3 skip, 0 fail. Baseline green (5959).
- `lint:check`: green.
- `docs:verify`: green.
- No ingest version bump (fn-197 bumps to 10).
- Live QA evidence: `.flow/tmp/qa-fn-196-consistency-follow-ups-after-28x/`.

gno.sh: worktree `/home/gordon/work/gno-sh-fn196`, branch `fn-196-consistency-follow-ups`, commit 783b24c. It covers the daemon config reload and the extensionless Markdown link rule. Not pushed.

Follow-ups, not built:
- An extensionless Markdown link to an indexed note is still unresolved; the resolver matches exact `rel_path`.
- A collection added while the resident runs is not indexed until `gno update` or the next start.

stage: impl-review - skipped(config: REVIEW_MODE=none, repo rule skips review stages)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: aee3b4b680ce9029a21c5e44d1b56b4987ea43a5, 554c96174fe8665d79f7488c4f6d3212f7f91e49, 2c80ad311ff3eaad35545d9dded683fbb0e13bef, 3808f59ac567c3b190bb9357f7422d8ec0756bd4, 9cf69899c0bf331ba6b79783eccdad05ea0e7791, fdcb305340335cd14b5cac77bcf4826e10c7a638, d11b6f4cb2974fbb2ce6609e3ffa5c936628c7e9
- Tests: mise exec bun@1.4.2 -- bun test (5968 pass, 3 skip, 0 fail; baseline 5959 pass), mise exec bun@1.4.2 -- bun run lint:check, mise exec bun@1.4.2 -- bun run docs:verify, live QA before/after: .flow/tmp/qa-fn-196-consistency-follow-ups-after-28x/{before,after}, gno.sh: bun run check, bun run typecheck, bun run build (worktree /home/gordon/work/gno-sh-fn196, commit 783b24c)
- PRs: