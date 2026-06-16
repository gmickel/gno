# fn-4.1 Add Hermes skill install target

## Description

TBD

## Acceptance

- [ ] TBD

## Done summary

Added Hermes Agent as a first-class GNO skill install target, including install/uninstall/path resolution, --target all, env override safety, tests, docs, bundled skill reference, connector status, changelog, and hosted gno.sh copy.

## Evidence

- Commits: 26264fb, cfcbda8
- Tests: bun run lint:check, bun test, bun run docs:verify, HERMES_SKILLS_DIR=$(mktemp -d) bun src/index.ts skill install --target hermes --force --json + uninstall smoke, gno.sh: bun run typecheck, gno.sh: bun run test, gno.sh: bun run build
- PRs:
