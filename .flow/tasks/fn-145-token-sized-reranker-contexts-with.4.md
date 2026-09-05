---
satisfies: [R3, R5]
---
# fn-145-token-sized-reranker-contexts-with.4 Measure physical resource gains and publish accurate guidance

## Description
Measure physical resource gains and publish accurate guidance. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** docs/HOW-SEARCH-WORKS.md, docs/TROUBLESHOOTING.md, ../gno.sh/src/lib/gno-docs.tsx, .flow/artifacts/fn-145-token-sized-reranker-contexts-with/
**Touches:** [docs/HOW-SEARCH-WORKS.md, docs/TROUBLESHOOTING.md, ../gno.sh/src/lib/gno-docs.tsx, .flow/artifacts/fn-145-token-sized-reranker-contexts-with/]

### Approach

- Run paired cached-model CUDA and physical Metal query/Ask cases, including context creation and full request time, long queries and post-idle reload.
- Reconcile sized-context guidance without promising a universal2K cap or4.2GiB saving. Drive changed hosted documentation locally.
- Serialize native QA per GPU and coordinate fn-144 native files; no product-source commit can claim the old Metal abort fixed from this spec alone.

### Investigation targets

**Required:**
- `docs/HOW-SEARCH-WORKS.md:256`
- `docs/TROUBLESHOOTING.md:863`
- `evals/README.md`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun run lint:check
bun run typecheck
bun test
bun run docs:verify
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Resource reports include raw slower samples, all parity records, model/runtime identities and platform coverage.
- [ ] Full project gates and changed-page QA pass; missing physical coverage remains incomplete.

## Done summary
Completed the missing R3 physical Metal allocation comparison on Heimdall (M4 Max, 128 GiB) using the unchanged frozen f64 GNO 2.0 package, Bun 1.3.14, node-llama-cpp 3.19.1 and the exact prior CUDA six-input fixture/model. Actual native context+compute GPU allocation fell from 5,052,291,104 to 403,691,552 bytes, a 4,648,599,552-byte reduction; CPU allocation fell by 41,156,608 bytes. All complete inputs, formatted tokens, unrounded native scores and public scores/ranks/indices match across both arms and cold/warm calls. Context disposal returned accounting to model-only. All owned processes exited; the existing live GNO process remained untouched.

Context creation was 102.43 versus 343.78 ms; cold scoring 323.01 versus 455.82 ms; warm scoring 256.78 versus 254.50 ms. The 2.28 ms slower sized warm sample remains retained. One ordered pair supports this metric/workload only, not general throughput or RSS claims. Original Ivan pressure failures and the first pre-native Heimdall Bun-shim failure remain immutable. No native retry or relaxed mid-run governor occurred.

The host independently checked all 40 compressed/raw payload hashes, reproduced analysis exactly, matched the prior CUDA fixture, revalidated all 909 package file pins, and ran four allocation-hook tests. R1/R2/R4/R5 remain supported by their separately pinned existing formatter/multilingual/public resize/reload/hybrid/Ask receipts; this new capture does not relabel those as Heimdall runs. The earlier CUDA native-byte comparison supplies the other R3 platform. User-facing core guidance already preserves exact sizing/fallback and resource tradeoffs; hosted docs and driven site QA remain explicitly delegated to gno.sh fn-3 under the requested post-PR queue.

Final local gates at32aa6d99: lint, typecheck, 5,216 tests (two existing skips, zero failures, 41,596 assertions), docs15 passed/two model-dependent skips. The test-only CI repair checks SyntaxError instead of Bun-specific wording and changes no shipped product source. Remote CI remains a separate gate.

stage: plan-review - skipped(user instruction)
stage: impl-review - skipped(user instruction)
stage: plan-sync - skipped(config: planSync.enabled != true)
Tracker sync: n/a (bridge inactive)
## Evidence
- Commits: 56ece85a4ea6020db8b2f1772846e0e7b3e7a393, 32aa6d99e22307a1ecc1ad7b41c5b4ed18891974, 95c46895
- Tests: Physical Heimdall Metal: python3 supervise.py sized then python3 supervise.py auto; both actual native arms exit0, pressure1, all owned PIDs absent, python3 /home/gordon/.cache/agent-tmp/fn145-heimdall-host-verify/analyze.py: exact six-input/token/native-score/public-rank cold/warm parity; direct allocation counters reproduced, Host verified all40 native raw/compressed hashes and all909 canonical package file pins, bun test /home/gordon/.cache/agent-tmp/fn145-heimdall-host-verify/hooks.test.ts:4 passed,21 assertions, bun run lint:check: passed at32aa6d99, bun run typecheck: passed at32aa6d99, bun test:5216 passed,2 existing skips,0 failures,41596 assertions at32aa6d99, bun run docs:verify:15 passed,2 model-dependent skips,0 failures at32aa6d99
- PRs: https://github.com/gmickel/gno/pull/217