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

TBD

## Evidence

- Commits:
- Tests:
- PRs:
