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
Blocked:
Physical Metal R3 allocation control remains incomplete. Prior auto-sized40,960 context runs stopped under memory pressure before cold/warm scoring and recorded no native allocation-byte counters. The read-only Ivan snapshot2026-09-05T06:26:20–25Z found16GiB physical RAM,1.73–1.77GiB free and4004.31MiB swap used; no materially new safe-fit condition was established. The actual native context+compute counter is identified and a pinned conditional control plan is retained in .flow/artifacts/fn-145-token-sized-reranker-contexts-with/allocation-feasibility/. A new matched CUDA control at44cf2a1d passed full input/token/score parity and measured4.3313GiB GPU context+compute reduction, with slower timings preserved, in allocation-native-cuda/. It does not satisfy the physical Metal requirement. Resume only after measured safe Metal headroom supports the unchanged full workload and existing governor, or an explicit user scope decision. No thresholds, inputs, precision or baseline rows changed to force acceptance. All other aggregate work continues; draft PR will expose this item.
## Evidence
- Commits:
- Tests:
- PRs:
