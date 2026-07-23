---
satisfies: [R3, R5]
---
# fn-103-capsule-distribution-and-commercial.3 Publish the reproducible three-way agent outcome demo

## Description
Deliver publish the reproducible three-way agent outcome demo as one implementation-sized increment.

**Size:** M
**Files:** `evals/agentic/demos/context-capsule.ts`, `evals/fixtures/agentic-retrieval/demos`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`, `/Users/gordon/work/gno.sh/src/routes/features`

### Approach
- Run one frozen task/corpus/model/environment through no-GNO/lexical baseline, current GNO primitives, and Context Capsule adapters using fn-97 receipts. Preserve the Capsule's normalized `retrieval.request`, explicit capability states/fallback reasons, and canonical effective index in the raw comparison artifact so an unavailable capability or different request cannot masquerade as an equivalent run.
- Publish exact evidence coverage, calls, bytes/tokens, latency, stop outcome, methodology, variance, and raw normalized receipts.
- Reuse fn-101's committed `verified-ask-promotion.json` / `.md` only as a separately labeled answer-enforcement proof. Validate its canonical fingerprint and clean git provenance, preserve its frozen 22-task paired `raw_ask` / `verified_ask` cohort and two explicit missing-evidence exclusions, and report its answer-accuracy and unsupported-substantive-claim metrics without merging them into the three-way retrieval receipts.
- Keep the page reproducible from committed artifacts and avoid extrapolating one task into general superiority.

### Investigation targets
**Required** (read before coding):
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`
- `evals/agentic/verified-ask-contract.ts`
- `evals/agentic/verified-ask-promotion.ts`
- `evals/fixtures/agentic-retrieval/baseline/fixture-agent/verified-ask-promotion.json`
- `spec/evals-agentic.md`

**Optional** (reference as needed):
- `/Users/gordon/work/gno.sh/src/lib/site-content.ts`
- `/Users/gordon/work/gno.sh/src/lib/product-pages.ts`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `evals/agentic/report.ts`
- `evals/fixtures/agentic-retrieval/baseline`
- `evals/agentic/verified-ask-outcome.ts`
- `evals/agentic/verified-ask-promotion.ts`
- `evals/fixtures/agentic-retrieval/baseline/fixture-agent/verified-ask-promotion.json`
- `evals/fixtures/agentic-retrieval/baseline/fixture-agent/verified-ask-promotion.md`

## Acceptance
- [ ] The same task inputs and pinned environment produce all three normalized receipts.
- [ ] Public demo exposes exact evidence, calls, context/tokens, latency, method, variance, and downloadable raw receipts.
- [ ] If published beside the demo, the verified-Ask promotion remains a distinct fingerprint-validated 22-pair raw-Ask/buildVerifiedAsk artifact; its answer metrics and exclusions are not presented as three-way retrieval metrics.
- [ ] Copy describes measured outcome only and links the immutable benchmark artifact.
<!-- Updated by plan-sync (cross-spec): fn-98-context-capsule-mvp.5 review fixes made normalized retrieval request, capability outcomes, and index identity part of reproducible Capsule evidence -->
<!-- Updated by plan-sync (cross-spec): fn-101-trustworthy-synthesis-and-claim.4 shipped a separate attributable verified-Ask promotion artifact that must not be conflated with this three-way demo -->


## Done summary
Published the reproducible three-way Context Capsule outcome demo.

- Added a closed, canonically fingerprinted demo schema and deterministic generator.
- Froze one exact-identifier task across lexical-only, current GNO MCP primitives, and Context Capsule lanes with complete normalized receipts, scores, exact evidence, calls, bytes, token availability, matching cold-lifecycle latency, request, effective index, capability states, fallbacks, and payload.
- Generated committed JSON and Markdown artifacts from the authoritative fn-97 benchmark.
- Kept the 22-pair Verified Ask result separately labeled as answer-enforcement proof with its two missing-evidence exclusions.
- Published the measured outcome on the hosted benchmarks feature page and docs with immutable source links and explicit one-task/variance limitations.
- Added contract and hosted public-truth regression tests.
## Evidence
- Commits: c1fc6ac39046bc4189f08dba4b7da855463baca3, fef03bb
- Tests: gno: bun run eval:agentic:demo, gno: bun run lint:check, gno: bun test test/eval/agentic (150 pass), gno: bun test (2857 pass, 1 platform skip, 0 fail), gno.sh: bun run check, gno.sh: bun run typecheck, gno.sh: bun run test (94 pass, 5 integration skips), gno.sh: bun run build (67 pages prerendered), immutable raw demo URL: HTTP 200
- PRs: