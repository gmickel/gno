# GNO Desktop Beta Rollout

Rollout checklist for the first public GNO Desktop Beta app.

## Current status

What exists in-repo today:

- app shell scaffold: `desktop/electrobun-shell/`
- app-level singleton/deep-link/file-association direction documented
- in-app onboarding, connectors, import preview, navigation, file lifecycle, and recovery slices

What is still external / missing:

- Apple signing identity
- notarization credentials
- installer packaging decision and artifact pipeline
- update feed host + release-channel metadata host

This means desktop distribution is **not** yet a push-button release. This doc is the handoff/checklist for getting there without tribal knowledge.

## Beta channel checklist

Before cutting a desktop beta:

1. `bun run lint:check`
2. `bun run typecheck`
3. `bun test`
4. `bun run docs:verify`
5. verify shell scaffold assumptions still match `desktop/electrobun-shell/README.md`
6. confirm app-level tabs, file lifecycle, recovery, connectors, and import flows on target macOS

## Signing prerequisites

Required before shipping a signed macOS beta:

- Apple Developer team and signing certificate
- notarization API key / app-specific credentials
- bundle identifier confirmation
- release storage location for signed artifacts

## Update strategy

Current recommendation:

- use a **managed beta channel** first
- release notes and update instructions must explain:
  - where the app stores user data
  - whether the update is in-place or reinstall
  - rollback path if the beta is rejected

Until auto-update infra exists, updates should be treated as:

- support-guided reinstall with explicit version notes

## Rollback checklist

If a beta must be rolled back:

1. stop promoting the broken artifact
2. re-link the previous known-good artifact in the beta channel location
3. notify testers which version to reinstall
4. record affected flows, logs, and support bundle examples

## Support handoff

When a tester reports a desktop beta issue, ask for:

- exact app version
- install source / channel
- what file or deep link they opened
- exported support bundle once that feature lands
- whether the issue reproduces in plain `gno serve`

## Ownership boundary

GNO repo owns:

- rollout checklist
- support workflow
- shell config placeholders
- user-facing install/update docs

External credentials / infra own:

- signing
- notarization
- artifact hosting
- update feed hosting
