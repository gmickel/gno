# fn-73-gno-runtime-hardening.14 Prevent Bun serve shutdown segfault

## Description

Investigate and prevent the reproducible Bun 1.3.6 segmentation fault after gno serve receives Ctrl+C and runs its shutdown handler. Determine whether open watch/model/event resources or Bun's development HTML server teardown is responsible; keep normal SIGINT/SIGTERM behavior clean.

## Acceptance

- [ ] Reproduce under source and globally installed builds with a minimal shutdown test.
- [ ] gno serve exits 0/expected signal status without a Bun panic after SIGINT and SIGTERM.
- [ ] Watchers, model contexts, event streams, store, and Bun server close in a deterministic order.
- [ ] Add lifecycle regression coverage that detects panic output and orphan processes.

## Done summary

Revalidated and implemented under fn-91.1: the crash was a competing SIGINT teardown race, fixed with serialized lifecycle ownership and subprocess regression coverage.

## Evidence

- Commits: 256cba8
- Tests: Bun 1.3.6 and 1.3.14 lifecycle matrix, production Ctrl-C exit 0
- PRs:
