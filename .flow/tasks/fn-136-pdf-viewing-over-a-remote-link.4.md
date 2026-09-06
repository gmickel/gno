---
satisfies: [R2]
---
# fn-136-pdf-viewing-over-a-remote-link.4 First paint from page 1 geometry

## Description
Implement R2. Publish page slots as soon as page 1 geometry resolves, use page 1 dimensions as the placeholder for unmeasured pages, correct slots and fit scale when the full geometry pass lands, and keep already-rendered pages mounted when a later page's geometry fails. Depends on task .3: its relay measurement is the gate that decides whether client-side rendering stays the approach.

**Size:** M
**Files:** `src/serve/public/hooks/use-pdf-pages.ts`, `src/serve/public/components/pdf/PdfViewer.tsx`, `test/serve/public/hooks/use-pdf-pages.dom.test.tsx`, `test/serve/public/components/pdf/PdfViewer.dom.test.tsx` (or the existing PdfViewer test file if one exists under `test/serve/public/components/pdf/`)
**Touches:** [src/serve/public/hooks/use-pdf-pages.ts, src/serve/public/components/pdf/PdfViewer.tsx, test/serve/public/hooks/use-pdf-pages.dom.test.tsx, test/serve/public/components/pdf/**]

### Approach
- In the geometry effect (`src/serve/public/hooks/use-pdf-pages.ts:290-401`) resolve page 1 first, publish slots with page 1 width and height for every page, compute the fit scale from page 1, then let the 4-worker pass continue and republish with real sizes and the recomputed `maxWidth`/`maxHeight` scale in one commit. Keep the per-document geometry cache (`geometryCacheRef`) holding the full pass only, and say so in a code comment.
- Preserve the scroll anchor of the page in view when slot heights change: adjust the scroll position by the height delta of the pages above it, following the existing slot and visibility model (`syncSlotWindow` `:276-288`, `computeActiveSet`).
- Split the hook's error state into a fatal error (page 1 geometry or document-level failure, current behaviour) and a nonfatal later-page geometry error carried on the affected slot. `PdfViewer.tsx` today renders pages only while `viewerError === null` (`PdfViewer.tsx:188`, `:389-390`), so any hook error unmounts every page. Change the viewer so only the fatal error takes the fallback path; a nonfatal error keeps existing slots mounted and surfaces the page error state on the failed slot. Add `PdfViewer.tsx` tests for both paths.
- Rewrite the existing all-or-nothing geometry test ("mixed-size geometry and fit modes use every page without eager canvas renders", `use-pdf-pages.dom.test.tsx` about line 1520) rather than working around it; add cases with deferred `getPage` promises so page 1 resolves first, mixed-size fixtures settle to correct heights, fit-width recomputes against the widest page, and the scroll anchor holds.

### Investigation targets
**Required** (read before coding):
- `src/serve/public/hooks/use-pdf-pages.ts:276-401` — slot window and geometry effect
- `src/serve/public/components/pdf/PdfViewer.tsx:180-205` and `:380-400` — viewerError derivation and the progressive/error gating
- `test/serve/public/hooks/use-pdf-pages.dom.test.tsx:1500-1620` — mixed-size geometry test and deferred promise helpers

**Optional** (reference as needed):
- `src/serve/public/components/pdf/PdfViewer.tsx:140-200` — container measurement and fit mode reset
- `src/serve/public/components/pdf/PdfPageView.tsx:70-140` — placeholder and canvas mount

### Key context
- The fit scale currently depends on max dimensions across all pages, so a page-1-only publish needs a second scale commit; a scale change already cancels and re-renders in-flight pages (`use-pdf-pages.ts:793-800`).
- Placeholder correctness is part of the scroll model (comment at `use-pdf-pages.ts:290-292`); the correction must not make the page in view jump.
- The current effect is all-or-nothing: it throws and blanks every slot when `resolved.length !== numPages` or any `getPage` fails. R2 replaces that invariant deliberately.
## Acceptance
- [ ] Slots publish and page 1 renders before later pages' geometry resolves
- [ ] Mixed-size documents settle to correct per-page heights; fit-width and fit-page recompute against the widest measured page in one commit
- [ ] The top edge of the page in view stays fixed when later heights land (test asserts the scroll adjustment)
- [ ] A later-page geometry failure keeps already-rendered pages mounted and shows the page error on the failed slot; a page 1 or document-level failure still takes the existing fallback path (PdfViewer tests for both)
- [ ] The all-or-nothing geometry test is rewritten; existing use-pdf-pages and PdfViewer tests pass; `bun test` and `bun run lint:check` pass
## Done summary
Implemented R2. `usePdfPages` publishes every slot as soon as page 1's geometry resolves (page 1's size as the placeholder for unmeasured pages, fit scale from page 1) so the first page paints before the rest of the document is measured; when the 4-worker pass lands, per-page sizes and the fit-width and fit-page scale (against the widest measured page) are corrected in one commit, and the scroll container is shifted by the height delta of the pages above the page in view in a layout effect so the top edge holds. The hook's `error` is fatal-only (page 1 geometry, document-level failure); a later page's `getPage` failure, whether hit by the geometry pass or by the render path during the placeholder window, rides on `PageSlotState.error` and `PdfViewer` renders a per-page status slot in its place while every other page stays mounted. The geometry cache holds the full pass only.

Review round 1 (Opus, host backend): NEEDS_WORK. P1: a render-path `getPage` failure for pages 2-3 in the placeholder window was still fatal; P2: native scroll anchoring double-compensated the hook's adjustment; P2: the anchor page came from the overscan-inflated visible set; P3: per-page error slot used role="alert"; FYI: the correction did not open an admission epoch. All addressed through the Grok bridge in the review-fix commit: nonfatal slot error for pages after page 1 with a hook test that observes page 2 before failing it; `.gno-pdf-page-column` sets `overflow-anchor: none` and the smoke asserts that CSS contract on the live page; the anchor is derived from slot element offsets against `scrollTop` with a fallback to the visible-set anchor; role="status"; the correction commit opens an admission epoch. Focused suites 135 pass, lint clean, `bun run test:e2e:pdf` PASSED on the fixed tree. Round 2: SHIP, with one P3 (the correction commit cleared the fatal viewer error unconditionally) closed after the verdict by a conductor commit that clears it only on the placeholder commit.

Follow-up not built (out of R2's wording): a render-path `getPage` failure after a successful measurement remains fatal; near-unreachable since pdf.js caches page promises.

stage: wave-join - ran (cherry-pick of the worker commit and the review-fix commit onto the target; SPA snapshot refreshed by the conductor)
stage: impl-review - ran [round 1 NEEDS_WORK -> fixes -> round 2 SHIP] (model: claude-opus-5 via harness subagent, host backend; fixes: cursor-grok-4.6-high via cursor-agent bridge, verification and commit by the conductor after the bridge agent hit a session limit)
stage: plan-sync - skipped(config: planSync.enabled != true)

2026-09-06 reconciliation: restored completion state from this existing summary and merged PR #206. Gordon confirmed all remaining work was completed and requested spec closure. Earlier BLOCKED/UNMET observations above are historical and superseded by that confirmation.
## Evidence
- Commits: 23ebb1f2, 5e69f66f, 3eb34c89, 40d2c96400f5e6846666e19dcfdfb6b7d5699547, d17ac7d8577c87fbd14a072deef3f39db121edae
- Tests: bun test test/serve/public/hooks test/serve/public/lib test/serve/public/components/pdf -> 135 pass, 0 fail (integrated target), bun run lint:check -> clean, bun test test/serve/spa-snapshot-freshness.test.ts -> 2 pass, bun run test:e2e:pdf -> PASSED on the review-fix tree (incl. CLEAN: anchored-correction CSS contract), worker: bun test (full) -> 4486 pass, 1 fail (snapshot freshness, fixed by the conductor rebuild); e2e PASSED twice
- PRs: https://github.com/gmickel/gno/pull/206