---
satisfies: [R2, R4, R5, R7]
---
# fn-101-trustworthy-synthesis-and-claim.4 Run adversarial outcome gates and ship truthful verification docs

## Description
Deliver run adversarial outcome gates and ship truthful verification docs as one implementation-sized increment.

**Size:** M
**Files:** `evals/agentic`, `test/pipeline/claim-verification-adversarial.test.ts`, `test/pipeline/verified-ask*.test.ts`, `test/mcp/tools/ask.test.ts`, `test/serve/routes/query.test.ts`, `test/spec/schemas/ask.test.ts`, `docs/HOW-SEARCH-WORKS.md`, `docs/CLI.md`, `docs/MCP.md`, `assets/skill/recipes/citation-and-provenance.md`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

### Approach
- Exercise the shipped `buildVerifiedAsk` boundary through each canonical opt-in surface: `gno ask --verify`, REST `POST /api/ask` with `verify: true`, MCP `gno_ask` (where `verify` must be literal `true`), and SDK `ask(..., { verify: true })`. Cover contradiction, insufficient evidence, stale/missing spans, malformed numeric or evidence-ID citations, verifier outage, request-schema rejection, and prompt injection without reopening raw Ask behavior.
- Feed verified-Ask receipts into the existing fn-97 outcome-evaluation evidence path. Measure final-answer accuracy and unsupported substantive claims against the compatible baseline; block promotion on accuracy regression, and report an unavailable or non-comparable baseline rather than fabricating a reduction.
- Assert the additive `verification` result contract and readable renderings: `mode: "closed_capsule"`, Capsule/freshness receipts, four-state per-claim verdicts, exact retained evidence IDs/line spans, coverage/gaps, semantic degradation, abstention, and capability-state distinctions such as `not_requested` versus attempted `unavailable`.
- Document verification as closed-Capsule evidence classification, not a factual guarantee, across repo, skill, and hosted surfaces. State the explicit opt-in forms, literal-MCP requirement, thresholds/abstention, verifier availability/degradation, evidence-marker rendering, and raw-Ask compatibility boundary.

### Investigation targets
**Required** (read before coding):
- `evals/ask.eval.ts`
- `docs/HOW-SEARCH-WORKS.md`
- `assets/skill/recipes/citation-and-provenance.md`

**Optional** (reference as needed):
- `docs/TROUBLESHOOTING.md`
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `evals/agentic`

## Acceptance
- [ ] Adversarial fixtures cover every verdict/degraded state and cannot bypass closed evidence.
- [ ] fn-97 shows no answer-accuracy regression and records the reduction in unsupported claims.
- [ ] Cross-surface verified-Ask fixtures preserve the closed Capsule/freshness and exact-evidence contract, reject unsupported request shapes, and retain raw Ask as a compatibility path.
- [ ] Specs/schemas/docs/skill/gno.sh state limitations, opt-in contracts, thresholds, abstention, degradation, and verifier availability accurately.
<!-- Updated by plan-sync: fn-101-trustworthy-synthesis-and-claim.3 used buildVerifiedAsk with explicit surface verify contracts, not generic answer-time verification -->


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
