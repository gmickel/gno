---
satisfies: [R4, R5, R6]
---
# fn-132-wired-loop-capture-parity-changes.1 Staged resumable indexing + crash investigation

## Description
Staged resumable indexing + crash investigation. **Size:** L. **Files/Touches:** src/cli/commands/index-cmd.ts (NOTE: current code discards a failed embed result and returns success:true — that exit-0-on-embed-failure defect is in scope to fix), src/cli/commands/embed.ts, src/embed/** (extend backlog/cursor persistence), receipts + output schema, test kill-9 resume.
Receipt contract (binding): stages lexical|embed each report state completed|failed|skipped|interrupted with counts; overall exit = 0 only when every attempted stage completed (embed failure → non-zero with partial receipt); a SIGKILLed process emits nothing — the NEXT run's resume preamble reports the interrupted stage and continues from persisted progress. Investigate the Bun 1.3.14 combined-run crash (field report 2026-09-01) as far as evidence allows; R5 honesty: root-cause+guard OR documented sidestep. Reuse fn-130's lease/sync helpers (spec dependency on fn-130 now encoded).

**Touches:** src/cli/commands/index-cmd.ts, src/cli/commands/embed.ts, src/embed/**, receipt output schema, kill-9 resume test

## Acceptance
- [ ] Embed-stage failure yields non-zero exit + per-stage receipt (fixes today's exit-0 defect; regression test)
- [ ] kill -9 during embed: lexical remains valid; rerun's preamble reports interrupted stage; embedding resumes without re-embedding completed chunks (live test)
- [ ] Receipt schema committed; gno index --json carries per-stage states/counts
- [ ] Crash finding documented either way (root cause + guard, or evidence-bounded sidestep note)

## Done summary
`gno index` now runs lexical and embed as separable, resumable stages with persisted lifecycle markers (`schema_meta.index_stage_state`) and a per-stage receipt (`index-receipt@1.0`: `{ success, stages: { lexical, embed }, resumedFrom, syncResult, embedSkipped, embedResult? }`). An embed-stage failure exits 2 with the partial receipt instead of the previous exit 0; a process killed mid-stage is reported by the next `gno index`/`gno embed` run's resume preamble (stderr, or `resumedFrom` in JSON) and embedding resumes from the persisted backlog without re-embedding stored chunks. Regression + resume coverage is a real-process test (`test/cli/index-resume.test.ts`: SIGKILL of `bun src/index.ts index` against a loopback fake embeddings server, then rerun; and endpoint-down -> exit 2 with receipt), plus unit tests for the marker module and schema contract tests. Docs: `spec/cli.md` gno index section, `docs/CLI.md` gno index section (stage receipts, recovery, crash finding).

R5 crash finding: reproduced live on thor (1 of 5 combined runs, 0 of 4 split) with a core dump - SIGABRT `pure virtual method called` in `llama_model::build_graph` during `llama_init_from_model` (context creation) while a second Bun pool thread was still in `llama_model_load`/`load_vocab`. GNO issues one deduplicated model load and creates contexts sequentially after it resolves, so the overlap sits in Bun's napi async-work path or node-llama-cpp; not root-caused, documented as an evidence-bounded sidestep. The staged contract recovered the crashed run live (preamble + full resume). Details and two unrelated `memory_breakdown` cores are in the run notes.

Out-of-Touches edit, deliberate: `src/cli/program.ts` index action (prints the partial receipt before the non-zero exit). `test/spec/schemas/validator.ts` gained `"index-receipt"` at the end of its list. CHANGELOG.md left for the conductor (suggested wording in the run notes). Pre-existing, not mine: `bunx tsc --noEmit` fails on `src/core/audit-workspace.ts:120` at base; `scripts/docs-verify.ts` fails on README/website version lines at base.

Follow-ups (not built): standalone `gno embed` still exits 0 when chunks fail after retry (only `gno index` treats that as a failed stage); node-llama-cpp `GetMemoryBreakdown` abort on the CUDA build (separate bug, two cores on thor).

baseline: none (spec lists no Quick commands); lint:check green; focused tests green pre-edit
gates: bun run lint:check rc=0; bun test rc=0 (4648 pass, 2 skip, 0 fail, 185s); receipt written for unittest

stage: impl-review - skipped(policy: parallel-wave - conductor owns review after integration; REVIEW_MODE=none)

Integrated onto the spec branch as 86380b79 (cherry-pick over .3).

stage: impl-review - skipped(policy: review backend none)
stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 86380b79c37e6904ac75e03d474202161c12daee
- Tests: bun run lint:check, bun test, bun test test/cli/index-resume.test.ts test/cli/index-cmd.test.ts test/embed/stage-state.test.ts test/spec/schemas/index-receipt.test.ts, live: bun src/index.ts index --offline on temp home with real Qwen3-Embedding-0.6B (800 docs): run 1 aborted natively (SIGABRT, core 4049676), rerun printed resume preamble and embedded 800/800 without rework, third run receipt clean, baseline: none (spec lists no Quick commands); bun run lint:check green pre-edit; focused index/embed tests green pre-edit, integrated: bun test test/cli/index-resume.test.ts test/cli/index-cmd.test.ts test/embed/stage-state.test.ts test/spec/schemas/index-receipt.test.ts test/cli/changes-follow.test.ts test/spec/schemas
- PRs: