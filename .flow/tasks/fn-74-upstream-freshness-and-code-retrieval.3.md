# fn-74-upstream-freshness-and-code-retrieval.3 Pin dependency versions and document policy

## Description

Move GNO toward exact dependency pins where practical so releases are reproducible and native/runtime dependencies do not drift under semver ranges.

QMD pinned all dependencies after lockfile/build-script drift. GNO already uses `bun install --frozen-lockfile` in CI/publish, but `package.json` still has many `^` ranges. Decide the exact pin policy for dependencies and devDependencies, apply it, and document when/how dependency freshness should be checked.

## Acceptance

- [ ] Audit all `package.json` dependency ranges and identify any that should intentionally remain ranged.
- [ ] Convert dependencies/devDependencies to exact versions where practical.
- [ ] Keep `bun.lock` consistent with the pinned manifest.
- [ ] Verify CI/publish workflows still use `bun install --frozen-lockfile` where required.
- [ ] Document dependency pin/update policy in repo maintenance/release docs and/or `AGENTS.md`/`CLAUDE.md`.
- [ ] Include specific guidance to periodically evaluate native/runtime deps: `node-llama-cpp`, `sqlite-vec`, and package build-script/trusted dependency requirements.
- [ ] Run full gate: `bun install --frozen-lockfile`, `bun run lint:check`, `bun test`, and `bun run docs:verify` if docs changed.
- [ ] Changelog documents dependency policy change.

## Done summary
Converted direct dependencies/devDependencies to exact pins, documented the pin/freshness policy, made CSS build use the pinned local Tailwind CLI, and verified frozen install/package smoke.
## Evidence
- Commits:
- Tests:
- PRs: