# fn-64-retrieval-quality-and-terminal.5 Add per-collection model configuration with clear resolution rules

## Description

Add collection-scoped retrieval model overrides without replacing GNO's existing global preset system.

The goal is not to create a second competing model configuration system. The goal is to let one collection opt into different retrieval model roles while preserving the current preset-based workflow for the rest of the workspace.

Start here:

- `src/config/types.ts`
- `src/config/loader.ts`
- `src/llm/registry.ts`
- `src/llm/nodeLlamaCpp/adapter.ts`
- `docs/CONFIGURATION.md`
- `docs/CLI.md`
- `README.md`

Scope:

- add collection-scoped model overrides for retrieval-relevant roles
- decide and document which roles are supported in first pass:
  - `embed`
  - `rerank`
  - `expand`
  - optionally `gen` if the collection override model should also affect standalone answer generation for collection-targeted flows
- allow partial overrides by role; do not require redefining a whole preset per collection
- define one explicit resolution order for effective model selection
- ensure the rest of the workspace can continue using the active global preset unchanged

Recommended resolution order to evaluate in this task:

- collection role override
- active preset role
- built-in default fallback

Requirements:

- extend the existing central `index.yml`; do not invent per-collection config files
- configuration shape must be explicit and validated in schema
- partial overrides must compose cleanly with the active preset
- if `gen` is included, its behavior must be clearly documented as collection-targeted or not
- behavior must be observable: users/operators need a way to understand which model URI is effective for a given collection/role
- keep startup/runtime model resolution understandable; avoid hidden precedence surprises

Likely change areas:

- collection schema in `src/config/types.ts`
- model resolution helpers in `src/llm/registry.ts`
- model adapter lookup sites in `src/llm/nodeLlamaCpp/adapter.ts`
- any retrieval/indexing call sites that currently assume only one active preset path

Tests:

- schema validation for valid/invalid collection model overrides
- resolution tests for:
  - collection override beats active preset
  - unspecified roles fall back to active preset
  - active preset falls back to built-in defaults as today
- integration coverage showing different collections can resolve different retrieval model URIs without breaking unrelated collections
- no-regression coverage for existing configs with no collection override blocks

ADR/docs/website:

Own these updates in this task:

- add `docs/adr/004-collection-model-resolution.md`
- update `docs/CONFIGURATION.md`
- update `docs/CLI.md` if operator-facing commands/status output change
- update `docs/TROUBLESHOOTING.md` with precedence/debug guidance
- update `README.md` if this becomes a headline configuration capability
- update `website/features/hybrid-search.md` if collection-specific retrieval configuration is surfaced there
- update `website/_data/features.yml`
- run `bun run website:sync-docs`

Non-goals:

- benchmark CLI work
- replacing presets as the primary model-management concept
- per-folder config files inside collection roots
- collection-scoped parser/chunking strategy in this task

## Acceptance

- [ ] Collections can override retrieval model roles without replacing the global preset system.
- [ ] Resolution order is explicit, tested, and documented.
- [ ] Partial role overrides are supported without whole-preset duplication.
- [ ] Existing configs without collection model overrides continue to behave unchanged.
- [ ] ADR-004 and configuration docs explain the final precedence model and debug story.

## Done summary

Implemented collection-scoped model overrides layered on top of the existing preset system.

Delivered:

- added optional `models` overrides on collections in config schema
- added collection-aware model resolution with explicit precedence:
  1. collection role override
  2. active preset role
  3. built-in default fallback
- threaded collection-aware model resolution through CLI, SDK, and MCP collection-targeted retrieval/embed paths
- added ADR-004 plus configuration/troubleshooting/website copy for the new resolution model
- added registry/config coverage for collection override resolution and persistence

## Evidence

- Commits:
- Tests: bun test test/llm/registry.test.ts test/config/loader.test.ts test/config/saver.test.ts, bun run lint:check, bun run docs:verify, make -C website sync-docs
- PRs:
