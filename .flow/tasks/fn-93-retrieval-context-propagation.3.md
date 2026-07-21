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
Exposed configured retrieval context consistently through CLI, REST, MCP, SDK, indexed-URI, and Ask contracts. Review hardening now builds prompts without reparsing inserted values, XML-escapes structured fields, keeps guidance outside citation numbering, and treats accepted collection-root prefixes as collection-wide. Updated schemas, specs, docs, agent guidance, and hosted gno.sh reference.
## Evidence
- Commits: a6e094ea215549c93cda7ac94d5a50262f07656e, ed34e99
- Tests: 71 focused review-regression tests passed, bun run prerelease: 2051 passed, 1 skipped, 0 failed, docs verification: 12 passed, 2 model-dependent skips, package smoke passed, shipped-skill autoresearch: 48/48, gno.sh bun run check and bun run typecheck
- PRs: https://github.com/gmickel/gno/pull/132, https://github.com/gmickel/gno.sh/pull/5