---
satisfies: [R3, R5, R7]
---
# fn-144-native-recovery-and-idle-inference.6 Finalize idle policy documentation and driven QA

## Description
Finalize idle policy documentation and driven QA. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** docs/ARCHITECTURE.md, docs/CONFIGURATION.md, docs/DAEMON.md, docs/TROUBLESHOOTING.md, docs/SDK.md, ../gno.sh/src/lib/gno-docs.tsx, .flow/artifacts/fn-144-native-recovery-and-idle-inference/
**Touches:** [docs/ARCHITECTURE.md, docs/CONFIGURATION.md, docs/DAEMON.md, docs/TROUBLESHOOTING.md, docs/SDK.md, ../gno.sh/src/lib/gno-docs.tsx, .flow/artifacts/fn-144-native-recovery-and-idle-inference/]

### Approach

- Reconcile documentation already coupled to implementation: lazy startup, five-minute grace, process versus model accounting, parent/child lifetime, stable failure handling and measured first-next-query cost.
- Do not add an aggressive TTL profile by default; expose a shorter policy only if existing config supports it and QA measures it. No universal memory-saving number or full-query latency promise.
- Run final QA over actual CLI, stdio/resident MCP, REST and relevant web UI states. Update hosted pages where behavior text changed and drive local pages including mobile/code-copy. Preserve missing native acceptance as unmet.

### Investigation targets

**Required:**
- `docs/ARCHITECTURE.md:288`
- `docs/CONFIGURATION.md:1000`
- `docs/TROUBLESHOOTING.md:746`
- `docs/SDK.md:583`
- `scripts/package-smoke-resident.ts:425`

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
- [ ] Full lint/typecheck/tests/docs gates pass once; hosted check/typecheck/build and driven changed pages pass if edited.
- [ ] Retained Metal symptom/fix guidance fulfills successor R7; no claim that isolation alone fixed the assertion.
- [ ] Final receipts list fixture/model/runtime identities, raw measurements and residual limits; production deployment stays separately authorized.

## Done summary
Reconciled lazy startup, five-minute idle grace, process/model accounting, recovery limits, simulator lifetime guard and first-next-query cost in architecture/configuration/daemon/SDK/troubleshooting docs. Captured CLI, stdio/resident MCP and REST native behavior plus shared web UI startup/filter/poll states support scoped QA; original physical Metal3/3 retained independently of containment. Full current lint/typecheck/tests/docs and packed install smoke pass, including unchanged real-GNO sentinel. Hosted documentation is explicitly deferred to the post-PR queue by user. Additional SSH-blocked Metal comparisons remain later aggregate QA limits, not fabricated successes; no production deployment authorized.
## Evidence
- Commits: d4266578, 017513d2, 9d0b57e3, 80b3cc8e, f62e6438, 16d533db
- Tests: bun test:5150pass2skip0fail41177assertions603files, bun run lint:check, bun run typecheck, bun run docs:verify:15pass0fail2skip, TMPDIR=/home/gordon/.cache/agent-tmp bun run test:package:PASS, actual native CUDA and physical Ivan receipts under fn144 artifacts, actual shared web UI desktop/mobile startup/filter/polling evidence under fn148/fn151/fn152
- PRs: