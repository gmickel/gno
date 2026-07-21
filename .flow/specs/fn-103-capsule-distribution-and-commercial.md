# fn-103 Capsule Distribution and Commercial Proof

## Goal & Context
<!-- scope: business -->

Use the Context Capsule contract to improve agent-readable public publishing and validate one honest paid wedge: private client knowledge rooms compiled from local files. Replace feature-grid promises with reproducible outcome proof while keeping local GNO free.

## Architecture & Data Models
<!-- scope: technical -->

Extend the existing reader-safe gno.sh projection for public spaces with canonical Markdown, manifest JSON, `llms.txt`, stable evidence/source links, content hashes, capability metadata, and Capsule-compatible exports. Public agent endpoints consume only the already-published projection; they never reach the local index.

Add a reproducible demonstration harness using one task across no GNO, current GNO primitives, and Context Capsules, reporting evidence coverage, calls, tokens, and latency from `fn-97` receipts.

Commercial validation uses existing safe publishing/sharing mechanics with five design partners and explicit funnel events recorded as aggregate product metrics: onboarding started/completed, first publish, invite/share, republish, weekly retained use. Secret/invite-only agent API access remains deferred until `fn-111` egress policy and authentication requirements are complete; encrypted spaces are never server-decrypted.

## API Contracts
<!-- scope: technical -->

- Public spaces expose deterministic `llms.txt`, manifest JSON, Markdown documents, and Capsule/evidence links with cache validators.
- Manifest declares schema version, space revision, visibility, generated time, documents, hashes, and supported reader capabilities.
- Demo receipts reuse `fn-97`; marketing pages link raw methodology/results.
- Any future token-authenticated private read API is explicitly non-shipping in this spec and contract-gated on `fn-111`.

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
