---
satisfies: [R1, R3, R5, R6]
---
# fn-107-project-local-retrieval-profiles.4 Integrate profiles with setup affinity docs and portability proof

## Description
Deliver integrate profiles with setup affinity docs and portability proof as one implementation-sized increment.

**Size:** M
**Files:** `src/core/folder-setup.ts`, `src/core/project-affinity.ts`, `docs/guides/project-profiles.md`, `docs/QUICKSTART.md`, `assets/skill/SKILL.md`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

### Approach
- Let `gno setup` discover/show an optional profile before its own safe apply; no profile remains a first-class path.
- Feed compiled affinity defaults into fn-104 with explicit caller overrides and one precedence: caller override, nearest chosen profile, user config default.
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

### Key context
- Profile values do not override explicit caller inputs; source metadata/content types never become project identity.

## Acceptance
- [ ] Setup can preview/apply a valid profile but remains usable with none or invalid profiles.
- [ ] Affinity precedence is deterministic and explainable across caller/profile/user defaults.
- [ ] A clean-machine portability fixture reproduces config semantics with no committed DB/model/cache/lock/secret state.
- [ ] Docs/skill/gno.sh and full verification gates are current.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
