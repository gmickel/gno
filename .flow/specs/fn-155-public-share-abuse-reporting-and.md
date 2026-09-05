# Public-share abuse reporting and administrator takedown

## Goal & Context

Provide a clear way to report abusive public content on gno.sh and for an authorized administrator to take it offline. Gordon raised this while refining publishing permissions and owner deletion in fn-153, then explicitly requested a separate follow-up stub. [paraphrase]

## Architecture & Data Models

The existing Report Abuse page provides an email reporting channel. The choice between improving that channel and adding a report form, stored reports, and a moderation queue remains open. [inferred; current-code observation]

## API Contracts

Administrator moderation must be distinct from a content owner's ordinary unpublish/delete permissions. Concrete interfaces remain to be defined. [inferred]

## Edge Cases & Constraints

Consider unauthorized takedowns, malicious or duplicate reports, report privacy, repeated abuse, reinstatement, and preventing an owner from immediately bypassing a moderation takedown. No automatic moderation or legal-compliance claim is established by this stub. [inferred]

## Acceptance Criteria

- **R1:** A reader can report a specific public share through a discoverable reporting path. Errors: a missing or invalid share reference receives an actionable response; exact reporting-channel behavior remains to be refined. [paraphrase]
- **R2:** An authorized administrator can take reported public content offline. Errors: unauthorized attempts do not change publication state, and failed takedowns are not reported as successful. [paraphrase]

## Boundaries

- Follow-up to fn-153; owner export/import permissions, owner deletion, and Studio cleanup stay in that spec. [paraphrase]
- Report-channel design, moderation scope, retention, notifications, and reinstatement policy are unresolved rather than implicitly approved. [inferred]

## Decision Context

Gordon: "we probably need an abuse report thing for public stuff? so we the admin can take stuff down, not sure". After being offered reporting/admin controls in the main change or a follow-up, Gordon chose: "separate follow up, create a stub spec for it". [user]

## Open Questions

- Improve the existing email channel or build an in-product form and queue? Owner: product.
- What admin roles, evidence handling, retention, account restrictions, and reinstatement rules apply? Owner: product and engineering.

## Resolved via Codebase

- gno.sh already has an email-based Report Abuse page and a footer link; see `src/routes/report-abuse.tsx` and `src/components/site/site-footer.tsx` in the hosted-site repository. This stub extends existing reporting rather than claiming it is absent.
