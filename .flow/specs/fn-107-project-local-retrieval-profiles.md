# fn-107 Project-Local Retrieval Profiles

## Goal & Context
<!-- scope: business -->

Let a repository declare its intended GNO retrieval setup in source control without committing the database, models, secrets, or machine-specific paths. A `.gno/index.yml` profile should make project retrieval reproducible for humans and agents across machines.

## Architecture & Data Models
<!-- scope: technical -->

Define a versioned, declarative `.gno/index.yml` schema for logical collection name, repository-relative include/exclude rules, content types, language hint, model preset references, context files/text, project affinity defaults, and recommended connector capabilities. Runtime state resolves into the normal user config/index outside the repository.

Discovery walks from cwd to repository root and stops at filesystem/repo boundaries. A shared profile compiler validates, normalizes, diffs, and applies the declaration idempotently. It records the profile path/hash in local config but never writes machine paths back into the tracked file.

## API Contracts
<!-- scope: technical -->

- CLI: `gno profile check|show|diff|apply [path] --json`; `gno setup` detects and offers the profile.
- Schema is documented and machine-readable; unknown future fields warn or fail according to version rules.
- Profiles may reference environment variables only in explicitly allowed local-only fields; secrets are forbidden.
- Apply receipts show created/updated/unchanged local resources and pending indexing.

## Edge Cases & Constraints
<!-- scope: technical -->

- Prevent path traversal, absolute paths by default, symlink escape, nested-profile ambiguity, and recursive inclusion of `.gno` state.
- Handle monorepos and worktrees with explicit profile-root semantics.
- Profile changes require a diff before destructive local changes; removing a collection is never implicit.
- Model aliases/presets must resolve locally with offline-aware errors.
- Keep DB/cache/model paths outside the repository and gitignored hints explicit.
- Concurrent apply is lock-safe and idempotent.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** A committed `.gno/index.yml` can reproduce collection rules, contexts, content types, language/model references, and affinity defaults on a second clean machine without committing runtime state.
- **R2:** Check/show/diff/apply use one versioned schema/compiler and produce deterministic receipts.
- **R3:** Traversal, absolute-path, symlink-escape, nested-profile, secret-field, monorepo, and worktree fixtures are safe and documented.
- **R4:** Applying changes never implicitly deletes a collection/index or writes machine-specific values into the profile.
- **R5:** `gno setup`, agent skill docs, and project-affinity behavior integrate with profile discovery without making it mandatory.
- **R6:** Runtime DB, model, cache, and lock files remain outside the repository under all supported platforms.

## Boundaries
<!-- scope: business -->

No committed index/database, secret management system, cloud project synchronization, arbitrary shell hooks, remote model credentials, or replacement of user-level config.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

Teams already source-control project conventions. A safe retrieval profile makes GNO activation repeatable without sharing private indexed content.

### Implementation Tradeoffs
<!-- scope: technical -->

A declarative compiler is less flexible than arbitrary setup scripts but is reviewable, portable, and safe for agents to inspect before applying.

## Implementation Plan

1. `fn-107-project-local-retrieval-profiles.1` — Define the versioned project profile schema and compiler (**M**)
2. `fn-107-project-local-retrieval-profiles.2` — Implement safe discovery check show and diff (**M**); depends on `fn-107-project-local-retrieval-profiles.1`
3. `fn-107-project-local-retrieval-profiles.3` — Apply project profiles idempotently without implicit deletion (**M**); depends on `fn-107-project-local-retrieval-profiles.2`
4. `fn-107-project-local-retrieval-profiles.4` — Integrate profiles with setup affinity docs and portability proof (**M**); depends on `fn-107-project-local-retrieval-profiles.3`

## Quick commands

```bash
bun test test/config/project-profile* test/cli/profile*
bun run docs:verify
.flow/bin/flowctl validate --spec fn-107-project-local-retrieval-profiles --json
```

## References

- `src/config/types.ts:71-307` — global config schema.
- `src/config/loader.ts` and `src/config/saver.ts` — current config IO.
- `src/core/validation.ts` — path safety.
- `src/core/config-mutation.ts` — guarded apply.

## Early proof point

Task `fn-107-project-local-retrieval-profiles.1` validates the core approach (one declarative profile compiles identically on two clean machine-root fixtures while runtime state remains external).
If it fails, re-evaluate the portable path/schema model and discovery precedence before continuing with `fn-107-project-local-retrieval-profiles.2`+.

## Requirement coverage

| Req | Description | Task(s) | Gap justification |
|-----|-------------|---------|-------------------|
| R1 | A committed `.gno/index.yml` can reproduce collection rules, contexts, content types, language/model references, and affinity defaults on a second clean machine without committing runtime state. | fn-107-project-local-retrieval-profiles.1, fn-107-project-local-retrieval-profiles.4 | — |
| R2 | Check/show/diff/apply use one versioned schema/compiler and produce deterministic receipts. | fn-107-project-local-retrieval-profiles.1, fn-107-project-local-retrieval-profiles.2, fn-107-project-local-retrieval-profiles.3 | — |
| R3 | Traversal, absolute-path, symlink-escape, nested-profile, secret-field, monorepo, and worktree fixtures are safe and documented. | fn-107-project-local-retrieval-profiles.1, fn-107-project-local-retrieval-profiles.2, fn-107-project-local-retrieval-profiles.4 | — |
| R4 | Applying changes never implicitly deletes a collection/index or writes machine-specific values into the profile. | fn-107-project-local-retrieval-profiles.3 | — |
| R5 | `gno setup`, agent skill docs, and project-affinity behavior integrate with profile discovery without making it mandatory. | fn-107-project-local-retrieval-profiles.2, fn-107-project-local-retrieval-profiles.4 | — |
| R6 | Runtime DB, model, cache, and lock files remain outside the repository under all supported platforms. | fn-107-project-local-retrieval-profiles.1, fn-107-project-local-retrieval-profiles.2, fn-107-project-local-retrieval-profiles.3, fn-107-project-local-retrieval-profiles.4 | — |
