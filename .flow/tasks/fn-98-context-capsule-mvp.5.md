---
satisfies: [R1, R3, R4]
---
# fn-98-context-capsule-mvp.5 Expose Capsule build and verify through CLI and SDK

## Description
Deliver expose capsule build and verify through cli and sdk as one implementation-sized increment.

**Size:** M
**Files:** `src/cli/program.ts`, `src/cli/commands/context-build.ts`, `src/cli/commands/context-verify.ts`, `src/sdk/client.ts`, `src/sdk/types.ts`, `test/cli/context-capsule.test.ts`

### Approach
- Add `gno context build` and `gno context verify` over task 3's `compileContextEvidence` entry point and the shared verifier with deterministic JSON and readable Markdown; inject the store, `searchHybrid`, and complete canonical projector through `ContextEvidenceCompilerDeps` rather than wiring `planContextEvidence` or materialization separately at each surface.
- Build Capsule evidence in the canonical projector with `toContextCapsuleEvidence`; consume both `ContextEvidenceProjectionContext.indexFingerprint` and `contextFingerprint` when deriving the frozen `retrieval.indexSnapshot`/`fingerprints` fields, and surface `ContextEvidenceError.code` consistently for snapshot/load/provenance failures.
- Call `verifyContextCapsule(input, ContextVerifierDeps)` for verification; supply current config/retrieval/embedding-model/rerank-model/tokenizer fingerprints, an optional evidence-ID keyed `resolveCurrentRanks`, and the active-token `countTokens` callback when required. Emit canonical receipt JSON with `canonicalContextCapsuleVerificationJson`; Markdown is a projection of that same receipt, including `currentFingerprints`, `fingerprintStatus`, and canonically ordered distinct `fingerprintReasons` independently from ranking status.
- Support explicit output files without implicit persistence; keep progress on stderr and canonical payload on stdout/file.
- Add SDK methods using the same option/result types and error taxonomy.

### Investigation targets
**Required** (read before coding):
- `src/cli/program.ts:216-900`
- `src/cli/commands/query.ts`
- `src/sdk/client.ts`
- `src/sdk/types.ts`

**Optional** (reference as needed):
- `src/cli/format/search-results.ts`
- `test/cli/bench.test.ts`

## Acceptance
- [ ] CLI JSON, CLI Markdown, and SDK emit equivalent canonical Capsule content.
- [ ] Budget/filter/index/goal options validate consistently and stdout remains clean.
- [ ] Verify accepts schema-valid files and returns per-evidence classifications without mutation.
- [ ] JSON/Markdown/SDK preserve canonical URI parity, exact final `usedBytes`, the estimator-specific `usedTokens` contract, safety margins, evidence bindings, and omission `reasonCounts`.
- [ ] CLI and SDK use the same `compileContextEvidence` dependency wiring and `toContextCapsuleEvidence` projection; neither exposes symbol-keyed planner metadata nor accepts caller-owned context snapshots/observation timestamps.
- [ ] Context/index snapshot drift and strict evidence-load failures map to identical CLI and SDK errors without partial Capsule output.
- [ ] Invalid identity/budget/URI and non-canonical metadata fail before store access, while exact `evidence.text` bytes are preserved without NFC/LF normalization; unavailable/failed rank resolution returns `ranking_unavailable`, and stale/missing content cannot be reported as ranked.
- [ ] Verification surfaces source/mirror/passage/chunk stale, missing, and corrupt classifications with the verifier's available current hashes, and large Capsules remain correct when store batch lookups are internally chunked past SQLite's variable limit.
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.1 used the frozen canonical Capsule accounting and evidence contract -->
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.2 used injected retrieval, materialization, and canonical projection seams -->
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.3 made compileContextEvidence and ContextEvidenceCompilerDeps the strict public compilation seam -->
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.4 exposed verifyContextCapsule, ContextVerifierDeps, and canonicalContextCapsuleVerificationJson -->
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.4 review fixes separated fingerprint drift from ranking, preserved exact evidence bytes, and hardened partial-truth/large-Capsule verification -->


## Done summary
Closed the independent review HOLD across all seven findings. Active-token verification now requires the matching runtime tokenizer authority and recounts canonical tokens before any store access. Capsules persist normalized retrieval behavior and explicit capability request/attempt/outcome state, so behavior-affecting inputs bind fingerprints and identity. Markdown now encloses untrusted metadata and exact passage bytes in explicit deterministic boundaries while projecting the complete canonical contract and verification receipt. CLI and SDK reject unknown collections before retrieval, explicit verify index mismatches fail before store access, and graph/semantic/rerank fallback reporting no longer confuses unrequested capabilities with unavailable ones. Added regression coverage for tampered tokens, identity changes, adversarial metadata, Markdown parity, invalid filters/indexes, and capability states.

All standard gates pass. The opt-in agentic benchmark retains its inherited sole red promotion metric: context byte reduction is -0.6570175070 versus the required 0.35; accuracy, call reduction, and claim-linkage gates pass. This task does not alter the benchmark's evidence-selection byte economics.
## Evidence
- Commits: 689cfc8c
- Tests: bun run lint:check (pass), bun run typecheck (pass), bun test test/spec/schemas/context-capsule.test.ts test/core/context-verifier.test.ts test/core/context-compiler-selection.test.ts test/cli/context-capsule.test.ts (32 pass, 0 fail), bun test test/context test/spec/schemas (192 pass, 0 fail; green receipt 689cfc8c-unittest.json), bun test (2516 pass, 1 skip, 0 fail; 17329 assertions across 293 files), bun scripts/docs-verify.ts (13 pass, 2 capability skips, 0 fail), .flow/bin/flowctl validate --all --json (110 specs valid, 0 errors, 0 warnings), bun run eval:agentic (inherited promotion red only: success 0.958333/1, call reduction 0.4893617021, byte reduction -0.6570175070, claim linkage 1; required byte reduction 0.35)
- PRs: