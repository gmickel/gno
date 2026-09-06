---
satisfies: [R1, R2, R3, R4, R5, R6, R7]
---
# fn-156-reader-reading-time-total-views-and.1 Implement Reader reading time, total views, and Markdown copy

## Description
Implement the parent spec using the hosted reader shared by all publication modes.

Partial implementation is preserved in gmickel/gno.sh commit c171f5930c78875c2e4884c32e1cc7124cec23e9 (ancestry merge c4bd705 has the same product tree). Reading time, current-note Markdown copy, plain-mode aggregate views, nonblocking collection, and configured-home selection are implemented. Final lint, typecheck, 354 unit tests, 39 database integration tests, and build passed. Live utility checks passed across all four modes; four slow-counter-storage checks served content while the aggregate table was locked and subsequently advanced totals.

The task remains in progress. R2/R6 are incomplete: existing exports lack stable note identity and a server-verifiable encrypted note roster. The resumed scope now includes durable private export identities and an optional UUID roster for encrypted spaces, as specified in the parent spec. Implementation is underway in both repositories. Source-path moves create a new identity; content edits, index rebuilds, and published-route changes preserve it. Legacy encrypted artifacts require re-export before per-note counts are available. Full paired performance acceptance, final Flow QA, Fable implementation review, and release remain pending. Do not infer full-spec acceptance from these partial results.

Private reproducible handover: .flow/tmp/fn156-summary.md and .flow/tmp/fn156-evidence.json in this worktree. Runtime evidence stays outside the repository; no synthetic credentials or encrypted payloads are included here.
## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
