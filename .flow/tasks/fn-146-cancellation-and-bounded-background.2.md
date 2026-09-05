---
satisfies: [R1, R6]
---
# fn-146-cancellation-and-bounded-background.2 Propagate cancellation through transports and pipeline

## Description
Propagate cancellation through transports and pipeline. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/serve/server.ts, src/pipeline/expansion.ts, src/llm/native-worker/, src/llm/nodeLlamaCpp/generation.ts, src/mcp/, src/llm/http*.ts, test/serve/native-cancellation.test.ts (new)
**Touches:** [src/serve/server.ts, src/pipeline/expansion.ts, src/llm/native-worker/, src/llm/nodeLlamaCpp/generation.ts, src/mcp/, src/llm/http*.ts, test/serve/native-cancellation.test.ts]

### Approach

- Carry admitted REST signal through query/Ask and expansion; propagate MCP client/job cancellation and SDK caller abort into worker and remote HTTP requests.
- Remove Promise.race-only timeout abandonment. Cancel queued work immediately; cooperative generation aborts natively; noncooperative embed/rank remains leased until settlement or owner-controlled retirement.
- Quarantine a stuck owner from new admissions; only retire when no unrelated active operation can be harmed. Queued requests keep their own deadlines and identity; never replay a failed write or native request.
- Preserve diagnostic/error schemas and update corresponding API/MCP/SDK prose with the behavior change.

### Investigation targets

**Required:**
- `src/serve/server.ts:1137`
- `src/pipeline/expansion.ts:477`
- `src/llm/nodeLlamaCpp/generation.ts`
- `src/serve/resident-request.ts`
- `test/serve/resident-request.test.ts:73`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/serve/native-cancellation.test.ts test/serve/resident-request.test.ts test/llm/inference-cancellation-contract.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Abort before load, during generation/ranking and before response suppresses late publication while capacity reflects actual native work.
- [ ] MCP disconnect and REST abort leave no orphaned request; HTTP adapter cancellation remains HTTP-native.
- [ ] A canceled request cannot clear another caller lease or return successful partial results.

## Done summary
Implemented and accepted cancellation propagation across SDK, REST, MCP, nested retrieval/Ask, remote HTTP fetch/body, and native IPC. Caller completion is separate from actual native capacity/lease settlement; accepted jobs retain independent lifetimes. Focused task gates, typecheck and owned lint/format pass.

Actual CUDA package a30da442 (SHA592c38574b9b88d4da3488256b49d7421c2f2f44223090d5cd98e78736cdebc0), helper8b45a54d: pre-aborted query sent no native request; queued request12 never reached child while unrelated request11 completed its historical exact score. Active rerank/generation cancelled once, retained busy/native-owned/quarantined state, and settled later (dispatcher445ms/31ms after abort). Four recovery queries preserve full results, payload except diagnostic timing, and complete native inputs/outputs, with vector/rerank stages active. All three observed owned PIDs absent.

Evidence: .flow/artifacts/fn-146-cancellation-and-bounded-background/task2-gates/ and capture helper gate directories; native-cancellation/ retains both failed instrumentation strata and successful js-evaluate stratum. Current raw successful analysis: /home/gordon/.cache/agent-tmp/gno-fn146-native-cancellation-js-evaluate/analysis.json. JavaScript evaluation-boundary timing is not a CUDA kernel timestamp. Live complete API/MCP/background/shutdown plus Metal acceptance remains task5; task3 scheduling/model leases and task4 finite shutdown are separate dependencies. No full project or final combined native readiness claim from this task.
## Evidence
- Commits: a30da4423ec5604f46d2b050af8a2cba51c66e07, 9814b800097c89e1a9085eb51fc5e91c2a06b2c4, 8b45a54d9fab684fddb69175e8c836dad4b935b2
- Tests: bun test test/serve/native-cancellation.test.ts test/serve/resident-request.test.ts test/llm/inference-cancellation-contract.test.ts — 31 pass; notes/fn146.2-quick.log, bun test test/serve/inference-transport-cancellation.test.ts test/llm/native-load-settlement.test.ts test/llm/http-cancellation-body.test.ts test/llm/native-worker-protocol.test.ts test/llm/native-worker-lifecycle.test.ts test/llm/native-worker-ports.test.ts test/llm/node-rerank-context-size.test.ts test/llm/node-generation-structured.test.ts test/llm/node-generation-context-size.test.ts test/llm/lifecycle.test.ts test/llm/httpGeneration.test.ts test/embed/batch.test.ts test/embed/backlog.test.ts test/embed/variant-backlog.test.ts test/core/job-manager-egress-epoch.test.ts test/sdk/client.test.ts test/mcp/http-transport.test.ts test/mcp/http-parity.test.ts test/mcp/tool-profile.test.ts test/mcp/tools/query.test.ts test/mcp/tools/ask.test.ts test/pipeline/expansion-guardrails.test.ts — 170 pass; notes/fn146.2-regressions-final.log, bun test test/serve/native-cancellation.test.ts test/serve/resident-request.test.ts test/llm/inference-cancellation-contract.test.ts test/llm/lifecycle.test.ts test/llm/native-load-settlement.test.ts — 33 pass; notes/fn146.2-verify.log, bun test test/serve/inference-transport-cancellation.test.ts test/serve/native-cancellation.test.ts test/llm/http-cancellation-body.test.ts — 24 pass; notes/fn146.2-scope-final.log, bun run typecheck — pass; notes/fn146.2-typecheck.log, rg '\.ts$' notes/fn146.2-owned-files.txt | xargs bunx oxlint --type-aware --type-check — pass; notes/fn146.2-lint.log, xargs bunx oxfmt --check < notes/fn146.2-owned-files.txt — pass, git diff --check — pass, Actual CUDA js-evaluate cancellation stratum: pre-aborted, queued, active rerank/generation; four exact full recovery result/native-input-output comparisons; actual settlement retained, all owned PIDs absent, TMPDIR=/home/gordon/.cache/agent-tmp bun test test/eval/acceptance/child-capture.test.ts test/eval/acceptance/adapters.test.ts — 47 pass, 198 assertions; notes/fn146.2-context-signal-test.log
- PRs: