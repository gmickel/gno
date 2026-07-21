# fn-91-bun-serve-shutdown-crash-triage.1 Reproduce classify and eliminate serve shutdown crash

## Description

Build a subprocess lifecycle harness, compare installed Bun 1.3.6 with current stable, minimize causal runtime features, and apply only the verified runtime requirement or GNO cleanup fix.

## Acceptance

- [ ] Harness covers SIGINT and SIGTERM with bounded timeouts.
- [ ] Installed and current stable Bun outcomes are recorded.
- [ ] Supported execution has no panic, orphan, or occupied port.
- [ ] Docs state the verified runtime requirement/workaround.

## Done summary

Removed competing bootstrap/server SIGINT exits, serialized server/runtime/SQLite teardown, and added subprocess lifecycle smoke coverage.

## Evidence

- Commits: 256cba8
- Tests: shutdown lifecycle regression, Bun 1.3.6 production/development SIGINT/SIGTERM, Bun 1.3.14 production/development SIGINT, production Ctrl-C exit 0
- PRs:
