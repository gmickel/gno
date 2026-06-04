# fn-82-second-brain-capture-and-provenance.6 Close docs hosted site skill and golden parity tests

## Description

Close the spec by proving cross-surface parity and synchronizing all user-facing documentation, skill copy, repo docs, and hosted `gno.sh` content.

This is not a loose docs cleanup task. It owns the final parity check and ensures no surface tells a different story about capture, provenance, collision policy, sync/FTS ingestion, or embedding. Task 1 owns canonical schema/status snippets; this task owns the final sweep and drift fix.

Expected files:
- `README.md`
- `docs/CLI.md`
- `docs/API.md`
- `docs/MCP.md`
- `docs/SDK.md`
- `docs/WEB-UI.md`
- `docs/QUICKSTART.md`
- `docs/USE-CASES.md` if second-brain narrative changed
- `spec/cli.md`
- `spec/mcp.md`
- `spec/output-schemas/*capture*.schema.json`
- `assets/skill/SKILL.md`
- `assets/skill/cli-reference.md`
- `assets/skill/mcp-reference.md`
- `assets/skill/examples.md`
- `assets/skill/README.md`
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`
- `/Users/gordon/work/gno.sh/src/lib/product-pages.ts`
- `/Users/gordon/work/gno.sh/src/lib/site-content.ts`
- `/Users/gordon/work/gno.sh/src/routes/index.tsx`
- cross-surface parity tests under the most appropriate existing test directory

Parity target:
- Same logical input through CLI, API, MCP, and SDK writes the same frontmatter/body and returns the same receipt fields except known transport metadata.
- Docs state the same field names, default UTC path, collision behavior, editable-collection requirement, binary/NUL/size rejection, write gates, sync/FTS state, and embed/vector behavior.

## Acceptance

- [ ] **R1:** Cross-surface golden tests cover CLI, REST/API, MCP, and SDK with the same logical capture input and verify frontmatter/body/receipt parity.
- [ ] **R2:** Repo docs, specs, schemas, skill assets, and hosted `/Users/gordon/work/gno.sh` docs all describe the same capture/provenance model.
- [ ] **R3:** Docs clearly distinguish raw note creation, capture-with-provenance, and editable-copy-from-converted-doc.
- [ ] **R4:** Docs explicitly state default UTC write location, editable collection requirement, collision behavior, binary/NUL/size rejection, MCP write gating, deprecated `overwrite` compatibility, and embed/not-embed behavior.
- [ ] **R5:** `bun run website:sync-docs`, `bun run docs:verify`, `bun run lint:check`, and `bun test` pass, or failures are documented with concrete blockers.
- [ ] **R6:** Hosted `gno.sh` changes are verified locally; if `/Users/gordon/work/gno.sh` is unavailable, record it as a blocker and do not mark the task complete with stale hosted docs.
- [ ] **R7:** If this task is part of a release/ship pass, hosted deployment requirements and post-deploy verification are recorded before closeout.

## Done summary

## Evidence

- Commits:
- Tests:
- PRs:
