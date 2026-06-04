# fn-82-second-brain-capture-and-provenance.5 Wire Web UI quick capture to provenance flow

## Description

Update the Web UI quick capture path so it uses the same capture/provenance flow as CLI/API/MCP/SDK while keeping simple capture fast.

This task should extend the existing quick capture modal rather than creating a separate product surface. Provenance fields should be available as progressive detail, not required for basic capture.

Expected files:

- `src/serve/public/components/CaptureModal.tsx`
- `src/serve/public/*` adjacent state/components as needed
- `src/serve/routes/api.ts` only if UI needs route response changes from task 3
- `docs/WEB-UI.md`
- `docs/QUICKSTART.md`
- `README.md`
- `assets/skill/examples.md`
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`
- `/Users/gordon/work/gno.sh/src/lib/product-pages.ts` if product story changes
- relevant serve/UI tests

UX requirements:

- Basic text capture remains one quick action.
- Optional provenance fields include kind, title, URL, author, observed date, and external id where practical.
- Success state tells the user whether the note is written, sync/FTS ingested, and embedded/pending/skipped/failed.
- Missing editable collection, no job id, sync busy/deferred, failed sync, and embed skipped/pending states are visible and actionable.

## Acceptance

- [ ] **R1:** Web UI quick capture uses the shared capture/API contract rather than raw note creation semantics where provenance matters.
- [ ] **R2:** Provenance fields are available without making simple text capture heavier.
- [ ] **R3:** Success/error UI distinguishes written, sync/FTS pending/running/skipped/failed/completed, and embed pending/skipped/failed/completed states.
- [ ] **R4:** UI handles no job ID, busy sync, skipped sync, failed sync, missing editable collection, and embed skipped/pending without always assuming `IndexingProgress` applies.
- [ ] **R5:** UI tests or browser-level verification cover basic capture, provenance capture, missing collection, sync-busy/deferred behavior, and no-job receipt behavior.
- [ ] **R6:** `docs/WEB-UI.md`, quickstart/README references, skill examples, and hosted `gno.sh` Web UI docs are updated with UI-specific examples only, reusing canonical task-1 schema/status wording.
- [ ] **R7:** If this work registers capture in the command/action palette, coordinate with `fn-63-workspace-native-commands-and-agent-callable-actions.1` instead of inventing a parallel action model.

## Done summary

## Evidence

- Commits:
- Tests:
- PRs:
