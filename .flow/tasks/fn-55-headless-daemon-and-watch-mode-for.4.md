# fn-55-headless-daemon-and-watch-mode-for.4 Add daemon tests and docs updates

## Description
Add the test coverage and user-facing documentation for daemon mode.

This task closes the loop: tests, CLI spec, docs, troubleshooting, and website-synced docs all need to move together so the new command is actually supportable.

Required docs scope:
- `README.md`
- `docs/CLI.md`
- `spec/cli.md`
- `docs/QUICKSTART.md`
- `docs/TROUBLESHOOTING.md`
- `docs/WEB-UI.md`
- optional `docs/DAEMON.md` if service-manager examples need a dedicated page
- website doc sync/build verification
## Acceptance
- [ ] Lifecycle/watch/integration tests exist for daemon mode.
- [ ] CLI contract is reflected in `spec/cli.md`.
- [ ] User-facing docs are updated across README/CLI/Quickstart/Troubleshooting/Web UI.
- [ ] Website-synced docs are verified.
- [ ] Fresh users can understand one-shot vs continuous indexing paths from docs alone.
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
