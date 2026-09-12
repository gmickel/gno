---
satisfies: [R1, R2, R3, R4, R5, R6, R7]
---
# fn-166-configurable-index-chunking.1 Implement configurable index chunking

## Description
TBD

## Acceptance
Every R-ID in the parent spec's Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Implemented optional index-wide chunking with unchanged defaults, cached mirror rechunking, stale-writer rejection, and shared CLI/SDK/MCP/REST status. Applied policy/provenance uses existing schema_meta entries, avoiding the schema-version fingerprint regression caught by the frozen Ask test. Existing source metadata and unchanged embeddings remain intact.

The repository now uses native no-plan work and self-QA. The four planned tasks were removed; the Grok bridge stopped before making edits. Source and hosted documentation explain configuration, units, cached/source freshness, and separate-index experiments. The shipped skill and project mirrors are synchronized.

Verification ran with Bun 1.4.2:

- Full suite: 5,303 passed, two existing opt-in/platform skips, zero failures. Lint/typecheck passed with 26 warnings in unchanged files.
- Documentation verification: 15 passed, two model-cache skips; real-model QA and packed-package smoke cover semantic behavior separately.
- Hybrid evaluation: 33 cases, 86% aggregate score. Skill usage evaluation: 47/47 checks with the fixed Haiku evaluator.
- Existing-index comparison: all 75 documents, 289 chunks, timestamps and 61 returned lexical results unchanged. Median repeat sync 0.540s before / 0.525s after in this synthetic local run.
- Real embedding test: six existing vector variants and owners unchanged on default upgrade; zero re-embedding on repeat. A separate 128-token index produced 27 chunks versus six at defaults. Rechunk-only backlog, embedding completion, revert, and invalid-config/no-mutation cases passed.
- Live stale SDK writer rejected, chunk bytes unchanged, reopen recovery passed. SIGTERM after one cached mirror left 73 pending mirrors; the next CLI run reported the interrupted lexical stage and completed those 73.
- Live MCP status plus lexical/vector tool calls, SDK status, and REST status agree.
- Hosted docs: check/typecheck/test/build passed; 395 tests passed with 41 existing opt-in skips. Configuration/CLI/API/SDK/MCP pages were driven at 1380x880 and 390x844, with screenshots, no page overflow, working navigation/copy feedback, and no console or network failures.
- Packed package smoke and browser clipper reproducibility passed. The real GNO sentinel preserved 13 files / 601,614,213 bytes by SHA-256/stat/count.

Evidence: /tmp/gno-fn166-compatibility-v2/comparison.json; /tmp/gno-fn166-liveqa/report.json; /tmp/gno-fn166-liveqa/interruption-report.json; .flow/tmp/qa-fn-166-configurable-index-chunking/ (MCP/SDK and docs evidence); /tmp/gno-fn166-full-tests-final.log; /tmp/gno-fn166-package-smoke.log; /tmp/gno-fn166-skill-eval/run.log.

stage: plan - skipped(policy: current route is no-plan; earlier decomposition retired by user)
stage: impl-review - skipped(policy: user requested self-QA instead)
stage: completion-review - skipped(policy: user requested no review)
stage: plan-sync - skipped(config: disabled)
stage: qa - ran (real CLI, SDK, MCP, REST and downstream browser evidence)

Implementation and pre-merge QA are complete. Publication and downstream production verification remain release steps; no release is claimed here.
## Evidence
- Commits: 1a97e8da319d98f299132f83ee5b16983f2d3539, a084933c7150d231ed7c377200adefca90a9940d
- Tests: bun test, bun run lint:check, bun run docs:verify, bun run verify:clipper-package, GNO_PACKAGE_SMOKE_EMBED_MODEL=<pinned embeddinggemma> bun run test:package, bun run eval:hybrid, EVAL_MODEL=haiku uv run --frozen eval.py (47/47; candidate skill hash recorded), python3 /tmp/gno-fn166-compare-v2.py, python3 /tmp/gno-fn166-liveqa.py, bun .flow/tmp/qa-fn-166-configurable-index-chunking/mcp-sdk.ts, bun .flow/tmp/qa-fn-166-configurable-index-chunking/stale-sdk.ts, python3 /tmp/gno-fn166-interruption.py, gno.sh: bun run check; bun run typecheck; bun run test; bun run build, python3 /tmp/gno-fn166-docs-qa.py (10 driven views)
- PRs: