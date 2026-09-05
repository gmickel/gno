---
satisfies: [R1, R2, R6]
---
# fn-143-paired-retrieval-quality-and-resource.3 Add cached-model retrieval and verified-answer adapters

## Description
Add cached-model retrieval and verified-answer adapters. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** evals/acceptance/native-adapter.ts (new), evals/acceptance/surface-adapter.ts (new), test/eval/acceptance/adapters.test.ts (new)
**Touches:** [evals/acceptance/native-adapter.ts, evals/acceptance/surface-adapter.ts, test/eval/acceptance/adapters.test.ts]

### Approach

- Reuse native pipeline wiring while explicitly disabling downloads and model substitution; the candidate benchmark permits downloads and must not be invoked unchanged.
- Capture actual embedding/reranking/hybrid and verified Ask inputs/outputs via SDK and owned public surfaces. Preserve caller/model identity and classify unavailable native capability as incomplete.
- Support a record/replay deterministic adapter for comparator unit tests; actual native acceptance must carry a real-model receipt, never a replay receipt.

### Investigation targets

**Required:**
- `evals/helpers/retrieval-candidate-benchmark.ts:24`
- `evals/agentic/verified-ask-contract.ts`
- `evals/agentic/verified-ask-outcome.ts`
- `src/sdk/client.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/eval/acceptance/adapters.test.ts test/eval/agentic/verified-ask-outcome.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Missing cached model, unavailable Metal/CUDA and skipped verification produce incomplete coverage, not PASS.
- [ ] Actual model inputs and cited evidence survive record serialization unchanged; remote or paid judge is not required.

## Done summary
Implemented cached-only native SDK and owned CLI/MCP/API adapters, with exact port arguments, post-truncation embedding-context inputs, model outputs, verified model hashes, actual backend detection, evidence/citation projection, explicit incomplete coverage, replay separation and restored exclusive process instrumentation. Retained SDK sessions support later warm/idle measurement; one-shot convenience and surface adapter calls create fresh clients/processes.

Baseline: green; focused command ran before edits (existing verified-Ask tests). Final focused command: 16 tests passed, 76 assertions. Focused TypeScript compile passed. Targeted repository-equivalent lint passed with 12 intentional unbound-method warnings from prototype interception/identity assertions. New files formatted. Host owns docs, commit and Flow lifecycle under shared-checkout override.

Native smoke: notes/fn143-native-tmp/adapter-smoke.json and adapter-smoke.log retain full compact data: CUDA observed, model hashes verified, 213 actual input events including native embedding inputs, 3 ordered reranked results. Coverage INCOMPLETE because fixture config did not enable independent vector-stage trace; vectorsUsed:true was correctly insufficient. This is one separately declared bounded no-expansion smoke, never a pass for the original expanded workload. Earlier tokenizer-mismatch receipt: /tmp/fn143-adapters-native-smoke-initial-tokenizer-mismatch.json. /tmp/fn143-adapters-native-smoke.json is TRUNCATED/UNUSABLE following EDQUOT at evidence write; preserve it as failed capture. No GPU workload remains.

Integration contract for fn-143.4/.5:
- createNativeAcceptanceSession(manifest, init) returns run(request, {prepareEmbeddings?}) and close(); keep one session for warm/post-idle strata. Calls cannot overlap. runNativeAcceptance is fresh-client convenience.
- Enable retrievalTraces explicitly in synthetic config (metadata mode with normal retention). Current SDK decorator drops the internal hybrid capability symbol when trace is disabled; public outputs also omit it. Missing independent capability receipt is incomplete. Do not infer native coverage from vectorsUsed.
- SurfaceLaunch.cwd is the selected product source snapshot. Copy native-capture.ts into that root at evals/acceptance/native-capture.ts BEFORE launch; preload resolves there, so baseline captures baseline classes. For SDK execution copy native-adapter.ts, native-capture.ts, manifest.ts and records.ts into the chosen source snapshot and execute there (canonical helper already exists). Never relabel current candidate execution as baseline.
- SurfaceLaunch requires isolated GNO_CONFIG_DIR/GNO_DATA_DIR/GNO_CACHE_DIR, unique capturePath and an owned process. API must bind unused loopback endpoint; an already responding endpoint is rejected. Surfaces are one-shot; a reusable owned-server driver for resident public-surface strata belongs to .4 if needed.
- GGUF tokenizerSha256 is the containing-artifact identity: equal verified whole GGUF SHA256. Unequal/external-tokenizer pins are unsupported and fail closed; no isolated tokenizer extraction is claimed.
- Full raw result provenance is retained, including absPath. Paired independent roots need a predeclared root mapping or same read-only source corpus; never silently remove provenance. Raw model hashes are checked during captured calls, so performance harness must account for capture overhead/preflight.
- ModelCache policy is forced offline:true,allowDownload:false; unknown/mismatched model IDs/hashes cannot substitute. Both generation roles (expansion and answer models) are supported by role+id manifest identities.

stage: impl-review - skipped(config: user requested no implementation reviews)
## Evidence
- Commits:
- Tests: baseline: green, bun test test/eval/acceptance/adapters.test.ts test/eval/agentic/verified-ask-outcome.test.ts (16 pass, 76 assertions), bunx tsc -p /tmp/fn143-adapters-tsconfig.json (pass), bunx oxlint -c /tmp/fn143-adapters-oxlint.json --type-aware --type-check evals/acceptance/native-adapter.ts evals/acceptance/native-capture.ts evals/acceptance/surface-adapter.ts test/eval/acceptance/adapters.test.ts (0 errors; intentional unbound-method warnings), Native CUDA bounded smoke: notes/fn143-native-tmp/adapter-smoke.json (incomplete: vector_stage_unavailable)
- PRs: