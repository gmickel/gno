# fn-43-desktop-beta-in-app-agent-connector.1 Add in-app connector status and installer actions

## Description

Build the first in-app agent connector slice on top of the existing CLI installers.

Initial slice:

- inventory current skill/MCP install + status plumbing for core agent targets
- define an app-facing status model for detect/install/verify/troubleshoot
- wire the first in-app connector UI around the existing installer commands instead of duplicating protocol logic
- explain read-only vs write-capable modes in plain language
- update integration docs/README guidance to match the app flow

## Acceptance

- [ ] App can show detect/install/verify state for at least the core supported agent targets
- [ ] In-app actions reuse existing CLI installer logic instead of a second installer implementation
- [ ] Success/failure states explain next actions in plain language

## Done summary
Shipped the first in-app connector center slice.

Highlights:
- added shared connector detect/install helpers that reuse the existing skill and MCP installer logic
- exposed `/api/connectors` and `/api/connectors/install`
- added a new `/connectors` page plus dashboard navigation entry
- surfaced plain-language mode/status/next-action copy for core supported agent targets
- updated docs and added connector service/page regression coverage
- verified the Connectors page renders in-browser on the local app
## Evidence
- Commits:
- Tests: bun test test/serve/connectors.test.ts test/serve/public/connectors-page.test.tsx test/serve/public/navigation.test.tsx, bun run lint:check, bun run typecheck, bun test, bun run docs:verify, browser sanity: agent-browser open http://localhost:3126/connectors; snapshot verified connector page
- PRs: