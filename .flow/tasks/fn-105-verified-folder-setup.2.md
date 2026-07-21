---
satisfies: [R1, R2, R4, R5]
---
# fn-105-verified-folder-setup.2 Add safe setup CLI UX and semantic background handoff

## Description
Deliver add safe setup cli ux and semantic background handoff as one implementation-sized increment.

**Size:** M
**Files:** `src/cli/program.ts`, `src/cli/commands/setup.ts`, `src/embed/backlog.ts`, `src/core/job-manager.ts`, `test/cli/setup.test.ts`

### Approach
- Add `gno setup <folder>` options/terminal/JSON output with progress on stderr and versioned receipt on stdout.
- Derive collision-safe collection names, preserve granular commands, and hand semantic model/embed work to a resident job when available or an explicit resumable command otherwise.
- Implement secret-risk preflight for common credential/private-key/env paths; interactive confirmation is explicit, while noninteractive JSON fails closed unless exclusions are provided.

### Investigation targets
**Required** (read before coding):
- `src/cli/program.ts:924-1060`
- `src/cli/commands/init.ts`
- `src/embed/backlog.ts`
- `src/core/job-manager.ts`
- `src/ingestion/walker.ts`

**Optional** (reference as needed):
- `src/config/defaults.ts`
## Acceptance
- [ ] CLI supports name/connector/no-semantic/JSON with clean output and concise remediation.
- [ ] Lexical search is usable immediately while semantic work is a truthful pending background/resume state.
- [ ] Secret-risk, empty/unsupported, nested, collision, symlink, huge/network-volume, and noninteractive cases fail safely or require explicit exclusions/confirmation.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
