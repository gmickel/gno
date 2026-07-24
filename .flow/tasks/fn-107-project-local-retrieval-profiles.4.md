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
Closed the final fn-107 audit findings across contracts, configuration mutation, profile discovery/application, store projection, context identity, security validation, CLI routing, multi-include ingestion, packaging, and public documentation.

Key outcomes:
- Full setup profile projection is additive, idempotent, and repairs missing profile-owned rows without deleting unrelated store state or advancing unchanged timestamps/generations.
- All GNO-owned user config writers use a canonical target-derived cross-process lock, honor global custom config paths, preserve malformed configs, and safely resolve existing or dangling symlink aliases.
- Project profiles use keyed content-type declarations, brace-free Draft-07/runtime parity, normalized context tuple identity, and timestamp-free local fingerprint bindings that detect removal-only edits without leaking local paths in public receipts.
- Generated multi-include patterns scan independently, deduplicate, and preserve literal commas and bracket classes.
- Explicit `setup --apply-profile` validates the full closed apply-receipt shape and aborts before ordinary setup and connector work on inspection transport failure, unsuccessful apply, malformed success receipt, or a receipt collection absent from persisted config.
- Secret context symlink targets, dangling profile aliases, project/runtime overlaps, unsafe Windows paths, and ambiguous context removals fail closed without mutation.
- CLI/spec/schema/package/docs and hosted gno.sh documentation now describe the hardened behavior.

Validation:
- Full GNO suite: 3,182 passed, 2 skipped, 0 failed.
- Final focused profile/setup/walker suite: 111 passed, 0 failed.
- Lint/typecheck/format, docs verification, packed-package smoke, and hybrid eval all passed.
- Packed-package smoke preserved the 1,089,186,752-byte real-user sentinel exactly.
- Hybrid eval: 88% against a 70% threshold.
- Hosted gno.sh: check, 110 tests, and production build passed.
## Evidence
- Commits: a987c27, 955689c, 01ea221
- Tests: bun run lint:check, focused profile/setup/walker suite (111 passed, 0 failed), bun test (3182 passed, 2 skipped, 0 failed), bun run docs:verify (13 passed, 2 skipped), bun run test:package (real-user 1089186752-byte sentinel unchanged), bun run eval:hybrid (88%, threshold 70%), gno.sh: bun run check, gno.sh: bun run test (110 passed, 5 skipped), gno.sh: bun run build
- PRs:
