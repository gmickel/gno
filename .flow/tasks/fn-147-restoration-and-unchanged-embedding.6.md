---
satisfies: [R1, R2, R3, R4, R5, R6]
---
# fn-147-restoration-and-unchanged-embedding.6 Prove migration and ingestion parity through public surfaces

## Description
Prove migration and ingestion parity through public surfaces. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** docs/ARCHITECTURE.md, docs/CLI.md, docs/API.md, ../gno.sh/src/lib/gno-docs.tsx, .flow/artifacts/fn-147-restoration-and-unchanged-embedding/
**Touches:** [docs/ARCHITECTURE.md, docs/CLI.md, docs/API.md, ../gno.sh/src/lib/gno-docs.tsx, .flow/artifacts/fn-147-restoration-and-unchanged-embedding/]

### Approach

- Drive source sync, keyword/semantic query and changes consumers over the full mutation matrix, comparing migrated and freshly rebuilt isolated indexes.
- Record vector identity/coverage and model-call counts; test interrupted migration, retry and removal of one shared owner without touching private vault indexes.
- Reconcile storage/freshness documentation, restored-file guidance and hosted memory/knowledge-delta pages; full gates and live changed-page QA.

### Investigation targets

**Required:**
- `docs/ARCHITECTURE.md:98`
- `docs/CLI.md:858`
- `docs/API.md:2119`
- `docs/MEMORY.md:436`
- `integrations/openclaw-gno-memory/README.md:120`

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
bun run eval:memory
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Every declared mutation matches clean-rebuild semantic evidence and intended journal transitions.
- [ ] Migration leaves no false semantic freshness or wrong-title ownership; remaining recomputation is observable and resumable.
- [ ] No work is added to superseded fn-138; all inherited acceptance is proven within this successor.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
