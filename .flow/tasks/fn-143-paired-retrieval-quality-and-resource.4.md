---
satisfies: [R3, R4]
---
# fn-143-paired-retrieval-quality-and-resource.4 Implement paired lifecycle timing and resource sampling

## Description
Implement paired lifecycle timing and resource sampling. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** evals/acceptance/runner.ts (new), evals/acceptance/resources.ts (new), evals/acceptance/report.ts (new), test/eval/acceptance/runner.test.ts (new)
**Touches:** [evals/acceptance/runner.ts, evals/acceptance/resources.ts, evals/acceptance/report.ts, test/eval/acceptance/runner.test.ts]

### Approach

- Run fresh-process, resident-model-cold, warm and post-idle cases as distinct strata. Use alternated/randomized paired blocks with run order and seed recorded; serialize GPU workloads per host.
- Time the complete request including model acquisition and transport, plus stage counters; sample owned PID memory and record unrelated-host-load caveats. Do not add Metal RSS and GPU-accounted unified memory.
- Retain raw samples, sample counts, p50/p95/p99, slower cases and uncertainty. Default screening uses at least 30 paired observations per selected stratum; any claimed p99 needs at least 100 observations and remains labeled empirical. Cold physical acceptance may be smaller but must not claim a stable p99.

### Investigation targets

**Required:**
- `evals/agentic/runner.ts:92`
- `evals/agentic/types.ts:266`
- `scripts/package-smoke-isolation.ts:158`
- `scripts/package-smoke-resident.ts:425`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/eval/acceptance/runner.test.ts test/eval/agentic/runner.test.ts test/eval/agentic/runner-boundaries.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Clock/resource sampling failures and insufficient samples yield explicit incomplete/inconclusive fields.
- [ ] Empty-answer or hidden-fallback speedups fail the comparator before performance summaries.
- [ ] Owned children stop on success/failure; no long native waits or telemetry collection touches production services.

## Done summary
Implemented paired lifecycle timing, resource sampling and quality-gated statistical reports. Fresh-process measurements include owned process acquisition/preflight; resident-model-cold excludes process startup but requires observed unloaded native models; warm and post-idle retain the same process for primer and measured request. Unknown/false model state, resource/clock failures, invalid outputs, missing samples and noisy observations never produce a passing performance claim.

Runner integration:
- runPairedAcceptance({baseline,candidate,factories,strata,observations,seed,order,idleMs,timeoutMs,sampleGpu,hostLoadCaveats}) from evals/acceptance/runner.ts. Defaults: 30 pairs per selected case/state; alternating seeded blocks; 60s observation deadline; 100ms sampler. A post-idle duration must fit observation timeout. Each state/case/side gets its own process; warm/post-idle retain it for primer and measured request.
- factories implement AcceptanceSessionFactory.open(OwnedResources); register Bun subprocess immediately via scope.own(child), before readiness. Returned session exposes processId, optional processIdentity, observed modelState(), run(caseId), close(). All owned child handles stop on success/error/timeout; late registrations after cancellation are killed. See driver handover for real native factory.
- Optional pinned cases[].configuration.primerCaseId selects another existing manifest case for novel warm/post-idle requests. Default is the same repeated query. Both manifests must predeclare identical settings.
- Optional pinned cases[].configuration.backgroundCaseId runs that existing case in a second owned session concurrently with foreground. Both PIDs sampled. Positive observed request overlap required; background full record compared exactly, with bad outputs/fallbacks rejected. Report labels two-owned-sessions: this is controlled native contention, not same-resident scheduler fairness (fn146 supplies that later). Background session startup excluded from foreground fresh timer; foreground acquisition still fully included.
- Run samples retain records, order, PID/source snapshot/raw evidence directory, total duration, acquisition/preparation/request durations and optional adapter stages, before/after idle resources, model state, explicit errors/caveats and overlap receipt. No load/capture/transport time is subtracted from request durations.
- Reports validate comparator before publishing statistics. Raw samples and slower block IDs retained. Fewer than 30 paired observations per case/state is inconclusive; p99 null below 100, then labeled empirical. p95 greater than twice max(1ms,p50) marks a noisy screen. These are screening rules, never a universal regression allowance or proof of equivalence. Explicit reported host-load caveats also make the screen inconclusive.
- Owned RSS via bounded ps; optional NVIDIA PID GPU accounting via bounded nvidia-smi. Successful GPU accounting without an owned row reports zero. Counters never added; Metal GPU counter remains null rather than inventing unified-memory accounting. Sampling can miss peaks, and unrelated host load is not measured or inferred away. In-process runner concurrency is refused; host must serialize independent processes/GPU QA except the one deliberate overlap workload.

Validation: pre-edit baseline existing runner suites green (22 tests, 86 assertions). Final focused task+driver+existing runner command green (36 tests, 150 assertions); focused TypeScript compilation green; formatting green; four-file repository-equivalent 105-rule lint green (0 warnings/errors). Standard repo config ignores evals, so supplementary config retains repo rules and removes only ignorePatterns. Resolving normally unresolved Ultracite package extends instead enabled a different 553-rule policy and was not adopted. No GPU/native semantic pass is claimed from these tests.

Companion support handover: /tmp/fn143.4-driver-summary.md and /tmp/fn143.4-driver-evidence.json. Native physical QA, documentation reconciliation, full repository gates, staging/commit and Flow state belong to host. All runner-owned changes remain uncommitted under explicit shared-checkout override.

stage: impl-review - skipped(config: user requested no implementation reviews)
## Evidence
- Commits:
- Tests: baseline: green - bun test test/eval/agentic/runner.test.ts test/eval/agentic/runner-boundaries.test.ts (22 pass), bun test test/eval/acceptance/runner.test.ts test/eval/acceptance/session-driver.test.ts test/eval/agentic/runner.test.ts test/eval/agentic/runner-boundaries.test.ts (36 pass, 150 assertions), bunx tsc --noEmit --skipLibCheck --target esnext --module preserve --moduleResolution bundler --types bun evals/acceptance/runner.ts evals/acceptance/resources.ts evals/acceptance/report.ts test/eval/acceptance/runner.test.ts, bunx oxfmt --check evals/acceptance/runner.ts evals/acceptance/resources.ts evals/acceptance/report.ts test/eval/acceptance/runner.test.ts, bunx oxlint --config /tmp/fn143.4-oxlint.json --type-aware --type-check /home/gordon/work/gno/evals/acceptance/runner.ts /home/gordon/work/gno/evals/acceptance/resources.ts /home/gordon/work/gno/evals/acceptance/report.ts /home/gordon/work/gno/test/eval/acceptance/runner.test.ts
- PRs: