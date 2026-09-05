---
satisfies: [R1, R2, R3, R4, R5]
---
# fn-147-restoration-and-unchanged-embedding.1 Freeze restoration and title-variant identity oracles

## Description
Freeze restoration and title-variant identity oracles. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** evals/fixtures/acceptance/ingestion-identity/ (new), test/ingestion/embedding-identity.test.ts (new), test/changes/restoration.test.ts (new)
**Touches:** [evals/fixtures/acceptance/ingestion-identity/, test/ingestion/embedding-identity.test.ts, test/changes/restoration.test.ts]

### Approach

- Promote actual-store audit matrix with same-title duplicate, whitespace-equivalent edit, Alpha/Beta title variants in both ingestion orders, delete/restore/rename and model changes.
- Freeze canonical source/chunk outputs and exact formatted embedding inputs independently. Require clean-rebuild equality after each mutation plus embedding call counts.
- Pin document+chunk+model ownership of input variants; a mirror hash alone is not sufficient. Legacy vectors with unprovable originating input must remain pending, never blessed fresh.

### Investigation targets

**Required:**
- `src/pipeline/contextual.ts:24`
- `src/embed/fingerprint.ts:21`
- `src/store/vector/stats.ts:124`
- `spec/db/schema.sql:215`
- `test/ingestion/sync-incremental.test.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/ingestion/embedding-identity.test.ts test/changes/restoration.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Fixture demonstrates coexisting distinct title inputs under one mirror without changing title formatting.
- [ ] Repeated unchanged/restored cycles have explicit expected event and model-call counts.
- [ ] Oracle distinguishes valid shared-input reuse from wrong-title reuse and detects both missing vectors and stale vectors.

## Done summary
# fn-147.1 implementation handover

Status: in_progress; host owns Flow, Git and QA. No production edits, commits, bridges, review, native models or live indexes.

Created separately pinned ingestion-identity-v1 oracle with literal canonical chunks and exact formatted inputs, owner-specific model/input evidence, fn-143 paired comparison, actual sync/SQLite/backlog/journal operations, and clean rebuild controls. New scenario hash: aad6f6e9e4c8052075e13ba9a7801e5e0129c9724aaaecd47daf750f1f53fd99. Frozen fn-143 fixtures and pins unchanged.

Baseline: green; existing sync-incremental tests passed before edits. New deliverable tests did not exist before implementation.

Verification: 9 tests passed, 72 assertions. Targeted Oxlint type-aware/type-check passed (2 test files, helper included through imports); separate targeted tsc project including both tests and their dependency graph passed. Formatting passed on all five files. Logs: /home/gordon/.cache/agent-tmp/gno-fn147-oracle/.

Observed gaps, explicitly passing characterization rather than repaired behavior:
- Same-body Alpha/Beta in either order uses only first-owner title; incremental and clean rebuild both fail independent two-owner oracle.
- Same-title duplicate and whitespace edit remove previously valid vectors and require one unnecessary embedding input; repaired vectors match clean rebuild afterward.
- Repeated identical restoration stays inactive, omits reactivation events and differs from clean rebuild. Repeated no-op sync adds no false events.

Controls: content/model changes and rename recompute correctly; full sync rename journals create/create/inactivate. New-owner SQLite write abort reports error with no phantom journal event and preserves existing vectors. Negative controls reject missing, wrong-title, stale-content, wrong-model and unproven-input vectors.

Limitations: deterministic stand-in counts individual backlog inputs, not native calls. SQL vector persistence does not exercise production embedBacklog retry or native search. Full restoration change-consumer/semantic-output QA and mid-update rollback remain dependent-task work. No parent R1-R5 completion claim.

Initial fixture authoring corrected terminal newlines and rename event expectations from actual observed behavior before final pin; no prior baseline was refreshed. Relative-path --no-ignore Oxlint attempt hit tsgolint path panic; absolute default-repo invocation passed. An exploratory external lint config lacked repository path overrides; discarded in favor of canonical project config and targeted tsc.

stage: impl-review - skipped(policy: user disabled formal reviews; host owns acceptance)
## Evidence
- Commits: 744e022802ef097e4f2c71bf7bc0f4a3c56f33be
- Tests: TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn147-oracle bun test ./test/ingestion/sync-incremental.test.ts (baseline green), TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn147-oracle bun test ./test/ingestion/embedding-identity.test.ts ./test/changes/restoration.test.ts (9 pass, 0 fail, 72 assertions), bunx oxlint --type-aware --type-check /home/gordon/work/gno/test/ingestion/embedding-identity.test.ts /home/gordon/work/gno/test/changes/restoration.test.ts (pass), bunx tsc --noEmit --project /home/gordon/.cache/agent-tmp/gno-fn147-oracle/tsconfig.json (pass), bunx oxfmt --check [five owned files] (pass)
- PRs: