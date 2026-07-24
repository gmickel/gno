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
Closed the fn-107 final-audit gaps across project-profile persistence, safety,
portability, concurrency, and distribution. Multiple same-scope contexts now
survive migration and sync; profile apply uses additive store projection and
preserves unrelated indexed state. Every config writer shares one canonical
target-derived cross-process lock, including symlink aliases and resident
custom config paths.

Profile inputs now enforce bounded regular UTF-8 files, likely-secret
rejection, portable Windows path rules, duplicate identity checks, safe glob
composition, real exclude globs, non-mutating offline cache probes, and complete
config/data/cache/model/receipt/lock boundaries. Setup rejects conflicting
profile overrides. Packed-install smoke executes check, diff, apply,
idempotency, and setup integration. User docs, CLI/spec contracts, DB schema,
and changelog reflect the hardened behavior.
## Evidence
- Commits: 35da435
- Tests: bun run lint:check (0 warnings, 0 errors), bun test (3144 pass, 2 platform/opt-in skips, 0 fail), bun run test:package (packed install and user-state sentinel passed), bun scripts/docs-verify.ts (13 passed, 2 model-cache skips, 0 failed), bun run eval:hybrid (88%, 70% threshold passed)
- PRs: