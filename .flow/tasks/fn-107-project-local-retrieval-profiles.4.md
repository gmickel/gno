---
satisfies: [R1, R3, R5, R6]
---
# fn-107-project-local-retrieval-profiles.4 Integrate profiles with setup affinity docs and portability proof

## Description
Deliver integrate profiles with setup affinity docs and portability proof as one implementation-sized increment.

**Size:** M
**Files:** `src/cli/commands/profile.ts`, `src/cli/commands/setup-activation.ts`, `src/cli/program.ts`, `src/core/folder-setup.ts`, `src/core/project-affinity.ts`, `src/core/project-affinity-surface.ts`, `docs/guides/project-profiles.md`, `docs/QUICKSTART.md`, `assets/skill/SKILL.md`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

### Approach
- Let `gno setup` surface the existing `runProjectProfileCommand()` discovery/check result before its own safe apply; no profile remains a first-class path.
<!-- Updated by plan-sync: fn-107-project-local-retrieval-profiles.2 used runProjectProfileCommand() not a planned setup-local profile inspection -->
- Feed compiled affinity defaults through fn-104's `src/core/project-affinity-surface.ts` trust boundary with one precedence: explicit CLI roots or remote `projectHints`, nearest chosen profile, user config default.
<!-- Updated by plan-sync (cross-spec): fn-104-project-aware-retrieval-affinity.3 introduced src/core/project-affinity-surface.ts for caller-supplied roots/hints -->
- Run second-clean-machine portability, worktree/monorepo, no-runtime-state, docs/skill/hosted, and package gates.

### Investigation targets
**Required** (read before coding):
- `docs/QUICKSTART.md`
- `assets/skill/SKILL.md`

**Optional** (reference as needed):
- `docs/CONFIGURATION.md`
- `docs/INSTALLATION.md`
- `/Users/gordon/work/gno.sh/src/routes/install.tsx`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/core/folder-setup.ts`
- `src/core/project-affinity.ts`
- `src/core/project-affinity-surface.ts`

### Key context
- Profile values do not override explicit caller inputs; source metadata/content types never become project identity.

## Acceptance
- [ ] Setup can preview/apply a valid profile but remains usable with none or invalid profiles.
- [ ] Affinity precedence is deterministic and explainable across caller/profile/user defaults.
- [ ] A clean-machine portability fixture reproduces config semantics with no committed DB/model/cache/lock/secret state.
- [ ] Docs/skill/gno.sh and full verification gates are current.


## Done summary
Implemented setup, affinity, documentation, and portability integration for
project-local retrieval profiles.

- `gno setup` now inspects the nearest profile before mutation and supports
  explicit `--apply-profile` composition through the existing lock-safe apply
  path.
- Added the closed `setup-profile-result@1.0` contract while preserving existing
  setup JSON bytes when profile application is not requested.
- Enforced affinity precedence: explicit CLI roots, nearest valid profile, then
  user-config cwd defaults; profile defaults stay request-local.
- Added clean-machine, POSIX/Windows path-shape, monorepo/worktree, no-runtime-
  state, packed-package, schema, CLI, docs, and skill coverage.
- Updated the authoritative project-affinity benchmark provenance.

Hosted gno.sh documentation was completed separately by the parent workflow.
Skill autoresearch could not run because `uv` and an Anthropic API key were
absent, while its Claude CLI fallback was explicitly prohibited.
## Evidence
- Commits: ec8d2172c85b42c7e579bfefda6e184b2f528c12
- Tests: bun test (3109 pass, 2 expected skips, 0 fail), bun test test/project-affinity/parity.test.ts test/eval/agentic/baseline.test.ts test/cli/setup-profile-integration.test.ts test/cli/setup.test.ts (26 pass, 0 fail), bun run lint:check, bun run docs:verify (13 pass, 2 expected model-cache skips), bun run test:package, .flow/bin/flowctl validate --spec fn-107-project-local-retrieval-profiles --json
- PRs: