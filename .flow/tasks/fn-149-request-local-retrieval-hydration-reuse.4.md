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
Request-local hydration acceptance completed for the measured read domain. Six real-SQLite production Ask scenarios preserve complete outputs, prepared model inputs, citations, provenance and failures against the frozen predecessor. Raw full-context Ask reads fall from3 to2 and returned UTF-8 text from6,958,683 to4,638,789bytes; verified Ask reads fall from5 to4 and returned text from11,596,473 to9,277,578bytes. The independent plain targeted-path fixture reduces selected chunk rows from1,000 to1. These counters measure returned rows and text, not total heap or native allocation.

CUDA and physical Ivan matched29 verified-Ask comparisons use the unchanged strict comparator, actual judge invocation and complete native transcript. Metal retains its original noRerank:true policy. Request ownership is released on completion and abort; separate requests observe edits. Corrupt/missing mirror, unsupported verifier outcome and indexed-source mutation negatives remain in the evidence.

Final memory100%, hybrid86% and BM25 ranking88% gates passed with unchanged thresholds. Final repository gate evidence is under the fn146 final-release-gates artifact directory. Repository architecture and user guidance are reconciled. Hosted gno.sh documentation and driven-page QA are queued after the aggregate PR under the user's sequencing override. No total retained-heap saving or cross-backend numeric equality is claimed.

Evidence: .flow/artifacts/fn-149-request-local-retrieval-hydration-reuse/README.md; .flow/artifacts/fn-144-native-recovery-and-idle-inference/cuda-packed-surfaces-9d0b57e3/README.md; ivan-verified-ask-matched29/README.md; .flow/artifacts/fn-146-cancellation-and-bounded-background/final-release-gates/.
## Evidence
- Commits: 76743bd616cbe723b0adab87da9f380cad1513ad, f64c41c97e196e3bffdba23bc1c006bca7489b28, f661cf44c4e52cdf9a3f5020339a670c70fdffd1, aae58c0a0662ea20d4e9ecdef1c9c4867c278833
- Tests: bun run lint:check, bun run typecheck, bun test, bun run docs:verify, bun run verify:clipper-package, bun run test:package, bun run eval:memory, bun run eval:hybrid, bun --bun evalite evals/vsearch.eval.ts
- PRs: