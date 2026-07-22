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
Added the shared Context Capsule runtime plus deterministic CLI and SDK build/verify surfaces, canonical JSON and Markdown projections, exact verification error handling, and cross-surface contract tests. Full tests, typecheck, lint, docs verification, and Flow validation pass; the pre-existing agentic context-byte promotion gate remains the only red evaluation.
## Evidence
- Commits: f7c2e91cbb1a170011796126d8ffcfbfcfa83527
- Tests: bun test test/cli/context-capsule.test.ts test/core/context-verifier.test.ts test/spec/schemas/context-capsule.test.ts (23 pass), bun run typecheck, bun test (2513 pass, 1 skip, 0 fail), bun run docs:verify (13 pass, 2 capability skips), bun test test/context test/spec/schemas (192 pass), bun run lint:check, .flow/bin/flowctl validate --spec fn-98-context-capsule-mvp --json, INHERITED_RED: bun run eval:agentic — context_byte_reduction=-0.6570175070322011; same sole baseline failure; success=1, call reduction=0.4893617021276596, claim linkage=1, deterministic replays
- PRs: