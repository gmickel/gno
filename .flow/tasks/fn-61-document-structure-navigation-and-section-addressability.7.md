---
satisfies: [R3, R5, R6]
---
# fn-61-document-structure-navigation-and-section-addressability.7 Integrate citation-safe links and verify compatibility end to end

## Description
Integrate durable target creation/recovery into existing copy-link and navigation flows without changing the readable fragment experience, then complete adversarial/live QA and documentation across repo, skill, and gno.sh.

**Size:** M
**Files:** `src/serve/public/pages/DocView.tsx`, `src/serve/public/components/QuickSwitcher.tsx`, `src/serve/public/lib/`, `test/serve/public/`, `docs/`, `README.md`, `assets/skill/`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

### Approach
- Keep current outline and `#anchor` behavior; add target evidence compatibly to copy/resolve flows.
- Define privacy-safe URL/copy behavior and bounded selector encoding.
- Drive exact, recovered, ambiguous, stale, and old-link scenarios in a running workspace.
- Re-run skill autoresearch because MCP/retrieval instructions gain a section-target path.

### Investigation targets
**Required** (read before coding):
- `src/serve/public/pages/DocView.tsx:566-610,1169-1235` — current scroll/copy-link UX
- `src/serve/public/components/QuickSwitcher.tsx:103-130,338-367` — section navigation
- `test/serve/public/lib/deep-links.test.ts` — current URL compatibility
- `docs/WEB-UI.md:680` — shipped outline/deep-link promise
- `assets/skill/SKILL.md` — retrieval instructions
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx` — hosted docs source

**Optional** (reference as needed):
- `docs/adr/001-scholarly-dusk-design-system.md` — UI interaction vocabulary
- `scripts/docs-verify.ts` — docs gate

### Design context
Preserve the Scholarly Dusk outline/rail and readable-link interaction. Recovery status must be understandable without adding persistent editor chrome.

### Key context
Do not leak full private section content in copied URLs, logs, or telemetry. Production deploy is a separate authorized boundary after gno.sh merge.

## Acceptance
- [ ] Existing readable section links still open and current copy-link output remains human-understandable.
- [ ] Running UI/API/MCP QA captures exact recovery, unique edit recovery, and non-navigation for ambiguous/stale targets.
- [ ] Selector output is size-bounded and privacy-reviewed; logs/errors do not expose embedded section bodies.
- [ ] Full focused tests, lint, docs verification, and applicable E2E pass.
- [ ] Repo docs/specs/skill and hosted gno.sh pages agree; skill autoresearch passes or records a justified no-change result.


## Done summary
Integrated citation-safe section links across the Web UI, REST API, SDK, and MCP. Added readable human links alongside bounded versioned durable targets, fail-closed exact/recovered/ambiguous/stale behavior, updated the installed skill guidance and hosted gno.sh reference documentation, and verified both product and documentation surfaces live.
## Evidence
- Commits: 2ffa6971d396ed447c1ea6f1d1793ac07e33696d, b405e92e5b93376c9f25f19049ed25d3c5282efe
- Tests: bun test: 3698 pass, 2 expected skips, 0 fail, bun run lint:check: 0 warnings, 0 errors, bun scripts/docs-verify.ts: 15 pass, 2 model-cache skips, gno skill autoresearch eval: 47/47, 100%, flow-next QA: SHIP, 6/6 R-IDs covered, no P0/P1, gno.sh bun run check: pass, gno.sh bun run typecheck: pass, gno.sh bun run build: pass, 92 pages prerendered, local live QA: Web UI, REST, Streamable HTTP MCP, and gno.sh docs verified
- PRs: