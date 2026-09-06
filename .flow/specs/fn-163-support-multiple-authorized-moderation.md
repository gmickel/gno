# Multiple authorized moderation accounts

## Goal & Context
Gordon explicitly requested adding his verified Gmail account as a moderation administrator while retaining the existing administrator, before finishing and deploying fn-156. The deployed singleton operator setting cannot represent both accounts.

## Architecture & Data Models
Support an explicit server-only comma-separated immutable user-ID allowlist. Preserve the legacy singleton setting during upgrade and rollback. Reuse existing authorization; no email-based grants, role inference, account creation, or moderation actions.

## Acceptance Criteria
- **R1:** Both explicitly configured immutable user IDs pass the access gate; unknown, partial-match, missing-session, and empty-configuration cases remain denied.
- **R2:** Legacy singleton configuration still works; a plural-only operator configuration retains fail-closed database runtime selection.
- **R3:** Tests and operator configuration documentation cover the allowlist; no real user IDs or credentials enter the repo.
- **R4:** Deploy the compatible change, configure exactly the two approved existing verified accounts, and verify the real authenticated moderation page and read-only lookup. No takedown or reinstatement occurs.

## Boundaries
Only the two accounts authorized by Gordon. No reporting UX change and no unrelated permission grants. Hosted implementation is in gno.sh; repository tracking remains in GNO.

## Verification
Focused authorization regression tests, repository quality gates, quick Fable 5.1 medium implementation review, synthetic live access checks, and authenticated read-only production verification.
