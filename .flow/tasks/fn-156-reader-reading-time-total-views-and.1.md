---
satisfies: [R1, R2, R3, R4, R5, R6, R7]
---
# fn-156-reader-reading-time-total-views-and.1 Implement Reader reading time, total views, and Markdown copy

## Description
Implement the parent spec across durable GNO export identities and the shared gno.sh reader. Reading estimates, aggregate views, Copy Markdown/Shift+Y, encrypted ID rosters and all authorization/lifecycle boundaries are implemented.

Final development and live QA evidence covers R1-R7. GNO product checks and requested Fable review passed. Hosted 780840b0 passed check/typecheck/build, 386 unit tests, 41 database integration tests, requested Fable review and actual reader/access/clipboard/lifecycle QA. Final HTTP and 96-navigation browser evidence are recorded in the done summary. Gordon accepted the small HTTP threshold exceedance; raw measurements and limitations remain preserved. No open product findings remain.

Release follows through GNO PR #226 and gno.sh PR #59. Private reproductions are in .flow/tmp/fn156-final-summary.md and .flow/tmp/qa-fn-156-reader-reading-time-total-views-and/.
## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Implemented and verified the hosted reader utilities and their local export identities. GNO product code is unchanged from the reviewed implementation through 12f66c79; hosted code is 780840b0. GNO PR #226 and gno.sh PR #59 carry the coordinated release.

### Requirement evidence

- R1: Live public, secret-link, invite-only and encrypted notes show the expected prose estimates. Empty/code-heavy/multilingual fixtures, updates, and client-only encrypted processing were exercised.
- R2: Actual navigation, refresh and return increment once; rerenders, search, raw Markdown, assets, manifest/llms fetches, prefetch, failed access and failed unlock do not. Counts survive revision, slug and access changes. New copies start at zero. Stable export IDs survive index rebuilds; source moves explicitly create new identities.
- R3: Actual request/storage inspection found aggregate-only note counting without visitor identifiers, referrers or analytics browser storage. Existing authentication remains separate. Encrypted signals contain authorized opaque IDs only.
- R4: Focused buffer/writer tests and actual storage-lock/checkout-timeout runs verify bounded failure isolation and recovery. The definite pre-SQL checkout failure found during QA was fixed in 68a95a9 and reproduced successfully after the fix. All 2,990 accepted views in the final 3,000-display stress test persisted; ten rejected view signals and eleven unavailable count reads are retained as documented failure behavior.
- R5: Native clipboard, current-note title/structure, image placeholders, Shift+Y, modifiers/editable contexts, fallback selection/cleanup and mobile layout passed. Copy and reading time work before the delayed total appears.
- R6: Actual owner/unauthorized, cross-owner, opaque-ID, withdrawal, expiry, token rotation, moderation and deletion checks passed. Final 780840b0 live invite owner/view/count and anonymous denial checks passed. Six focused view/count cases preserve organization membership and user owner/allowlist/override rules.
- R7: Check/typecheck/build, 386 hosted unit tests and 41 database integration tests passed. GNO passed 5,258 local tests (two platform/opt-in skips), subsequent focused 106 tests, current-head hosted CI, lint, package smoke, documentation verification and 47/47 skill evaluation. Both requested quick Fable 5.1 medium reviews returned SHIP with no new findings.

### Performance acceptance

Final sustained HTTP uses fixed CPU affinity, two invite-only note sizes, concurrency eight, three repeats per side, 100 untimed warm-up requests and 400 timed requests per block. All samples remain in the reported p95. The 1 KB case was 37.80 ms baseline versus 43.95 ms changed, 1.15 ms above the initial bound. The 16 KB case was 134.30 versus 139.05 ms and passed the raw bound. The prior material threefold gap did not reproduce. Gordon explicitly accepted small millisecond threshold misses and instructed release; this clarification is recorded in the parent spec. Raw failure flags and earlier runs remain intact.

Browser measurements cover 96 navigations across all four modes, desktop/mobile and cold/warm browser cache. The changed build had no page/protocol errors or overflow. All 54 displayed candidate navigations persisted exactly. Plaintext median LCP ranged from 52 to 96 ms, versus 56 to 188 ms baseline. Maximum CLS remained 0.197629 in the encrypted mobile cold case. Encrypted mobile LCP was unavailable in six candidate samples and remains null; encrypted mobile warm unlock median was 132 ms slower. These are recorded observations, without an invented browser threshold or claim that every metric improved.

The final browser run used visible-note and hydration readiness after two preserved automation-readiness failures. Baseline rows had stricter network-idle readiness before the same visible-heading wait. This sampling limit and all failed attempts are retained.

### Evidence and remaining release work

Private reproductions and SHA-256 manifests are linked from .flow/tmp/qa-fn-156-reader-reading-time-total-views-and/, including full functional evidence on 68a95a9, delayed-count evidence on 1e6f47d, final access evidence on 780840b0 and final HTTP/browser receipts. GNO and site implementation review receipts are tracked separately. No open product findings remain. Merging, npm publication, hosted deployment and production verification follow this completed implementation/QA stage.
## Evidence
- Commits: 12f66c79faae8775772921b3ddea40cc0fb82d37, d7bb6da2ed0f305536d7358f7188b305e18cc7d6, 780840b0080f021e310bcf96b325cce46f12d63b, 68a95a9db97d611aeb489c7d5ddc4f47856d45dd
- Tests: GNO Bun 1.4.2: lint, 5258 tests, focused 106 tests, package smoke, docs verification, skill eval 47/47, gno.sh: check, typecheck, build, 386 unit tests, 41 DB integration tests, Actual four-mode reader, clipboard, authorization/lifecycle and failure/recovery QA, Final sustained HTTP 12 blocks, all 4800 timed samples, small threshold exceedance accepted by Gordon, 96 browser navigations and exact 54 candidate displayed-view persistence, Quick Fable 5.1 medium implementation review SHIP for GNO and gno.sh
- PRs: https://github.com/gmickel/gno/pull/226, https://github.com/gmickel/gno.sh/pull/59