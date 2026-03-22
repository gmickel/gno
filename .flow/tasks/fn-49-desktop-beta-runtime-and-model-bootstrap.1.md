# fn-49-desktop-beta-runtime-and-model-bootstrap.1 Expose runtime and model bootstrap status

## Description

Define and implement the first runtime/model bootstrap slice for normie installs.

Initial slice:

- map current runtime + model bootstrap behavior across CLI/web paths
- make bundled vs on-demand model/runtime status visible in user-facing app/API surfaces
- improve plain-language download/disk/cache copy and status affordances
- add validation around bootstrap success/failure and first-run explainability
- update install/config/model docs to match shipped bootstrap behavior

## Acceptance

- [ ] Users can see what runtime/models are ready, missing, downloading, or cached without reading source or guessing
- [ ] Bootstrap/download/disk status is exposed through the app/API in plain language
- [ ] Tests cover the new bootstrap status paths and docs explain footprint/cache behavior accurately

## Done summary

Shipped the first runtime/model bootstrap status slice for the desktop beta.

Highlights:

- `/api/status` now exposes a `bootstrap` block covering runtime strategy, download policy, cache location/size, and active-preset model readiness
- dashboard now surfaces the new Bootstrap & Storage panel with plain-language runtime/cache/model status
- docs now explain the current Bun-based beta runtime path, auto-download vs manual/offline policy, and cache visibility
- added schema, API, and component coverage for bootstrap status
- verified browser rendering of the new panel on the local dashboard

## Evidence

- Commits:
- Tests: bun test test/serve/api-status.test.ts test/spec/schemas/status.test.ts test/serve/public/components/BootstrapStatus.test.tsx, bun run lint:check, bun run typecheck, bun test, bun run docs:verify, browser sanity: agent-browser open http://localhost:3124; snapshot verified Bootstrap & Storage panel
- PRs:
