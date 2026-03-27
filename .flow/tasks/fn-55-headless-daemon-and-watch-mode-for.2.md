# fn-55-headless-daemon-and-watch-mode-for.2 Extract reusable headless background runtime

## Description

Extract a reusable background runtime from the current `gno serve` startup path.

The goal is that the watcher/scheduler/database/context lifecycle exists independently of the web server. The result should be a reusable runtime/service object that both `gno serve` and `gno daemon` can consume.

Focus on:

- DB/store/context lifecycle extraction
- making browser event-bus requirements optional or no-op compatible
- preserving current `gno serve` behavior with no regressions
- clear `start()` / `dispose()` semantics

## Acceptance

- [ ] Shared background runtime exists outside the web-server entrypoint.
- [ ] `gno serve` uses the extracted runtime with no behavior regression.
- [ ] Headless use no longer requires a browser event bus.
- [ ] Runtime has explicit lifecycle methods.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
