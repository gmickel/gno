# fn-55-headless-daemon-and-watch-mode-for.3 Implement gno daemon lifecycle and logging

## Description

Implement the `gno daemon` command on top of the shared background runtime.

This task is the actual long-running process implementation. The daemon should run foreground-only in v1, support `--no-sync-on-start`, log useful lifecycle events, and shut down cleanly on SIGINT/SIGTERM.

Focus on:

- CLI wiring in `src/cli/program.ts`
- new command implementation module under `src/cli/commands/`
- initial sync behavior
- watcher-armed / sync / embed log messages
- graceful shutdown and exit codes
- no HTTP server startup

## Acceptance

- [ ] `gno daemon` runs as a headless long-lived process.
- [ ] `--no-sync-on-start` works.
- [ ] Useful lifecycle logs are emitted.
- [ ] Shutdown is graceful on SIGINT/SIGTERM.
- [ ] The command does not start the web server.

## Done summary

Implemented the `gno daemon` command and long-running lifecycle.

The daemon now starts a headless watcher process, performs an initial sync by default, triggers embedding after sync, logs lifecycle events, supports `--no-sync-on-start`, and shuts down cleanly on SIGINT/SIGTERM without starting the web server.

## Evidence

- Commits: f0053ee
- Tests: bun run lint:check, bun run typecheck, bun test, bun run docs:verify, mise exec ruby@3.3.6 -- make build
- PRs:
