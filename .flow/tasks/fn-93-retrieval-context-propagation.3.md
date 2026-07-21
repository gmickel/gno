---
satisfies: [R3, R5, R6]
---
# fn-93-retrieval-context-propagation.3 Complete cross-surface contracts and context guidance

## Description
Deliver complete cross-surface contracts and context guidance as one implementation-sized increment.

**Size:** M
**Files:** `src/pipeline/answer.ts`, `src/serve/routes/api.ts`, `src/mcp/tools/search.ts`, `src/sdk/client.ts`, `spec/output-schemas`, `docs`

### Approach
- Thread the resolved guidance through Ask prompt construction with explicit separation from untrusted retrieved content.
- Add CLI, REST, MCP, SDK, indexed-URI, and Ask parity fixtures against the existing optional context schema fields.
- Update authoritative specs/docs/skill assets and the hosted gno.sh retrieval guidance in the same completion task.

### Investigation targets
**Required** (read before coding):
- `src/pipeline/answer.ts:435-515`
- `src/serve/routes/api.ts:3257-3820`
- `src/mcp/tools/search.ts`
- `src/sdk/client.ts`
- `test/spec/schemas`

**Optional** (reference as needed):
- `docs/CONFIGURATION.md:195-210`
### Key context
- This is a semantics/contract correction: optional context fields already exist, so avoid an unnecessary schema-version break.
- Run the GNO skill autoresearch evaluation because MCP/CLI retrieval behavior changes.

## Acceptance
- [ ] CLI/REST/MCP/SDK/Ask fixtures expose the same context and exact source identity.
- [ ] Prompt fixtures prove user configuration and retrieved content occupy distinct delimited roles.
- [ ] Specs, schemas, docs, skill assets, gno.sh content, and the autoresearch skill result match shipped behavior.
- [ ] Full lint, tests, docs verification, and package smoke pass.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
