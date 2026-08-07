# fn-117-bound-local-generation-contextsize.1 Bound generation contextSize + regression test + changelog

## Description
TBD

## Acceptance
- [ ] TBD

## Done summary
Implemented bounded context sizing for local GGUF generation (issue #189).

- Added `resolveGenContextSize` in `src/llm/nodeLlamaCpp/generation.ts`:
  prompt tokens + maxTokens + 512 margin, floor 1024, capped at the model's
  trained context size. `generate()` now always passes an explicit
  `contextSize` to `createContext` (explicit params keep prior behavior).
- Regression test `test/llm/node-generation-context-size.test.ts` (5 cases:
  margin math, floor, cap, unknown and non-positive trained size).
- CHANGELOG [Unreleased] Fixed entry crediting @fightp86.

Full suite green: 4034 pass / 0 fail; lint:check clean (type-aware).
## Evidence
- Commits: b578db56
- Tests: bun test, bun run lint:check
- PRs: