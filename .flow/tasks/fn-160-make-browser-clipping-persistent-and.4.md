---
satisfies: [R6]
---
# fn-160-make-browser-clipping-persistent-and.4 Qualify packaged panel workflow and publish usage guidance

## Description
**Size:** M
**Touches:** [test/clipper/e2e.test.ts, test/clipper/e2e-harness.ts, test/clipper/e2e-assertions.ts, browser-extension/test/package.test.ts, docs/integrations/browser-clipper.md, CHANGELOG.md, ../gno.sh/src/lib/gno-docs.tsx]
**Approach:** Extend real Chromium scenarios and disposable fixtures; verify package contents and permissions. Reconcile repository and hosted instructions for setup, collection choice, persistence and supported browser floor. Preserve real user files. Run focused checks then required full gates; hosted changes need site gates and live QA.

## Acceptance
- [ ] Captured browser evidence covers R1-R5 end to end with exact saved selection and one write.
- [ ] Package reproducibility, required gates and docs checks pass.
- [ ] Existing real clips untouched; extraction completeness and ingestion are not claimed.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
