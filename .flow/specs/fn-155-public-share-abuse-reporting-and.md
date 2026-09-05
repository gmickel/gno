# Public-share abuse reporting and administrator takedown

## Goal & Context

A reader can report a specific public gno.sh page, and Gordon can review the report and disable that publication without direct database edits. Owners can understand the restriction and request a review. Published policies must describe the actual reporting, moderation, and data-handling process.

This spec implements the separate follow-up requested during fn-153. It is no longer a stub. The implementation is primarily in `~/work/gno.sh`; Flow state remains in `~/work/gno`. Implement after fn-153's shared withdrawal/deletion model and the GNO 2.0 release. Read the latest versions of both specs and both repositories' AGENTS.md. Keep zero tasks and use the no-plan direct work route, `$flow-next-work fn-155`, after dependencies are satisfied. Preparing this spec does not authorize a real takedown, granting operator privileges, sending email, or deploying production.

## Architecture & Data Models

### Deliberately small first version

Keep `abuse@gno.sh` as the report intake. Add a contextual Report link on public readers and improve `/report-abuse`; provide a prefilled email draft plus a copyable address and report template for people without a configured mail client. The user sends the email. Do not claim that opening a draft submitted a report.

Do not add an anonymous report-submission API, in-app report database, evidence-upload service, moderation queue, automated classifier, or automatic takedown threshold. Reporters may supply the URL, explanation, optional contact details, and evidence through the existing email channel. This is the selected minimum implementation under Gordon's instruction to make the stub actionable.

Add a small authenticated operator page for exact public-route/target lookup, current publication status, takedown, and reinstatement. This page manages publication restrictions; the existing abuse inbox remains the report queue.

### Entry points

| Responsibility | gno.sh starting points |
|---|---|
| Report instructions and policy text | `src/routes/report-abuse.tsx`, `acceptable-use.tsx`, `terms.tsx`, `privacy.tsx`, `src/lib/legal.ts` |
| Reader report action and owner status | `src/components/reader/reader-scaffold.tsx`, `src/components/studio/publish-studio.tsx` |
| Session and operator configuration | `src/lib/server/auth.ts`, `src/lib/auth-guard.ts`, `src/lib/server/env.ts` |
| Publication lifecycle and denial | fn-153's shared service, `src/lib/publish.functions.ts`, `publish-service.ts`, `src/lib/server/publish-db-read.ts`, `publish-db-write.ts`, `db/schema.sql` |
| Asset and agent projections | `src/lib/publish-reader-asset-delivery.ts`, `publish-artifact-asset-lifecycle.ts`, `src/lib/server/publish-db-agent.ts` |
| Existing policy links | `src/components/site/site-footer.tsx` |

The existing `admin` billing plan grants entitlements; it is not moderation authorization. Use an explicit server-only allowlist of immutable authenticated user IDs for the first operator role. Empty or missing configuration denies access. Do not infer operator authority from email domain, account ownership, an organization role, query parameters, or a client flag. Configure real IDs only as an authorized release operation; tests use synthetic identities. Reuse a stronger existing operator role if the released baseline has introduced one, with equivalent tests.

### Reporting flow

The contextual link carries only the public owner/space/note identifiers needed to display the canonical reported URL. Validate that it is a supported gno.sh public route. Do not accept arbitrary external fetch targets, auto-fetch submitted evidence, or embed reporter text in a query string. Strip unrelated query parameters and fragments. The general reporting page continues to work without a target.

Explain what to include, that reports are reviewed manually, and how to follow up by email. Keep an email fallback for a page already unavailable. No reporter account is required to read the instructions or compose a report. A malformed target receives an actionable correction without reflecting unsafe HTML or initiating a fetch.

### Moderation state

Add a moderation restriction independent of owner visibility, unpublish state, expiry, and deletion state. The shared reader/service gate denies access whenever any applicable restriction denies it. Taking content down sets the moderation block in a transaction and records the action. Owner republish, access edits, token rotation, route rename, and new snapshot activation cannot clear the block.

Scope the first version to one public publication and its associated source identity/history. Preserve an owner-scoped digest of the blocked publication's canonical content so an exact re-import under another slug cannot bypass the block. Compute it from normalized note bodies and referenced asset digests, excluding route names, generated IDs, export timestamps, and other transport metadata. Do not expose the digest or use it as a cross-tenant lookup. Test a renamed exact copy. This is bounded duplicate prevention, not fuzzy matching or a guarantee against edited content or a new account. No automated global account sanctions in this version.

