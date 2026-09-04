---
satisfies: [R2, R3, R4]
---
# fn-149-request-local-retrieval-hydration-reuse.4 Carry ownership through Ask and prove complete request parity

## Description
Carry ownership through Ask and prove complete request parity. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/pipeline/answer.ts, src/cli/commands/ask.ts, src/sdk/client.ts, test/pipeline/hydration.test.ts (new), docs/ARCHITECTURE.md, ../gno.sh/src/lib/gno-docs.tsx, .flow/artifacts/fn-149-request-local-retrieval-hydration-reuse/
**Touches:** [src/pipeline/answer.ts, src/cli/commands/ask.ts, src/sdk/client.ts, test/pipeline/hydration.test.ts, docs/ARCHITECTURE.md, ../gno.sh/src/lib/gno-docs.tsx, .flow/artifacts/fn-149-request-local-retrieval-hydration-reuse/]

### Approach

- Explicitly carry the same request owner from CLI/SDK Ask retrieval into answer generation and verification, without skipping source-content hash checks.
- Test sequential requests across edits, duplicate titles, missing content and abort while a downstream stage is active; never cache stale failure beyond request.
- Run fn-143 complete request/model-input comparisons and read/byte/memory measurements across lexical/vector/hybrid/rerank/Ask. Reconcile docs, full gates and changed hosted-page QA.

### Investigation targets

**Required:**
- `src/pipeline/answer.ts:511`
- `src/cli/commands/ask.ts:313`
- `src/sdk/client.ts:987`
- `src/store/content-batch.ts:9`
- `test/core/context-evidence-provenance.test.ts`
- `test/eval/agentic/verified-ask-outcome.test.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/pipeline/hydration.test.ts test/core/context-evidence-provenance.test.ts test/eval/agentic/verified-ask-outcome.test.ts
bun run lint:check
bun run typecheck
bun test
bun run docs:verify
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Actual Ask cited spans/provenance/hashes and model input equal the pinned baseline, including verification failures.
- [ ] Separate requests observe edits and release retained memory after settle.
- [ ] Measured plain-path row reduction and full-path reuse are reported separately; no candidate reduction masquerades as allocation saving.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
