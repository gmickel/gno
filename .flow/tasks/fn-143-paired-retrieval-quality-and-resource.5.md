---
satisfies: [R1, R2, R3, R4, R5, R6]
---
# fn-143-paired-retrieval-quality-and-resource.5 Wire acceptance command and prove live coverage

## Description
Wire acceptance command and prove live coverage. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** scripts/retrieval-acceptance.ts (new), package.json, evals/README.md, test/eval/acceptance/command.test.ts (new), .flow/artifacts/fn-143-paired-retrieval-quality-and-resource/
**Touches:** [scripts/retrieval-acceptance.ts, package.json, evals/README.md, test/eval/acceptance/command.test.ts, .flow/artifacts/fn-143-paired-retrieval-quality-and-resource/]

### Approach

- Expose a development-only eval:acceptance command with explicit fixture, baseline/candidate and native opt-in arguments; do not register a public GNO command or automatic heavy CI suite.
- Document baseline creation, comparison, identity changes and incomplete platform coverage. Existing eval:memory remains threshold100 and hybrid/vsearch remain clearly lexical baselines.
- Execute unchanged-vs-unchanged and negative controls over real CLI, stdio/resident MCP and REST using owned state; capture CUDA and physical Ivan evidence. Preserve failing/incomplete rows without lowering thresholds.

### Investigation targets

**Required:**
- `evals/README.md:43`
- `scripts/package-smoke-mcp.ts:32`
- `scripts/package-smoke-resident.ts:425`
- `scripts/update-eval-scores.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/eval/acceptance
bun run eval:memory
bun --bun evalite evals/hybrid.eval.ts
bun --bun evalite evals/vsearch.eval.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Command parser tests reject invalid/mismatched manifests and preserve native opt-in.
- [ ] Live receipts identify installed/source artifact and include actual semantic responses on both native platforms; missing hardware stays unmet.
- [ ] Run full repo gates once after focused checks; documents explain complete cold cost and equality policy.

## Done summary
# fn143.5 completion handover

Completed acceptance command wiring and curated physical harness evidence for unchanged archived-source CUDA and Metal controls. Command preflights archive bytes/links, exact pinned requests/fixtures/models and isolated roots. Actual SDK, CLI, stdio MCP, resident MCP and REST responses are captured; deterministic comparison and negative controls reject unexplained changes. Actual verified generation and semantic-judge calls exercised on both platforms.

Harness scope complete. Original native readiness remains HOLD / NEEDS_WORK: default Metal rerank and expanded workloads hit resource limits; Metal CLI and repeated native sessions crash; CUDA expanded generation returns incomplete JSON. Warm30 reports correctly remain incomplete with no performance summaries. Small lifecycle screens are explicitly inconclusive, retaining all failed rows. No native-fix claim.

Validation: full suite4844pass/2existing skips/0fail/36959assertions; lint0errors/15warnings and format clean; corrected docs15pass/0fail/2uncached-model skips; memory100%; existing lexical hybrid86%,vsearch88%. Implementation commits `a1a7417f`, `b50bf6cc`.

Curated handover: `.flow/artifacts/fn-143-paired-retrieval-quality-and-resource/README.md`, manifest/checksum files, compact raw pairs, full compressed reports and gate logs. All original raw evidence remains under `notes/fn143-native-tmp/`; historical baseline snapshots stay unchanged. No native workload, Git or Flow operation performed during curation.
## Evidence
- Commits: a1a7417f, b50bf6cc
- Tests: Full tests: 4844 pass, 2 existing skips, 0 fail, 36959 assertions; notes/fn143-native-tmp/full-tests-owned.log, Full lint and format: 0 errors, 15 warnings; notes/fn143-native-tmp/full-lint-settled.log, Public-truth docs: 15 pass, 0 fail, 2 uncached-model skips; /tmp/fn143-publictruth-docs.log, Memory gate: 100%; /tmp/fn143-prerequisite-memory.log, Existing lexical hybrid: 86%; /tmp/gno-fn143-baseline-hybrid.log, Existing lexical vsearch: 88%; /tmp/gno-fn143-baseline-vsearch.log, Physical unchanged-source CUDA and Metal controls, actual semantic-judge pairs and negative controls captured; warm30 incomplete, no performance claims
- PRs: