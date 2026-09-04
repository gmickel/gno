---
satisfies: [R1, R4]
---
# fn-145-token-sized-reranker-contexts-with.2 Use sized contexts with safe growth and shrink

## Description
Use sized contexts with safe growth and shrink. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/llm/nodeLlamaCpp/rerank.ts, src/llm/nodeLlamaCpp/rerank-capacity.ts (new), test/llm/node-rerank-context-size.test.ts (new), docs/HOW-SEARCH-WORKS.md, docs/ARCHITECTURE.md
**Touches:** [src/llm/nodeLlamaCpp/rerank.ts, src/llm/nodeLlamaCpp/rerank-capacity.ts, test/llm/node-rerank-context-size.test.ts, docs/HOW-SEARCH-WORKS.md, docs/ARCHITECTURE.md]

### Approach

- Choose one compatible context for the current model-generation/configuration/capacity bucket; replace only when idle when bucket changes, including shrink after large requests.
- Do not build a second worker owner. If fn-144 is already integrated, execute inside its native child; otherwise keep the sizing port compatible for that integration.
- Preserve all candidate indices, duplicate score mapping and ties; fail/fallback explicitly at capacity boundaries. Couple resource-policy prose to the code change.

### Investigation targets

**Required:**
- `src/llm/nodeLlamaCpp/rerank.ts:64`
- `src/llm/nodeLlamaCpp/lifecycle.ts`
- `src/pipeline/rerank.ts:108`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/llm/node-rerank-context-size.test.ts test/pipeline/rerank-normalization.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Short→long→short test releases oversized context and retains identical scores and ordering.
- [ ] Concurrent different sizes, model expiry and failure cannot use disposed contexts or omit candidates.
- [ ] No allocation on empty list; no silent extra truncation for unsupported/over-limit input.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
