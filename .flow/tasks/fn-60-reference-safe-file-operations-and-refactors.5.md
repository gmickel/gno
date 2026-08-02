---
satisfies: [R1, R3, R4]
---
# fn-60-reference-safe-file-operations-and-refactors.5 Freeze reference-refactor safety contract and fixture matrix

## Description
Define the versioned preview/apply contract, reason-code taxonomy, mutation boundary, stale-plan rules, and representative link fixture matrix for reference-preserving rename/move. Extend the existing path planners; do not rebuild shipped workspace operations.

**Size:** M
**Files:** `src/core/file-refactors.ts`, `spec/cli.md`, `spec/mcp.md`, `spec/output-schemas/`, `test/core/file-refactors.test.ts`

### Approach
- Preserve `planRenameRefactor()` / `planMoveRefactor()` compatibility while adding a transport-neutral plan and result contract.
- Specify exact filesystem atomicity versus post-commit index convergence.
- Define stable reason codes and deterministic plan digests before surface work.
- Build fixtures that prove token-level preservation across wiki and CommonMark link shapes.

### Investigation targets
**Required** (read before coding):
- `src/core/file-refactors.ts:42-180` — shipped planners and warning compatibility
- `src/core/links.ts` — parsed link vocabulary
- `src/core/document-capabilities.ts` — editable/read-only gate
- `spec/mcp.md:1715` — current workspace write contract
- `test/core/links.test.ts` — parser fixture patterns

**Optional** (reference as needed):
- `docs/GLOSSARY.md` — Wiki Link, Markdown Link, and Section Link vocabulary
- CommonMark 0.31.2 links — destination/label/reference semantics

### Key context
The plan must be useful before any mutation and invalidated by changed source content. MCP annotations are hints, not authorization. Do not invent a single transaction spanning filesystem and reindexing.

## Acceptance
- [ ] Versioned preview/apply schemas cover source/target URIs, affected edits, classifications, fingerprints, plan digest, safety summary, and terminal result states.
- [ ] Reason codes distinguish ambiguous, unsupported, malformed, stale, capability-denied, occupied-target, and sync-pending cases.
- [ ] Fixture matrix includes aliases, fragments, titles, reference definitions, relative paths, duplicate names, Unicode, encoding, code fences, HTML, and malformed syntax.
- [ ] Contract states which bytes may change and defines filesystem rollback/recovery separately from index convergence.
- [ ] Focused schema/core tests and lint checks pass.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
