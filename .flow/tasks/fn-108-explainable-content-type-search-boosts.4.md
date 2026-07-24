---
satisfies: [R2, R3, R4, R6]
---
# fn-108-explainable-content-type-search-boosts.4 Run adversarial promotion evals and replace no-op documentation

## Description
Deliver run adversarial promotion evals and replace no-op documentation as one implementation-sized increment.

**Size:** M
**Files:** `evals/fixtures/agentic-retrieval`, `test/pipeline/content-type-boost-adversarial.test.ts`, `docs/CONFIGURATION.md`, `docs/HOW-SEARCH-WORKS.md`, `assets/skill/SKILL.md`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

### Approach
- Add boosted relevant/irrelevant, keyword stuffing, ties, filter bypass, and combined-affinity cases to deterministic/fn-97 suites.
- Require no evidence-accuracy/coverage regression and commit before/after receipts before promoting the field from reserved/no-op.
- Update config/search/explain/spec/skill/hosted docs with exact range, neutral value, caps, composition order, and limitations.

### Investigation targets
**Required** (read before coding):
- `docs/CONFIGURATION.md:331-360`
- `docs/HOW-SEARCH-WORKS.md`
- `assets/skill/SKILL.md`

**Optional** (reference as needed):
- `docs/API.md`
- `docs/MCP.md`
- `docs/SDK.md`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `evals/agentic/types.ts`

## Acceptance
- [ ] Adversarial fixtures prove cap, no filter/egress bypass, deterministic ties, and safe affinity composition.
- [ ] fn-97 records no accuracy/evidence-coverage regression with committed before/after receipts.
- [ ] All docs/skill/hosted surfaces remove the no-op wording and state the exact bounded behavior.


## Done summary
Completed adversarial promotion gates, committed benchmark receipts, and every
local/hosted documentation surface for bounded content-type search boosts.

- Added deterministic active-rule cases for relevant and keyword-stuffed
  candidates, clear-score leads, negative rules, stable ties, configured-type
  precedence, collection/exclude hard filters, candidate non-creation, and
  project-affinity composition under the shared auxiliary cap.
- Completion review found and the implementation now closes two ranking-boundary
  gaps: boost-only BM25/vector requests no longer widen candidate retrieval or
  defer `minScore`; hybrid composes auxiliary scoring into normalized fusion
  before rerank blending, leaving rerank order and lexical top-hit protection
  authoritative. Shared-mirror projections cannot leak type or affinity state.
- Added a separate `content-type-boost-promotion@1` artifact derived from all
  24 authoritative fn-97 tasks. The committed before/after receipts preserve
  URI order, evidence accuracy (24/24), and evidence coverage (25/25).
- Kept the benchmark claim narrow: the fn-97 lane proves compatibility with no
  configured boost rules; controlled adversarial tests prove active-rule
  behavior. Neither lane claims general retrieval superiority.
- Recorded the current egress boundary explicitly: retrieval egress policy is
  unavailable, so the suite makes no unsupported egress-bypass claim.
- Replaced reserved/no-op documentation with the exact factor range, neutral
  value, contribution and shared caps, one-rule precedence, explain/status
  receipts, fingerprint/invalidation behavior, filter guarantees, and limits
  across README, config/search/CLI/API/MCP/SDK/architecture specs, benchmark
  docs, shipped skill, changelog, and hosted gno.sh product truth.
- The authoritative agentic run passed: 144/144 scored, Capsule promotion
  passed, zero exclusions, and deterministic Capsule replays.

Verification:

- `bun run lint:check`
- `bun test` (full suite green)
- `bun run docs:verify` (13 passed, 2 model-cache skips)
- `bun run eval:agentic -- --write` (144/144 scored; promotion PASS)
- `bun run eval:agentic:demo`
- Focused ranking-boundary, shared-mirror, adversarial, agentic baseline, demo,
  and artifact writer tests
- `.flow/bin/flowctl validate --spec fn-108-explainable-content-type-search-boosts --json`

Hosted docs are committed and pushed on
`codex/fn-108-content-type-boost-docs` through `b937751`; lint, typecheck, 111
tests, and the 68-page production build are green. Merge/deploy follows GNO
landing.

No macOS or Windows client artifacts were awaited, per roadmap execution
policy.
## Evidence
- Commits: 440db11, f6e81d3, 5eddaad
- Tests: bun run lint:check, bun test, bun run docs:verify, bun run eval:agentic -- --write, bun run eval:agentic:demo, bun test test/pipeline/content-type-boost-adversarial.test.ts test/eval/agentic/cli.test.ts test/eval/agentic/baseline.test.ts, .flow/bin/flowctl validate --spec fn-108-explainable-content-type-search-boosts --json, bun test test/pipeline/content-type-boost.test.ts test/pipeline/content-type-boost-adversarial.test.ts test/pipeline/vsearch-n1.test.ts test/pipeline/rerank-normalization.test.ts test/pipeline/hybrid-doc-lookup.test.ts test/pipeline/project-affinity.test.ts, bun test test/eval/agentic/context-capsule-demo.test.ts test/eval/agentic/baseline.test.ts test/core/activation-verifier.test.ts, gno.sh: bun run typecheck && bun test && bun run build
- PRs: