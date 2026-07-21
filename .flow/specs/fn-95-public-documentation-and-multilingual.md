# fn-95 Public Documentation and Multilingual Claim Truth

## Goal & Context
<!-- scope: business -->

Make every prominent public claim reflect the currently released product and measured evidence. Remove stale version text, reconcile multilingual/Qwen benchmark prose, and add automated drift checks so README, docs, hosted gno.sh pages, package metadata, and benchmark records cannot quietly disagree again.

## Architecture & Data Models
<!-- scope: technical -->

Define a small manifest of public truth inputs derived from `package.json`, supported platform/runtime metadata, and committed benchmark summaries. Extend `scripts/docs-verify.ts` to compare rendered/source surfaces against those values and to reject unsupported superlatives or stale benchmark numbers where machine-checkable anchors exist.

Keep benchmark records immutable; public summaries link to dated evidence and state fixture/runtime limits. Sync behavior-affecting documentation to `/Users/gordon/work/gno.sh` in the same completion sequence.

## API Contracts
<!-- scope: technical -->

No runtime API. Documentation verification must expose deterministic CLI exit status and actionable file/claim mismatches. CI/prerelease remains compatible with the existing docs verification command.

## Edge Cases & Constraints
<!-- scope: technical -->

- Distinguish package version, docs snapshot date, and model benchmark date.
- Do not claim general language superiority from a small fixture.
- Retain historical changelog/version references that are intentionally archival.
- Hosted-site generated copies must not become a competing source of truth.
- Links must target committed evidence, not `/tmp` artifacts.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** README, in-repo docs, website source, and package/install examples identify the current release without stale hard-coded latest-version text.
- **R2:** Multilingual claims state the evaluated languages, metric, fixture limits, Qwen/Nemotron outcome, and lexical-degradation caveat accurately.
- **R3:** `docs-verify` fails on deliberately stale current-version and benchmark-summary fixtures with actionable messages.
- **R4:** Historical changelog references remain untouched and verification distinguishes them from current claims.
- **R5:** Hosted `gno.sh` documentation is updated, deployed, and verified against the canonical repo evidence.
- **R6:** No marketing surface promises an unimplemented model, connector, remote-access, or paid capability.

## Boundaries
<!-- scope: business -->

No product feature implementation, branding redesign, new pricing strategy, model promotion, or broad copy rewrite beyond truth alignment and evidence linkage.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

Visible drift damages trust precisely where GNO wants to differentiate on verifiability. Accurate claims are an immediate activation and credibility repair.

### Implementation Tradeoffs
<!-- scope: technical -->

Automate stable facts and evidence anchors, but leave nuanced prose human-owned. A single truth manifest is preferable to duplicating version/benchmark values across renderers.

## Implementation Plan

1. `fn-95-public-documentation-and-multilingual.1` — Create the public-truth manifest and drift verifier (**M**)
2. `fn-95-public-documentation-and-multilingual.2` — Reconcile repository claims with measured evidence (**M**); depends on `fn-95-public-documentation-and-multilingual.1`
3. `fn-95-public-documentation-and-multilingual.3` — Propagate and verify truthful public documentation (**M**); depends on `fn-95-public-documentation-and-multilingual.2`

## Quick commands

```bash
bun run docs:verify
bun test test/scripts/docs-verify*
.flow/bin/flowctl validate --spec fn-95-public-documentation-and-multilingual --json
```

## References

- `scripts/docs-verify.ts:1-460` — current quickstart verification.
- `evals/multilingual.eval.ts:1` and `evals/README.md:75` — placeholder multilingual evidence.
- `package.json` — release-version source of truth.

## Early proof point

Task `fn-95-public-documentation-and-multilingual.1` validates the core approach (machine-owned current-version and benchmark anchors fail on an intentionally stale fixture without touching historical prose).
If it fails, re-evaluate which facts belong in the truth manifest versus human-owned copy before continuing with `fn-95-public-documentation-and-multilingual.2`+.

## Requirement coverage

| Req | Description | Task(s) | Gap justification |
|-----|-------------|---------|-------------------|
| R1 | README, in-repo docs, website source, and package/install examples identify the current release without stale hard-coded latest-version text. | fn-95-public-documentation-and-multilingual.1, fn-95-public-documentation-and-multilingual.2, fn-95-public-documentation-and-multilingual.3 | — |
| R2 | Multilingual claims state the evaluated languages, metric, fixture limits, Qwen/Nemotron outcome, and lexical-degradation caveat accurately. | fn-95-public-documentation-and-multilingual.2, fn-95-public-documentation-and-multilingual.3 | — |
| R3 | `docs-verify` fails on deliberately stale current-version and benchmark-summary fixtures with actionable messages. | fn-95-public-documentation-and-multilingual.1 | — |
| R4 | Historical changelog references remain untouched and verification distinguishes them from current claims. | fn-95-public-documentation-and-multilingual.1, fn-95-public-documentation-and-multilingual.2 | — |
| R5 | Hosted `gno.sh` documentation is updated, deployed, and verified against the canonical repo evidence. | fn-95-public-documentation-and-multilingual.3 | — |
| R6 | No marketing surface promises an unimplemented model, connector, remote-access, or paid capability. | fn-95-public-documentation-and-multilingual.2, fn-95-public-documentation-and-multilingual.3 | — |
