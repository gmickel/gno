# fn-72-backgrounding-flags-for-serve-and-daemon.10 Synchronize SIGKILL fallback integration fixture

## Description
The Unix SIGKILL fallback integration fixture can signal its child before the child installs its SIGTERM handler, causing a deterministic false SIGTERM result under current Bun. Add an explicit readiness handshake before invoking the stop command.
## Acceptance
- [ ] Child announces readiness only after its SIGTERM handler is installed.
- [ ] SIGKILL fallback integration test passes repeatedly.
- [ ] No production shutdown behavior changes.
## Done summary
Added a bounded Bun IPC readiness handshake so the integration fixture installs its SIGTERM handler before --stop exercises the real SIGKILL fallback.
## Evidence
- Commits:
- Tests: bun test test/cli/detach.integration.test.ts -t case 5 (two consecutive passes), bun test test/serve/api-docs-lifecycle.test.ts test/core/file-ops.test.ts test/cli/detach.test.ts test/cli/detach.integration.test.ts (89 pass, 1 skip), bun run lint:check
- PRs: