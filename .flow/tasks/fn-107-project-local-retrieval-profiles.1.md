---
satisfies: [R1, R2, R3, R6]
---
# fn-107-project-local-retrieval-profiles.1 Define the versioned project profile schema and compiler

## Description
Deliver define the versioned project profile schema and compiler as one implementation-sized increment.

**Size:** M
**Files:** `src/config/project-profile.ts`, `spec/project-profile.schema.json`, `src/core/project-profile.ts`, `test/config/project-profile.test.ts`

### Approach
- Define declarative `.gno/index.yml` for collection rules, contexts, content types, language/model aliases, affinity defaults, and excludes—never secrets/hooks/runtime paths.
- Compile relative profile paths against a trusted profile root into a machine-neutral desired-state model and deterministic fingerprint/receipt.
- Specify schema evolution: reject unknown major versions, preserve supported minor fields, and provide explicit migration diagnostics.

### Investigation targets
**Required** (read before coding):
- `src/config/types.ts:71-307`
- `src/config/loader.ts`
- `src/config/content-types.ts`
- `src/core/validation.ts`

**Optional** (reference as needed):
- `src/config/defaults.ts`
- `src/llm/registry.ts`

## Acceptance
- [ ] Two clean machine-root fixtures compile the same logical desired state/fingerprint without machine-specific paths.
- [ ] Schema rejects secrets, absolute/traversal/symlink-escape paths, hooks, runtime files, and unknown major versions.
- [ ] Model aliases and offline-unavailable references produce deterministic non-secret diagnostics.


## Done summary
Defined the strict version 1.0 project retrieval profile schema and a symlink-safe compiler that separates portable desired state from resolved machine paths. Added deterministic domain-separated fingerprints, exact-byte context inputs, offline-only model diagnostics, forced `.gno` exclusion, and cross-platform security regression coverage.
## Evidence
- Commits: 1c2eb13
- Tests: baseline: red (bun test test/config/project-profile* test/cli/profile* failed pre-edit: task-owned test files did not exist and zsh reported no matches), bun test test/config/project-profile* test/cli/profile*, bun run docs:verify, bun run lint:check, .flow/bin/flowctl validate --spec fn-107-project-local-retrieval-profiles --json
- PRs: