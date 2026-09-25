---
satisfies: [R1, R2, R3, R4]
---
# fn-182-web-ui-polish-after-retry-safe-writes.1 Implement Web UI polish after retry-safe writes

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Fixed four Web UI issues. The document view now updates its frontmatter tag list right after a tag save. After a lost, pending, 5xx or unreadable save response, the editor says the save may have completed and offers Retry save. The reload banner appears only when a read shows a different hash. Home dashboard collection rows wrap and truncate at 390px. The Search page now uses the shared snippet renderer, moved to `src/serve/public/lib/snippet.tsx`.

- R1: `DocView.tsx` applies `updateFrontmatterTags` to the loaded content on write-back. Tests: `DocView.dom.test.tsx`, where the saved tags show without a reload and a conflicting save keeps the previous tags and shows the error.
- R2: `DocumentEditor.tsx` holds change events while a save outcome is unknown. `use-api.ts` sets `outcomeUnknown`, and `writeOutcomeUnknown` in `lib/request-intent.ts` classifies HTTP errors. Tests: `DocumentEditor.dom.test.tsx` (lost response, genuine outside change, replay clear, replay after another write, failed verification read, pending retry, rejected retry) and `lib/request-intent.test.ts`.
- R3: `Dashboard.tsx` collection row uses flex-wrap, min-w-0 and truncate. Live scrollWidth equals viewport width at 390 and 1440 (before the fix: 535 at 390).
- R4: `Search.tsx` imports `renderSnippet` from `lib/snippet.tsx`, the one shared implementation with no `dangerouslySetInnerHTML`. Test: `Search.dom.test.tsx` covers highlights, escape removal and inert `<img>` text.
- Rebuilt `assets/spa-production.json.gz` and `globals.built.css`. `docs/WEB-UI.md` documents the lost-response notice.
- Screenshots in `.flow/tmp/fn-182-shots/`: before-home-390, after-home-{390,1440}[-collections], after-search-1440, after-search-390, after-tags-saved-1440, after-lost-save-1440, after-retry-confirmed-1440, after-outside-change-1440.
- Baseline: green (full `bun test` passed before any edit).

Tier: session

stage: impl-review - ran (codex gpt-6-astra:medium; round 1 fan-out NEEDS_WORK with 3 findings fixed, round 2 SHIP)
## Evidence
- Commits: ecb2c31adaf78f7850956f1986dfa503e9c2e19b, d0ea92bb938779cf48bce133b493087b548a5558, 89e2efce3500cd6cdef139b12bb98a4216f4470b
- Tests: mise exec bun@1.4.2 -- bun test (5753 pass, 0 fail; baseline green 5742 pass), mise exec bun@1.4.2 -- bun test test/serve/public test/serve/spa-snapshot-freshness.test.ts, mise exec bun@1.4.2 -- bun run lint:check, mise exec bun@1.4.2 -- bun run docs:verify, agent-browser live QA on isolated gno serve :43182 at 1440x900 and 390x844 (scrollWidth == innerWidth); screenshots .flow/tmp/fn-182-shots/
- PRs: