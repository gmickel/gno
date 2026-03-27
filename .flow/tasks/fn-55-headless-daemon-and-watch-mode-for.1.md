# fn-55-headless-daemon-and-watch-mode-for.1 Design dedicated CLI daemon/watch mode

## Description

Design the dedicated headless CLI mode for continuous indexing.

Current workaround is `gno serve`, which already runs the watcher + embed scheduler, but that is the wrong UX for users who just want a daemon process. This task should define the CLI contract and the runtime boundary before implementation starts.

Focus on:

- command shape (`gno daemon` / `gno watch` / `gno update --watch`)
- reuse of current watch/sync/embed code
- foreground/background behavior
- signal handling and logs
- service-manager friendliness

## Acceptance

- [ ] Proposed CLI contract is written down.
- [ ] Reuse plan for current watcher/scheduler is explicit.
- [ ] Long-running process lifecycle requirements are listed.
- [ ] Service/deployment expectations are documented enough to implement safely.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