Keep the minimal active restriction record for as long as the block is enforced: target/source identity, owner scope, content digest, actor ID, timestamp, status, policy reason code, and owner-visible explanation. Do not store reporter identity, report email, attachments, raw content, or secret URLs in moderation records or ordinary logs. Require a short policy explanation, with a bounded length and plain-text rendering; show it only to the affected owner and operators.

Maintain a content-free audit trail of takedown/reinstatement attempts that changed state, with an operation ID, actor, target, reason code, timestamp, and resulting state. Use the existing restricted operational retention mechanism where available. Document the actual retention and deletion mechanism before release; do not invent a legal retention requirement. Active block records are required to enforce the restriction and survive owner deletion, while deleted content payloads follow fn-153. Reinstatement clears the active block/digest restriction without erasing the action history required by the configured retention policy.

### Reinstatement and communication

Takedown success means future hosted content requests are denied across all routes, assets, history, search/discovery, and machine-readable projections, using fn-153's denial model. A failed persistence operation never reports success. An audit-write failure rolls back the restriction change.

Owners see Restricted in Studio with the policy explanation and a contact path to `abuse@gno.sh` for review. They can still request ordinary deletion; deletion does not remove the moderation tombstone or enable exact-content re-import. The operator handles reporter follow-up and review requests manually by email. Do not automatically forward a report or reveal a reporter's identity to the publisher. No automatic response-time promise, appeal deadline, or notification-delivery guarantee.

Reinstatement requires explicit operator confirmation and an expected state/revision. It clears only the moderation block. It must not undelete content, clear owner revocation/expiry, restore old secret tokens, or automatically publish a withdrawn source. The owner sees the remaining state and can explicitly publish retained content if permitted. This avoids reviving content the owner independently removed.

## API Contracts

Use the existing session-backed server-function conventions. New operations can be named to fit the codebase, but must preserve these inputs and guarantees:

- Operator lookup accepts a validated public-route identity or exact target ID and returns only the metadata needed for review. Do not introduce broad private-content browsing or encrypted decryption.
- Takedown accepts target ID, expected revision, policy reason code, owner-visible explanation, and idempotency key. Server-side operator authorization is mandatory on every call, even if the page is hidden. Return operation ID and persisted restriction state.
- Reinstatement accepts target ID, expected restriction revision, review reason code, and idempotency key. Return the resulting moderation state and whether another lifecycle restriction still denies publication.
- Unknown targets, non-public/unrelated targets, unauthorized calls, stale state, validation failures, and database failures have explicit typed outcomes. Non-operators receive no private target metadata. Mutations use POST, existing CSRF/origin defenses, and parameterized persistence.
- Repeated successful operations are idempotent. Concurrent owner actions, takedowns, and reinstatements serialize through the shared lifecycle contract. Enforce moderation restrictions in database and fallback paths, or fail closed where an operator-capable runtime is unsupported.

## Edge Cases & Constraints

An abuse report does not establish a violation. Gordon or an authorized operator decides whether to act; no agent should infer a real-world takedown merely from receiving a report. Test with synthetic content and operator accounts.

No paid tier, public publisher, organization administrator, or ordinary user receives moderation powers. Production allowlist changes remain explicitly authorized operations.

For an unavailable public URL, keep reporting instructions usable without exposing its content. General policy/security/privacy email contacts remain available for cases outside public-reader reporting. Encrypted shares remain ciphertext and their passphrases remain client-only.

Application rollback must preserve active moderation denials. A schema downgrade or older application version that ignores the restriction is not a safe rollback; keep a compatible guard or disable affected readers until recovery. Restoring a database backup must reconcile deletion and moderation records before public readers resume.

## Acceptance Criteria

- **R1:** A public reader can open a contextual report page with the correct canonical URL, compose an email, or copy the address/template. General reporting still works without a target. Invalid inputs are actionable; opening an email draft is never labeled a submitted report. [paraphrase]
- **R2:** An authorized operator can take a public publication offline and verify denial on every content route. Unauthorized, stale, or failed operations make no successful state claim; owner mutations cannot clear moderation. [paraphrase]
- **R3:** Moderation authorization is server-enforced and independent of billing entitlement or organization roles. Missing operator configuration denies access. Tests cover forged inputs and direct endpoint calls. [inferred]
- **R4:** Active blocks survive republish, route changes, token rotation, source deletion, and an exact same-owner content re-import under another slug. No raw report data or content is retained in the restriction record. Edited-content and new-account evasion remain outside the bounded guarantee. [inferred]
- **R5:** Owners can see the restricted state and policy reason and request manual review without seeing reporter identity. Reinstatement clears only moderation and preserves owner deletion, revocation, expiry, and any other access restriction. [inferred]
- **R6:** Successful actions record a restricted audit receipt, and retries/concurrent operations behave consistently. An audit failure rolls back the mutation. Audit and active-block retention have documented, implemented handling; no indefinite raw evidence store is introduced. [inferred]
- **R7:** Terms, Acceptable Use, Report Abuse, and Privacy describe the implemented reporting channel, manual review, operator action, owner review contact, data categories/access, retention, and confidentiality limits. Existing fn-153 deletion wording and encryption boundaries remain accurate. Policies and feature ship together. [user]
- **R8:** Database/asset integration tests and running-app QA demonstrate reporting, authorization, takedown, exact-copy prevention, owner status, review/reinstatement, and failure recovery. No production content is used as a test fixture. [inferred]

## Boundaries

Public-share reporting and targeted operator takedown/reinstatement only. fn-153 owns export/import access and owner deletion. Exclude a report database/queue, evidence uploads, automated content classification, automatic sanctions, account-wide suspension UI, bulk moderation, cross-tenant deduplication, fuzzy matching, and encrypted-content inspection.

The implementation agent may draft policy wording that describes the finished system. This spec does not establish jurisdiction-specific legal compliance, impose invented statutory deadlines, or authorize external communications or production access changes.

## Decision Context

Gordon asked for an abuse-reporting mechanism and administrator takedown, then chose a separate follow-up. Existing Terms/AUP already permit investigation and restriction; the current Report Abuse page routes reports to email. The minimal first version makes this channel contextual and gives the operator a safe lifecycle action instead of adding a second report store.

The previous stub left channel, queue, admin scope, and reinstatement open. This handoff selects email intake, a narrowly authorized operator page, single-publication restrictions, manual review, and explicit reinstatement. These are implementation defaults selected under Gordon's request to make the specs ready, not quotations of earlier answers. Broader policy or moderation systems need a separate request.

## Policy and Release Work

Update these pages with the feature:

| Page | Required change |
|---|---|
| `/report-abuse` | Contextual URL, email/copy flow, information to include, manual review, follow-up contact, and an accurate statement that composing a draft has not submitted it |
| `/acceptable-use` | Connect prohibited conduct to the implemented manual handling and restriction/review path; avoid promising automated detection or a fixed decision time |
| `/terms` | Describe operator restriction and the owner review/reinstatement path, preserving the existing rights and fn-153's owner-deletion distinction |
| `/privacy` | Describe email reports, optional contact data and evidence, restricted operator access, minimal moderation/audit records, purposes, retention criteria, and actual processors used for this channel |

Use first-person singular as on the existing pages. Update the effective date in `src/lib/legal.ts` when the policy changes ship. Link the four pages consistently from the reporting flow, owner restriction message, and footer. Do not imply that the email channel provides absolute anonymity or confidentiality; state actual restricted handling without promising secrecy against legal requirements.

Before deploying revised policy text, verify with Gordon/the existing operations records where the abuse mailbox is hosted, who can read it, and how mailbox/audit retention and deletion are actually operated. The current Resend entry concerns transactional mail and is not evidence of the inbound mailbox provider. This is an operational verification gate, not a reason to invent a provider or retention duration in code or legal copy. Build and test the feature without needing production inbox access. If policy details cannot be verified, deliver the implementation and draft with that exact release blocker; do not publish misleading policy text.

Gordon approves the final public policy wording and any new operator allowlist configuration before deployment. If jurisdiction-specific legal review identifies additional notice/appeal/retention obligations, reconcile them before release; the implementation and this spec alone are not a compliance opinion.

## Verification and Documentation

Reuse fn-153's shared lifecycle tests and synthetic fixtures. Add operator authorization and reason validation tests, duplicate/stale action tests, denied reader/asset/agent-route tests, exact-content renamed-import tests, and reinstatement tests with an independently deleted or unpublished source. Include database failure and audit-write rollback. Test against the real PostgreSQL/object-storage integration path, not only fallback state.

Run the site's current `bun run check`, `bun run typecheck`, `bun run test`, `bun run test:integration`, and `bun run build`. Drive the local site at port 3344 with reader, owner, operator, and unauthorized sessions. Verify contextual report text, copy controls, keyboard/mobile use, Studio restriction reason, denial after takedown, and safe reinstatement. Capture live evidence through the applicable Flow QA workflow; no app means blocked QA. Do not send real reports or emails during tests.

Document the operator workflow, allowlist configuration, audit retention mechanism, exact-copy limitation, manual response/review procedure, migration, backup-restore reconciliation, and rollback that preserves denial. Update user-facing help alongside the policy pages. Verify deployed routes and policy links after an authorized release, retaining evidence and tested commit IDs.
