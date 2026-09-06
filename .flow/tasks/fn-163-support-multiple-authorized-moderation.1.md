---
satisfies: [R1, R2, R3, R4]
---
# fn-163-support-multiple-authorized-moderation.1 Support and release the approved operator allowlist

## Description
Implement the parent spec; host owns real account configuration, production verification, release and completion.

## Acceptance
All R1-R4 in parent spec satisfied; production actions and release remain with host.

## Done summary
Implemented and deployed an explicit moderation operator allowlist while preserving the legacy singleton setting. The user-authorized second account can access the moderation page and perform a read-only lookup through its existing production session. Runtime configuration contains exactly the two approved immutable account IDs; the existing operator is retained. Anonymous users redirect to login; synthetic unrelated users are denied. No takedown or reinstatement occurred.

R1: exact-ID allowlist tests and native login/access/lookup for both synthetic operators passed. R2: singleton compatibility and plural-only fail-closed runtime tests passed. R3: operator docs and example configuration updated; only synthetic IDs committed. R4: site PR58 merged and production artifact/source55b4925 verified; actual authenticated Gmail session renders the lookup form and successfully looks up the existing public synthetic fixture.

Validation:20 focused tests,356 unit tests,check,typecheck,build; GitHub CI also passed database integration and deployment tests. Quick Fable5.1medium review returned SHIP. Its optional singleton whitespace suggestion was not adopted: this keeps legacy comparison semantics unchanged. Live QA4/4passed, no open findings. Session credentials remained in server memory; configuration backup is access-controlled and outside the repo.

stage: impl-review - SHIP (Fable5.1medium, actual receipt copied without alteration)
stage: plan-sync - skipped (single task; no downstream task rewrite needed)
Product commits:46700f3; merged/deployed55b4925. PR:https://github.com/gmickel/gno.sh/pull/58
## Evidence
- Commits: 46700f3e0a9477a9bb3ee3770cfc11f8ac06b2aa
- Tests: baseline: no parent Quick commands; supplemental focused baseline green (10 tests), bun install --frozen-lockfile (pass), bun run test src/lib/moderation-functions.test.ts src/lib/publish-runtime.test.ts (pass: 20 tests), bun run check (pass), bun run typecheck (pass), bun run test (pass: 356 tests; 36 integration tests skipped by standard runner), bun run build (pass), git diff --check (pass), GitHub CI34036707956 Checks SUCCESS including database integration and deployment tests, Native browser: both operators access and lookup; ordinary user denied; no moderation state change, Production authenticated existing-session moderation page and read-only lookup passed; exact two configured operators; source and .output/REVISION55b4925 match, Fable5.1medium implementation review SHIP
- PRs: https://github.com/gmickel/gno.sh/pull/58