---
satisfies: [R4, R5]
---
# fn-148-eligible-candidates-before-retrieval.4 Measure filtered scaling and drive cross-surface QA

## Description
Measure filtered scaling and drive cross-surface QA. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** docs/API.md, docs/SDK.md, docs/HOW-SEARCH-WORKS.md, assets/skill/SKILL.md, ../gno.sh/src/lib/gno-docs.tsx, .flow/artifacts/fn-148-eligible-candidates-before-retrieval/
**Touches:** [docs/API.md, docs/SDK.md, docs/HOW-SEARCH-WORKS.md, assets/skill/SKILL.md, ../gno.sh/src/lib/gno-docs.tsx, .flow/artifacts/fn-148-eligible-candidates-before-retrieval/]

### Approach

- Measure selective/broad workloads over pinned increasing corpus sizes and concurrent reads; retain synchronous stall/tail latency evidence and exact eligible output comparisons.
- Drive supported CLI/MCP/API/UI filters including valid zero and invalid inputs, preserving scopes. Run required GNO skill eval for changed CLI/MCP behavior and adjust skill only if necessary.
- Reconcile docs and hosted filter guidance, full gates and driven changed-page/mobile/code-copy QA.

### Investigation targets

**Required:**
- `docs/API.md:2732`
- `docs/SDK.md:113`
- `docs/HOW-SEARCH-WORKS.md:215`
- `assets/skill/SKILL.md:168`
- `test/pipeline/search-quality.test.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/pipeline/search-quality.test.ts test/pipeline/hybrid-intent.test.ts
bun run lint:check
bun run typecheck
bun test
bun run docs:verify
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] No unintended quality loss, scope widening or hidden vector failure; expensive cases remain visible in paired reports.
- [ ] Product guidance describes eligible-domain limits without claiming unrelated recall-language work fixed.
- [ ] Full gates and applicable skill eval complete; unresolved cost/physical acceptance is explicit unmet evidence.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
