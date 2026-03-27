# fn-55-headless-daemon-and-watch-mode-for.1 Design dedicated CLI daemon/watch mode

## Description

Define the exact CLI and runtime contract for headless continuous indexing.

This task sets the product/engineering boundary before implementation begins. It should resolve the command shape, startup behavior, shutdown behavior, config semantics, and how the daemon relates to the existing `gno serve` path.

Required outputs:

- final decision on `gno daemon` as the v1 command name
- final decision that v1 is foreground-only (no built-in start/stop/status)
- startup sequence (`watch` + initial sync + embed scheduling)
- config reload policy (restart required in v1)
- logging and exit-code contract
- explicit note that watch-mode scope is being absorbed here from the older `fn-8` placeholder

## Acceptance

- [ ] CLI command shape is final.
- [ ] Startup/shutdown behavior is explicitly documented.
- [ ] Config reload policy is explicit.
- [ ] Logging contract is explicit.
- [ ] Scope boundary vs `gno serve` and `fn-8` is explicit.

## Done summary

Finalized the fn-55 daemon product/engineering contract.

Locked the v1 shape to `gno daemon` as a foreground-only headless watcher process with `--no-sync-on-start`, no built-in process manager, no service installers, and explicit separation from `gno serve`.

## Evidence

- Commits: f0053ee
- Tests: bun run lint:check, bun run typecheck, bun test, bun run docs:verify, mise exec ruby@3.3.6 -- make build
- PRs:
