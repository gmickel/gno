# fn-55-headless-daemon-and-watch-mode-for Headless daemon and watch mode for continuous indexing

## Overview

GNO already has live folder watching and automatic post-sync embedding, but only inside `gno serve`. There is no dedicated headless CLI daemon today: no `gno daemon`, no `gno watch`, and no `gno update --watch` mode.

This epic promotes the existing watcher/scheduler pieces into a first-class headless process for users who want continuous indexing without keeping the Web UI open.

## Scope

- define the CLI surface (`gno daemon` vs `gno watch` vs `gno update --watch`)
- reuse the existing watch/sync/embed pipeline instead of inventing a second background path
- support foreground and service-friendly headless execution
- expose logs/status/restart-safe behavior for long-running use
- document launchd/systemd/Windows-service style deployment patterns later if needed

## Approach

1. Reuse current watcher and scheduler behavior from:
   - `/Users/gordon/work/gno/src/serve/watch-service.ts`
   - `/Users/gordon/work/gno/src/serve/embed-scheduler.ts`
2. Extract a headless runtime boundary that does not require the web server.
3. Define process behavior:
   - startup validation
   - signal handling
   - logging
   - debounce/backoff behavior on rapid file changes
4. Decide whether service-install wrappers belong in this repo or only docs/examples.

## Quick commands

- `gno serve`
- `gno update --yes`
- `gno embed --yes`
- `bun test test/serve/public/hooks/use-doc-events.test.ts`

## Acceptance

- [ ] A dedicated headless continuous-indexing mode exists in CLI form.
- [ ] It reuses the existing watcher/sync/embed behavior instead of duplicating logic.
- [ ] Users can run it without opening the Web UI.
- [ ] Shutdown/restart/logging behavior is documented and supportable.
- [ ] Docs explain when to use one-shot `update`/`embed` vs the daemon mode.

## References

- `/Users/gordon/work/gno/src/serve/watch-service.ts`
- `/Users/gordon/work/gno/src/serve/server.ts`
- `/Users/gordon/work/gno/src/cli/commands/serve.ts`
- `/Users/gordon/work/gno/docs/WEB-UI.md`
