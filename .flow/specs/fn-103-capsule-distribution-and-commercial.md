# fn-103 Capsule Distribution and Commercial Proof

## Goal & Context
<!-- scope: business -->

Use the Context Capsule contract to improve agent-readable public publishing and validate one honest paid wedge: private client knowledge rooms compiled from local files. Replace feature-grid promises with reproducible outcome proof while keeping local GNO free.

## Architecture & Data Models
<!-- scope: technical -->

Extend the existing reader-safe gno.sh projection for public spaces with canonical Markdown, manifest JSON, `llms.txt`, stable evidence/source links, content hashes, capability metadata, and Capsule-compatible exports. Public agent endpoints consume only the already-published projection; they never reach the local index.

Add a reproducible demonstration harness using one task across no GNO, current GNO primitives, and Context Capsules, reporting evidence coverage, calls, tokens, and latency from `fn-97` receipts.

Treat fn-101's committed `verified-ask-promotion.json` as a separate attributable answer-enforcement proof: 22 paired production raw-Ask versus `buildVerifiedAsk` tasks, with answer accuracy and unsupported-substantive-claim counts. It may be linked alongside the three-way demo, but it does not replace or get relabeled as that retrieval demo because it has different lanes, exclusions, metrics, and artifact contracts.

Commercial validation uses existing safe publishing/sharing mechanics with five design partners and explicit funnel events recorded as aggregate product metrics: onboarding started/completed, first publish, invite/share, republish, weekly retained use. Secret/invite-only agent API access remains deferred until `fn-111` egress policy and authentication requirements are complete; encrypted spaces are never server-decrypted.

## API Contracts
<!-- scope: technical -->

- Public spaces expose deterministic `llms.txt`, manifest JSON, Markdown documents, and Capsule/evidence links with cache validators.
- Manifest declares schema version, space revision, visibility, generated time, documents, hashes, and supported reader capabilities.
- Three-way demo receipts reuse `fn-97`; marketing pages link raw methodology/results. Any fn-101 verified-Ask proof links its own canonical promotion artifact and methodology without merging receipts or metrics across the two benchmarks.
- Any future token-authenticated private read API is explicitly non-shipping in this spec and contract-gated on `fn-111`.
<!-- Updated by plan-sync (cross-spec): fn-101-trustworthy-synthesis-and-claim.4 shipped a distinct 22-pair verified-Ask promotion artifact, not the three-way retrieval demo required here -->

## Edge Cases & Constraints
<!-- scope: technical -->

- Respect existing visibility and reader-safe projection rules; drafts/private local files never leak into public manifests.
- Prevent path guessing, stale cache exposure, search-engine indexing where visibility forbids it, and source-map leakage.
- Public artifacts remain useful without JavaScript.
- Design-partner metrics must not capture document/query content.
- Pricing/copy must distinguish shipped capability, concierge service, and deferred access.
- Outcome comparisons pin corpus/task/model/environment and disclose variance.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** A public gno.sh space is agent-readable through `llms.txt`, manifest JSON, Markdown, and exact evidence links derived solely from its published projection.
- **R2:** Visibility regression tests prove private/draft/local-only material cannot appear in public artifacts or caches.
- **R3:** A reproducible three-way outcome demo publishes exact evidence, calls, context/tokens, latency, methodology, and raw receipts.
- **R4:** Five design-partner trials can be run with concierge onboarding and content-free funnel/retention measurement.
- **R5:** Public/pricing copy removes or marks unimplemented promises and accurately separates free local GNO from paid controlled distribution/collaboration.
- **R6:** Encrypted spaces are never server-decrypted; token-authenticated secret/invite agent access remains blocked pending `fn-111` and a dedicated auth gate.
- **R7:** gno.sh deployment, cache/security checks, analytics privacy, and rollback are documented and verified.

## Boundaries
<!-- scope: business -->

No multi-tenant company brain, OAuth connector marketplace, server-side decryption, broad remote inference, sales automation, or launch of deferred private agent API access.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

GNO's adoption gap is more plausibly proof/activation/positioning than missing capability. The same evidence contract can demonstrate value publicly and support a narrow paid collaboration wedge.

### Implementation Tradeoffs
<!-- scope: technical -->

Public projection is safe to ship before remote private access. Deferring token-authenticated secret spaces prevents distribution work from outrunning collection-level egress and security controls.

## Implementation Plan

1. `fn-103-capsule-distribution-and-commercial.1` — Extend the public publish artifact with agent-readable evidence (**M**)
2. `fn-103-capsule-distribution-and-commercial.2` — Serve llms manifests Markdown and evidence safely on gno.sh (**M**); depends on `fn-103-capsule-distribution-and-commercial.1`
3. `fn-103-capsule-distribution-and-commercial.3` — Publish the reproducible three-way agent outcome demo (**M**); depends on `fn-103-capsule-distribution-and-commercial.1`, `fn-103-capsule-distribution-and-commercial.2`
4. `fn-103-capsule-distribution-and-commercial.4` — Run privacy-safe design-partner validation and truthful launch (**M**); depends on `fn-103-capsule-distribution-and-commercial.2`, `fn-103-capsule-distribution-and-commercial.3`

## Quick commands

```bash
bun test test/publish
bun run docs:verify
cd /Users/gordon/work/gno.sh && bun test
.flow/bin/flowctl validate --spec fn-103-capsule-distribution-and-commercial --json
```

## References

- `src/publish/export-service.ts:134-390` — local reader-safe export.
- `src/publish/artifact.ts:11-90` — artifact visibility/schema.
- `/Users/gordon/work/gno.sh/src/lib/publish-read-service.ts` — hosted reader projection.

## Early proof point

Task `fn-103-capsule-distribution-and-commercial.1` validates the core approach (a public export can expose deterministic agent-readable evidence without including any unpublished/local source).
If it fails, re-evaluate the reader-safe projection boundary and manifest lineage before continuing with `fn-103-capsule-distribution-and-commercial.2`+.

## Requirement coverage

| Req | Description | Task(s) | Gap justification |
|-----|-------------|---------|-------------------|
| R1 | A public gno.sh space is agent-readable through `llms.txt`, manifest JSON, Markdown, and exact evidence links derived solely from its published projection. | fn-103-capsule-distribution-and-commercial.1, fn-103-capsule-distribution-and-commercial.2 | — |
| R2 | Visibility regression tests prove private/draft/local-only material cannot appear in public artifacts or caches. | fn-103-capsule-distribution-and-commercial.1, fn-103-capsule-distribution-and-commercial.2 | — |
| R3 | A reproducible three-way outcome demo publishes exact evidence, calls, context/tokens, latency, methodology, and raw receipts. | fn-103-capsule-distribution-and-commercial.3 | — |
| R4 | Five design-partner trials can be run with concierge onboarding and content-free funnel/retention measurement. | fn-103-capsule-distribution-and-commercial.4 | — |
| R5 | Public/pricing copy removes or marks unimplemented promises and accurately separates free local GNO from paid controlled distribution/collaboration. | fn-103-capsule-distribution-and-commercial.3, fn-103-capsule-distribution-and-commercial.4 | — |
| R6 | Encrypted spaces are never server-decrypted; token-authenticated secret/invite agent access remains blocked pending `fn-111` and a dedicated auth gate. | fn-103-capsule-distribution-and-commercial.1, fn-103-capsule-distribution-and-commercial.2, fn-103-capsule-distribution-and-commercial.4 | — |
| R7 | gno.sh deployment, cache/security checks, analytics privacy, and rollback are documented and verified. | fn-103-capsule-distribution-and-commercial.2, fn-103-capsule-distribution-and-commercial.4 | — |
