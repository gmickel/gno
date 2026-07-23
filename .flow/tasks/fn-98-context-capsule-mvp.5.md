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
Closed the final index-authority P1 after the seven-finding review hardening. `gno context verify` now distinguishes Commander's default `--index` value from a user-supplied override: omission selects the Capsule's canonical saved index, an explicit canonical match is accepted, and an explicit mismatch returns `invalid_filter` before opening a store. SDK clients now persist their canonical effective index, including `default` when `indexName` is omitted, so default/non-default mismatches fail at the same pre-I/O runtime boundary instead of opening or reading the wrong index. Regression coverage exercises omitted, matching, and mismatched CLI/SDK paths and spies on `SqliteAdapter.open` to prove mismatch does not open a store.

The earlier review fixes remain intact: active-token authority/recount, behavior-bound retrieval identity, trust-safe complete Markdown, pre-retrieval collection validation, pre-store index validation, and explicit capability outcomes. Standard focused gates and documentation verification pass. The opt-in agentic benchmark retains its previously recorded unrelated context-byte-reduction promotion failure.
## Evidence
- Commits: 689cfc8c, 0c1885c6
- Tests: bun run lint:check (pass), bun run typecheck (pass), bun test test/cli/context-capsule.test.ts test/sdk/client.test.ts test/core/context-verifier.test.ts test/spec/schemas/context-capsule.test.ts (47 pass, 0 fail), bun test test/context test/spec/schemas (pass; green receipt 0c1885c6-unittest.json), bun scripts/docs-verify.ts (13 pass, 2 capability skips, 0 fail), .flow/bin/flowctl validate --all --json (110 specs valid, 0 errors, 0 warnings), Prior full gate on review base: bun test (2516 pass, 1 skip, 0 fail), Prior opt-in bun run eval:agentic retained one unrelated promotion red: byte reduction -0.6570175070 versus required 0.35
- PRs: