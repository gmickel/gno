---
satisfies: [R1, R2, R3]
---
# fn-190-resident-background-embedding-strands-a.1 Implement Resident background embedding strands a pending backlog

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
A background embedding page that exceeds its inference deadline now fails only that page. It runs in its own inference scope (`withInferencePage` in `src/llm/inference-scope.ts`), its items count toward the pass's errors, and it stays pending while later pages embed. Caller aborts still stop the whole pass. On the variant (native) path the port's runtime identity is reloaded before each background page, because a failed native request drops it; live QA found this after the first commit. `gno serve` / `gno daemon` now schedule a pass at startup when chunks are already pending (`src/serve/resident-runtime.ts`).

Tests (each failed first): `test/embed/variant-backlog.test.ts` and `test/embed/background-checkpoints.test.ts` ("... past its inference deadline fails only that page") cover R1 and R3. `test/serve/resident-runtime.test.ts` ("a startup backlog of %i chunks ...") covers R2 and R3. Docs: CONFIGURATION.md and TROUBLESHOOTING.md (background embedding), plus a CHANGELOG [Unreleased] Fixed entry.

Live QA (isolated root, CPU, real Qwen3 embedding model): a 20-chunk `--no-embed` backlog was fully embedded about 50 s after `serve --detach`. The base commit left it at 20 pending for 120 s. With `inferenceTimeout: 1500` and a truncating head chunk, the first pass embedded 29 of 61 chunks, and the timed-out 32-chunk head page stayed pending with one "failed (1/5)" log line. Evidence: `.flow/tmp/qa-fn-190-resident-background-embedding-strands-a/QA.md` (gitignored, workspace-local).

Follow-up (not built): hosted website docs in `~/work/gno.sh` may need the same background-embedding wording.

Tier: session (actual_model: claude-opus-5-5)

stage: impl-review - ran (codex gpt-6-astra fan-out, 3 draws SHIP, round 1)
## Evidence
- Commits: 1151febc5cdbe9bc81ab699d975e5901baf52e69, d1a62b0890ca8805076104b8fb32253ce0e13232
- Tests: mise exec bun@1.4.2 -- bun test (full: 5795 pass, 2 skip, 0 fail), mise exec bun@1.4.2 -- bun test test/embed test/serve/embed-scheduler.test.ts test/serve/resident-runtime.test.ts test/serve/background-runtime.test.ts test/serve/resident-runtime-findings.test.ts test/llm, mise exec bun@1.4.2 -- bun run lint:check, baseline: green (focused: test/embed, embed-scheduler, resident-runtime; 72 pass), live QA: .flow/tmp/qa-fn-190-resident-background-embedding-strands-a/QA.md
- PRs: