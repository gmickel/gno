# fn-39-sdk-and-library-mode.1 Design and implement the first stable GNO SDK surface

## Description

Define and implement the first stable importable GNO SDK surface so other apps can embed indexing and retrieval directly without CLI subprocesses or a local server requirement. Keep the API intentionally small, typed, lifecycle-safe, and documented enough that a fresh consumer can adopt it from the README/docs alone.

## Acceptance

- Define and implement the first stable public SDK surface for GNO.
- Support inline config and explicit lifecycle management.
- Add package export/type wiring and import tests.
- Add at least one end-to-end SDK usage test.
- Update README, user docs, architecture/docs, and website copy/examples.

## Notes For Implementer

- Start by deciding the public boundary before exposing any symbols.
- Keep CLI wiring and SDK entrypoints separate.
- Support inline config first; file-based config can remain convenience only.
- External references:
  - local upstream reference implementation already cloned under `~/repos`
  - its `package.json` export surface
  - its `src/index.ts` package entrypoint
  - its `src/store.ts` store wrapper

## Done summary

Implemented the first stable GNO SDK surface at the package root. Added `createGnoClient(...)` with inline-config and file-backed startup, direct `search` / `vsearch` / `query` / `ask` / `get` / `multiGet` / `list` / `status` / `update` / `embed` / `index` / `close` methods, package export wiring, contract tests, and full README/docs/website coverage.

Key decisions:

- package root now resolves to the SDK, while the `gno` binary stays on the CLI bootstrap
- inline config is first-class; YAML is optional for SDK consumers
- SDK methods reuse store/pipeline internals directly, not CLI subprocess wrappers
- indexing and embedding are callable programmatically through the same client

## Evidence

- Commits:
- Tests: bun run lint:check, bunx tsc --noEmit, bun test, bun run docs:verify, bun run build:css, npm pack, bun test test/sdk/client.test.ts --timeout 60000, bun src/index.ts init <isolated-fixtures> --name fixtures && bun src/index.ts update && bun src/index.ts search "JWT token" --json, tarball SDK consumer smoke via bun add ./gmickel-gno-0.22.6.tgz, cd website && mise x -- bundle install && mise x -- make build
- PRs:
