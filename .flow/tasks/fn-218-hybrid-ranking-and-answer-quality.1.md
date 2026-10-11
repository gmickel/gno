---
satisfies: [R1, R2, R3]
---
# fn-218-hybrid-ranking-and-answer-quality.1 Implement Hybrid ranking and answer quality

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
R1: each ranking hypothesis evaluated with real expansion, vector and rerank stages (default preset, 45 judged cases, deterministic across runs) via `bun run eval:ranking-ablation`. Shipped: document-level fusion with best rank per list (nDCG@10 0.973 -> 0.990, R@5 0.956 -> 1.000, MRR 1.000 kept; 4 cases better, none worse). Not shipped: monotonic blends (neutral), rerank-first (worse on every aggregate), document fusion counting every chunk (3 regressions). Deferred in the spec: query-inferred dates (no date-bearing judged cases; dating fixtures would decide the outcome). Results and negatives in evals/README.md (Ranking Ablation).

R2: `--explain` fusion line reports fused documents; HOW-SEARCH-WORKS, GLOSSARY, ARCHITECTURE, README and spec/cli.md describe document-level fusion. Explicit --since/--until unchanged.

R3: ordinary and verified answer prompts state today's local date and each source's content date (`documentDate`: frontmatter/record date; never modification time; omitted when unknown). Frozen replay gates keep exact complete-record pins via declared intended deltas (hybrid hydration: fusion; Ask: date line) at a pinned local date.

stage: impl-review - ran (model: gpt-6.1-sol, high) NEEDS_WORK (temporal hypothesis unevaluated; ablation could report a lexical-only run; replay pinned a UTC instant) -> fixed/deferred in spec -> SHIP
Not run as a gate: ask.eval scores 50% on this branch and on main alike (every case 0 citations; judge skipped without OPENAI_API_KEY) - pre-existing.

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 007f8c8f589561fbe144ff0693c672b4ed1b9361, 62e4339202fa965d163bc0522783e064b7459fe8, b3867eba789ba3994511c3a881f1cc6475b783f9, 220d6f598e7a371f9bc7a9b51a74aebef0e2e303, b2e032df4fbfe226192319becabd6a78dd9cc667
- Tests: bun test (6197 pass, 0 fail), bun run eval:ranking-ablation --cases (3 runs, deterministic), TZ=Pacific/Kiritimati / America/Los_Angeles bun test test/pipeline/ask-hydration.test.ts, bun run lint:check
- PRs: