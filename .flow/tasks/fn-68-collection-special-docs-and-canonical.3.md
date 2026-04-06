# fn-68-collection-special-docs-and-canonical.3 Add agent/API/CLI access patterns for special docs

## Description

Add read-oriented access patterns for collection special docs outside the Web UI.

Requirements:

- API returns special-doc metadata
- MCP / skill / CLI can discover the configured home/log docs for a collection
- first pass should focus on discovery, not mutation

Possible surfaces:

- API collection metadata
- MCP collection metadata or dedicated "collection info" style tool
- CLI read-only command or extension to `collection list`
- skill guidance so agents know to check these canonical docs first

This is the agent/tooling complement to task `.2`.

## Acceptance

- [ ] Non-UI surfaces can discover configured special docs for a collection.
- [ ] The first pass is discovery-oriented, not an overbuilt command set.
- [ ] Skill/docs explain how agents should use the metadata.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
