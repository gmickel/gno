---
satisfies: [R1, R2]
---
# fn-191-windows-request-id-writes-start.1 Implement Windows request-ID writes start PowerShell on every CLI call

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Windows request-ID writes skip the PowerShell ACL spawn once the ledger directory is verified: a marker inside the directory records dev:ino plus a sha256 of the owner+DACL bytes; later processes read the descriptor in-process (bun:ffi GetFileAttributesW/GetFileSecurityW) and skip only when identity and digest match and the descriptor independently parses as owner-only, otherwise the authoritative PowerShell check runs and still refuses before any write. Design, rejected options (ctime churns on WAL create/delete), and residual risk are in the spec's Completion record; Windows timing comes from CI (Windows-only test asserts no second spawn and a refused icacls grant).

Tier: session (security-sensitive)
stage: impl-review - ran (codex gpt-6-astra fan-out, 3 draws SHIP, round 1)
## Evidence
- Commits: 44d26e472e4114f5c3ffc0105240f426f121f50e
- Tests: bun test test/core/request-receipts.test.ts (31 pass, 1 Windows-only skip; mutation-checked: removing marker, identity, or digest each fails its test), bun test (5802 pass, 3 skip, 0 fail), bun run lint:check (0 errors), baseline: green (bun test test/core/request-receipts.test.ts pre-edit)
- PRs: