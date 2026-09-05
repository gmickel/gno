# fn147 current closure evidence

**fn147 task 6 has sufficient mapped closure evidence. No further fn147 runtime acceptance gap identified.** Cancellation, background-load and shutdown experiments remain fn146 requirements. Hosted gno.sh reconciliation/live page QA is explicitly queued after the aggregate PR and must remain visible.

This is a bounded CPU-only evidence map, not a formal review, release-readiness verdict or Flow mutation. Only these closure notes are written. Host owns lifecycle and final acceptance.

## Requirement mapping

| Requirement | Concrete evidence | Assessment |
| --- | --- | --- |
| R1 identical restoration, active/searchable, committed event | Successful CUDA restored-1/restored-2 match clean active owners, input/vector hashes and full ordered semantic results. Current SQLite tests inject journal failure and verify rollback. | Supported |
| R2 repeated cycles, absent files, no duplicate events/work | Both absence/restoration cycles and unchanged pass captured. Committed child attribution establishes zero actual passage getEmbeddingFor calls for unchanged and both restores; query/init/dispose work is separate. | Supported |
| R3 duplicates/canonical edits preserve vectors | Native whitespace and same-title-duplicate pairs exactly equal clean builds and each makes zero original passage calls. Immutable-oracle tests verify canonical rows/vectors survive. | Supported |
| R4 changed title/text/model identity | Native Beta rename makes one new passage call; force makes three. Current tests check exact input/model/fingerprint/context/policy/dimensions and text changes. Metadata-less production rename/title update and verified variants both pass independent full owner oracle. | Supported |
| R5 consistency, rollback, retry, clean parity | All 12 new native pairs complete and exact. Real SQLite tests cover shadow close/reopen, refusal to bless legacy provenance, incomplete activation, partial retry, stale completion, write/materialization/journal rollback, vec0 repair and final-owner GC. | Supported |
| R6 accurate repaired guidance | MEMORY/OpenClaw old gap absent. CLI/API/architecture explain atomic events, verified identity and conservative legacy title invalidation without hydration or unrelated-fix claims. | Local closure supported; hosted follow-through deferred |
| Task 6 live public surfaces and actual calls | Native SDK mutation matrix has 24 children and 138 complete requests. Later packed CLI/stdio MCP/HTTP MCP/REST receipts pass all 24 full-field comparisons to retained SDK outputs with actual native stages. | Supported by complementary captures |

The task does not require the full mutation × protocol × platform Cartesian product. CUDA SDK proves mutations; actual current public-surface equality proves transport paths. The packed surface corpus is original fn143, not a claim every fn147 mutation was replayed on every protocol. No full fn147 Metal mutation matrix is claimed or introduced as a new gate. Physical no-hydration checks were conditional on changed source-reading behavior; this work did not change it.

## Primary pointers

- Successful matrix: `.flow/artifacts/fn-144-native-recovery-and-idle-inference/cuda-3d9c0ec4/`, particularly `evidence/matrix-summary.json`, `comparator-summary.json`, each `matrix-<case>.json`, and `sdk-matrix.capture.json` plus child ledgers.
- Committed attribution: `.flow/artifacts/fn-147-restoration-and-unchanged-embedding/native-call-attribution/`. Read README, report.original.md and attribution.reproduced.json. This mapping verified all **20** SHA256SUMS entries, zero mismatches, and read 24 case-side rows. No inference or attribution rewrite.
- Packed surfaces: `.flow/artifacts/fn-144-native-recovery-and-idle-inference/cuda-packed-surfaces-9d0b57e3/README.md` and `drivers/f8a278ef/cross-surface-comparison.json.gz`. Direct read: passed=true; all 24 checks true (full results, citations, model inputs, semantic state, native outputs, public results).
- Current tests: test/changes/restoration.test.ts, test/ingestion/embedding-identity.test.ts, test/embed/variant-backlog.test.ts, test/store/vector/variants.test.ts and owner-aware pipeline tests. Latest full gate includes restore/rename, partial retry, shadow resume, partition identity and final-owner tests as passes.
- Docs: notes/fn147.6-doc-reconciliation.md and five affected public docs.

## Latest gates

Host confirms successful commands at frozen `f8a278ef927a037c420b6c60e570fbe564ac0a13`. Logs read directly under `/home/gordon/.cache/agent-tmp/gno-final-f8a278ef/`:

- Lint/format passed: **26 warnings, 0 errors**.
- TypeScript passed.
- Bare Bun full suite: **5150 pass, 2 existing skips, 0 fail**, 41177 assertions, 603 files, 226.70 seconds.
- Docs: **15 pass, 2 skips, 0 fail**.

Authoritative memory gate: `/home/gordon/.cache/agent-tmp/gno-integrated-6e25153f/memory-selected.log`: one selected suite, **19 evals, 100% at threshold 100**, unchanged fixture pins/golden, 200 samples, p95 **1.60ms**. Host identifies later changes as native hash reuse/development harness only, without intervening memory/owner logic changes. Multi-copy memory.log diagnostic is not acceptance evidence.

## Remaining work and limits

1. No unresolved fn147 runtime demonstration identified. Real SQLite reopen, partial checkpoint and rollback prove migration interruption/resume; live daemon kill/background interruption belongs to fn146.
2. Hosted gno.sh edits and changed-page QA remain required downstream, explicitly scheduled after aggregate PR. Do not claim the hosted site updated.
3. fn146 separately requires real request cancellation during load/inference, lease retention until settlement, foreground/background fairness with full results/citations and latency/queue/memory, model-specific leases, finite shutdown and durable backlog/child cleanup. Those can use fn147 fixtures without reopening its completed restoration proof.
4. Preserve source strata: failed baseline 2beb8aae; successful native matrix/attribution 3d9c0ec4; later packed public product 9d0b57e3 with helper f8a278ef; current CPU gate f8a278ef. This is not a fresh f8a native matrix.
5. Old three incomplete pairs remain incomplete. Nine complete old stored input/vector pairs match new actual outputs. Old raw token/context transcripts are absent, so raw old/new equality is not asserted. New call attribution is uniquely established by sequential source order, 24 nonoverlapping child lifecycles, 138 complete request/receipt pairs and exact input/token/vector matching.
6. No superseded fn138 work is needed. All mapped implementation/evidence belongs to fn147. This note changes no task state.

Machine-readable mapping: notes/fn147-closure-current.json.
