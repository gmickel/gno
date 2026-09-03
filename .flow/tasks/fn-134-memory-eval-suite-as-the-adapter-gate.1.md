---
satisfies: [R1, R2, R3, R4, R5]
---
# fn-134-memory-eval-suite-as-the-adapter-gate.1 Implement Memory eval suite as the adapter gate (dogfood-in-a-box)

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Added `evals/memory.eval.ts` plus `evals/helpers/memory-{fixtures,harness,suites}.ts` and content-hashed fixtures under `evals/fixtures/memory/`: seven deterministic Evalite suites drive the fn-130 remember/recall contracts through the SDK against a temp index (offline, lexical-only) - upsert correctness (R1), supersession current state incl. stale and racing-supersede conflicts (R2, precision 1.0), recall quality under the 8-fact/512-token budget with cite validity via `client.get` (R2, recall@5 >= 0.8 / cite 1.0 / budget 1.0), fence at eval scale (R2, exact replay + derivedFrom rejection 1.0; paraphrase leak-through 7/7 reported as observability only), scope isolation (R2, leakage 0), a scripted agent day compared to a committed golden with a line diff printed to stderr on divergence (R3), and a recall latency envelope (R2, p95 <= 25 ms, measured ~2.8 ms). `bun run eval:memory` runs evalite with `--threshold 100`, so the gate is red on any sub-threshold suite; `bun run eval:memory:fixtures [--golden]` refreshes the sha256 manifest / golden and the loader refuses stale pins. Two consecutive runs produced byte-identical normalized output (R1). Gate contract documented in AGENTS.md (CLAUDE.md symlink) and docs/MEMORY.md "Eval gate and fixtures" incl. the fixture format table (R4, R5); evals/README + evals/CLAUDE rows; CHANGELOG Unreleased entry.

Notes: `git add -A` was scoped to exclude the pre-existing untracked `.flow/artifacts/*` dirs (FORBIDDEN list) - they remain untracked. The hosted site (~/work/gno.sh) carries no memory docs page yet, so no downstream site change. docs-verify's 4 failures (README/website version pins, skill parity) predate this task.

stage: impl-review - skipped(config: REVIEW_MODE=none)
## Evidence
- Commits: 5c0fd4a25cbb65c9c206fdec250501edf786b6af
- Tests: baseline: none (spec defines no Quick commands); bun run lint:check green pre-edit, bun run eval:memory (run 1, rc=0, Score 100%, Threshold 100%), bun run eval:memory (run 2, rc=0, normalized output sha256 identical to run 1: 5a7d2776…), bun run eval:memory with edited fixture + stale manifest -> rc=1 (drift refused), bun run eval:memory with edited golden + refreshed manifest -> rc=1 (Score 97%, golden DIFF), bun run lint:check (rc=0; 1 pre-existing warning in test/cli/query-text.test.ts, inherited), bun test (suite_rc=0: 4693 pass, 2 skip, 0 fail, 547 files), bun scripts/docs-verify.ts rc=1 inherited: README/website version pins and skill parity, untouched by this task
- PRs:
stage: plan-sync - skipped(config: planSync.enabled != true)
