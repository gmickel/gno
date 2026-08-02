---
satisfies: [R5, R6]
---

# fn-60-reference-safe-file-operations-and-refactors.8 Adopt canonical refactor semantics in REST and Web UI
## Description
Move REST and Web UI rename/move flows onto the canonical preview/apply service. Preserve current operation-specific routes while showing exact affected references, confirmation state, conflicts, rollback, and sync-pending outcomes in existing workspace dialogs.

**Size:** M
**Files:** `src/serve/routes/api.ts`, `src/serve/public/pages/DocView.tsx`, `src/serve/public/pages/Browse.tsx`, `test/serve/api-docs-lifecycle.test.ts`, `test/serve/public/`

## Approach
- Keep REST as the browser transport and adapt the canonical core result rather than implementing link logic in handlers.
- Add affected-reference preview/confirmation to existing dialogs and use current Scholarly Dusk patterns.
- Preserve route compatibility while making plan digest, stale/conflict, rollback, and sync-pending states explicit.

## Investigation targets
**Required** (read before coding):
- `src/serve/routes/api.ts:2385-3026` — shipped preview/execute routes
- `src/serve/public/pages/DocView.tsx` — current note action dialogs
- `src/serve/public/pages/Browse.tsx` — current folder/refactor flows
- `test/serve/api-docs-lifecycle.test.ts` — REST lifecycle coverage
- `docs/adr/001-scholarly-dusk-design-system.md` — interaction vocabulary

**Optional** (reference as needed):
- `test/serve/public/components/QuickSwitcher.dom.test.tsx` — contextual-action DOM patterns

## Design context
The preview extends existing dialogs/rails; it must not introduce generic admin-tool styling. Safety status and unresolved items must remain readable at keyboard and narrow widths.

## Key context
Surface parity means a shared semantic result, not a generic action endpoint. A durable filesystem commit with pending sync is a success-with-recovery state, not a generic failure toast.

## Acceptance
- [ ] REST preview/apply uses the canonical service and no handler contains independent link-rewrite logic.
- [ ] UI shows planned documents/rewrites/unresolved items and requires confirmation of the exact plan digest.
- [ ] Stale, denied, conflict, rollback, and sync-pending states have accessible, actionable behavior.
- [ ] Existing rename/move route compatibility and duplicate/folder behavior remain unchanged.
- [ ] Focused REST/UI tests and lint pass.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
