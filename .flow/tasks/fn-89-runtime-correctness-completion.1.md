# fn-89-runtime-correctness-completion.1 Fix indexed URI reads in MCP and SDK

## Description

Implement shared effective-index resolution and scoped read-only store ownership for MCP tools/resources and SDK get/multiGet. Reject missing or ambiguous indexes and prove correctness with same-URI/different-content fixtures.

## Acceptance

- [ ] MCP get and resources return content from the explicit URI index.
- [ ] SDK get and multiGet return content from the explicit URI index.
- [ ] Mixed-index multi-get is rejected consistently.
- [ ] Missing index never creates a database or falls back.
- [ ] Scoped stores close on success and failure.

## Done summary
Indexed SDK/MCP tool/resource reads now open the database named by ?index=, reject ambiguous batches, and never create missing indexes.
## Evidence
- Commits: 51e4550
- Tests: test/indexed-uri-roundtrip.test.ts (4 pass), full bun test: 2034 pass
- PRs: