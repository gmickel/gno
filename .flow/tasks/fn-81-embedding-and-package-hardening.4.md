---
satisfies: [R5, R6]
---

## Description
Add a reusable local package smoke gate that packs the published package shape, installs it into isolated temp layouts, and fails loudly when core CLI health is broken.

**Size:** M
**Files:** `scripts/package-smoke.ts`, `package.json`, `.github/workflows/publish.yml`, `docs/PACKAGING.md`, `.github/CONTRIBUTING.md`, `docs/INSTALLATION.md`, `test/helpers/cleanup.ts`

## Approach
- Build a script under `scripts/` and expose it as `bun run test:package`.
- Use tarball-first verification. Prefer `bun pm pack --quiet --destination <tmp>` or keep `npm pack` only if it better mirrors the publish workflow.
- Install from the tarball into isolated temp `HOME`, `GNO_HOME`, package-manager cache, and install prefix/bin paths.
- Verify package contents against `package.json:28` and executable behavior with `gno --version`, `gno --help`, and `gno doctor --json`.
- Make doctor failures fatal for this smoke. Optional model-heavy init/embed checks may skip with explicit reason.
- Reuse command-runner and cleanup patterns from `desktop/electrobun-shell/scripts/verify-packaged-runtime.ts:62` and `test/helpers/cleanup.ts:18`.

## Investigation targets
**Required**
- `package.json:28` — package files allowlist.
- `package.json:54` — scripts section.
- `.github/workflows/publish.yml:217` — current CI package smoke baseline.
- `desktop/electrobun-shell/scripts/verify-packaged-runtime.ts:62` — command runner pattern.
- `test/helpers/cleanup.ts:18` — temp cleanup helper.
- `docs/PACKAGING.md:170` — verification minimums.
- `.github/CONTRIBUTING.md:44` — release/checklist guidance.

**Optional**
- `test/cli/smoke.test.ts:52` — isolated CLI env pattern.
- `test/cli/search-smoke.test.ts:100` — temp content smoke pattern.

## Key context
Avoid `npm link` as proof; it does not test packed file layout. Preserve temp dirs/tarballs only behind a debug flag or on explicit failure guidance, not by default.

## Acceptance
- [ ] `bun run test:package` creates a tarball in a temp directory and verifies required runtime files are present.
- [ ] Smoke installs from the tarball into isolated temp paths without using host user config.
- [ ] Smoke runs `gno --version`, `gno --help`, and `gno doctor --json`; failures include exact command, stdout, stderr, and temp path guidance.
- [ ] Optional model-heavy checks skip explicitly when offline/no-model conditions prevent them.
- [ ] Publish workflow reuses or matches the local smoke so local and CI gates do not drift.
- [ ] Packaging/release docs mention the new gate if wired into prerelease or CI.

## Done summary

_Not started._

## Evidence

_Not started._
