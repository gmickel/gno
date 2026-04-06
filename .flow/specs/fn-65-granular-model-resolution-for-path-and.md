# fn-65-granular-model-resolution-for-path-and Granular model resolution for path and file-type scopes

## Overview

Future follow-on to collection-level model overrides.

Current GNO supports one embed/rerank/expand/gen override block per collection.
That is enough for:

- prose collections
- code-only collections
- docs-only collections

It is not enough for mixed trees where one collection contains:

- code
- markdown docs
- generated references
- maybe language-specific files

This epic exists to design a cleaner next layer of model resolution:

- per-path overrides
- per-file-type overrides

without creating an unreadable config or surprising precedence model.

## Scope

Included:

- design resolution semantics for:
  - collection
  - path prefix
  - file type / extension
- define precedence rules
- define observability/debug surfaces for effective model resolution
- define migration path from current collection-only overrides

Excluded:

- implementation in this epic
- model benchmarking itself
- chunking strategy overrides unless they prove inseparable

## Approach

Questions this epic must answer:

- Should path overrides use `gno://collection/path`-style prefixes?
- Should file-type overrides be extension-based, MIME-based, or both?
- What is the precedence between:
  - explicit runtime override
  - path override
  - file-type override
  - collection override
  - active preset
  - built-in default
- How do we avoid a second config system or rule explosion?
- How do users inspect the effective model chosen for one document/query?

Likely outcome:

- path/file-type overrides should layer on top of the existing preset and collection model system
- the final design should prefer explicit, deterministic precedence over clever heuristics

## Quick commands

- `bun test`
- `bun run lint:check`

## Acceptance

- [ ] A concrete config shape is proposed for path and file-type model overrides.
- [ ] Precedence rules are explicit and deterministic.
- [ ] The design explains how users inspect effective model resolution.
- [ ] The proposal does not require per-folder config files.
- [ ] The proposal includes migration guidance from collection-only overrides.

## References

- `src/config/types.ts`
- `src/llm/registry.ts`
- `docs/CONFIGURATION.md`
- `docs/adr/004-collection-model-resolution.md`
