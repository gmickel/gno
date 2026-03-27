# fn-42-desktop-beta-onboarding-and-health.1 Implement first-run onboarding and health center

## Description

Implement the first-run onboarding path in the existing web app.

Work includes:

- extend the status/health API with onboarding and actionable health data
- add dashboard/onboarding UI for zero-collection and broken-state flows
- add plain-language preset chooser and model readiness guidance
- add health center coverage for indexing, model readiness, disk, and next actions
- update docs + website copy to match the shipped first-run flow
- add tests for API contract and onboarding/health rendering

## Acceptance

- [ ] New users can open the app and see a guided path to add a folder, choose a preset, and start indexing
- [ ] Health surfaces show actual system state with actionable fix guidance for indexing, models, and disk
- [ ] `/api/status` contract, tests, and docs reflect the new onboarding/health data
- [ ] Quickstart/install/web docs and website copy match the shipped onboarding flow

## Done summary

Shipped first-run onboarding and health-center support for the web app.

Highlights:

- extended `/api/status` with active preset, capabilities, onboarding stages, suggested folders, and actionable health checks
- added dashboard first-run wizard, health center, and suggested-folder launch path into add-collection flow
- improved collections empty state and preset chooser plain-language copy
- updated status schema fixtures/tests plus web/API/docs/website copy
- verified targeted tests, full `bun test`, `bun run lint:check`, `bun run docs:verify`, and browser sanity on the local dashboard

## Evidence

- Commits:
- Tests: bun test test/serve/api-status.test.ts test/spec/schemas/status.test.ts test/serve/public/components/FirstRunWizard.test.tsx test/serve/public/components/HealthCenter.test.tsx test/serve/public/navigation.test.tsx, bunx oxlint src/serve/status-model.ts src/serve/status.ts src/serve/routes/api.ts src/serve/server.ts src/serve/public/components/HealthCenter.tsx src/serve/public/components/FirstRunWizard.tsx src/serve/public/components/CollectionsEmptyState.tsx src/serve/public/components/AddCollectionDialog.tsx src/serve/public/components/AIModelSelector.tsx src/serve/public/pages/Dashboard.tsx src/serve/public/pages/Collections.tsx test/serve/api-status.test.ts test/serve/public/components/FirstRunWizard.test.tsx test/serve/public/components/HealthCenter.test.tsx test/spec/schemas/status.test.ts, bun run lint:check, bun test, bun run docs:verify, browser sanity: agent-browser open http://localhost:3123; snapshot + quick-pick add-folder dialog prefill verified
- PRs:
