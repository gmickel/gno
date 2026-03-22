# fn-48-desktop-beta-background-service-and.1 Harden watcher lifecycle and background service status

## Description

Harden the background service lifecycle behind the web workspace.

Initial slice:

- make collection watchers reconfigure when config changes add/remove folders
- expose watcher/embed/SSE-facing service state through `/api/status`
- add reconnect/backoff behavior to the client doc-event hook for long-running sessions
- add resilience tests for watcher reconfigure, service state, and event-stream recovery paths where practical
- update web docs to explain backlog/reliability visibility

## Acceptance

- [ ] Adding or removing a collection updates watcher coverage without restarting the server
- [ ] `/api/status` includes accurate background-service/watch/indexing state for the UI
- [ ] Doc-event subscribers recover from dropped event streams instead of silently stalling
- [ ] Tests cover the new reliability behaviors and docs explain the visible status model

## Done summary
Shipped the first reliability slice for background service hardening.

Highlights:
- collection watchers now reconfigure when config changes add/remove folders, instead of requiring a server restart
- document event bus now publishes SSE retry hints and keepalive frames, plus connection-count state
- embed scheduler exposes richer runtime state, and `/api/status` now includes a `background` reliability block for watcher, embedding, and event-stream telemetry
- doc-event client hook now reconnects with capped backoff after stream errors
- added tests for watcher reconfigure/failure state, retry delay policy, and updated status contract/docs
## Evidence
- Commits:
- Tests: bun test test/serve/watch-service.test.ts test/serve/api-status.test.ts test/spec/schemas/status.test.ts test/serve/embed-scheduler.test.ts test/serve/public/hooks/use-doc-events.test.ts, bun run lint:check, bun run typecheck, bun test, bun run docs:verify
- PRs: