---
satisfies: [R5, R6]
---

<!-- Updated by plan-sync: fn-81-embedding-and-package-hardening.2 shipped additive `embedding-fingerprint` doctor JSON fields, so package smoke should assert that exact check/shape instead of only generic doctor success -->
<!-- Updated by plan-sync: fn-81-embedding-and-package-hardening.3 extracted shared same-run retry logic into `src/embed/retry.ts` and aligned the SDK force path, so package smoke should prove that helper ships in the tarball and not only the doctor-only CLI path -->

## Description

Add a reusable local package smoke gate that packs the published package shape, installs it into isolated temp layouts, and fails loudly when core CLI health is broken.

**Size:** M
**Files:** `scripts/package-smoke.ts`, `package.json`, `.github/workflows/publish.yml`, `docs/PACKAGING.md`, `.github/CONTRIBUTING.md`, `docs/INSTALLATION.md`, `spec/output-schemas/doctor.schema.json`, `src/cli/commands/doctor.ts`, `test/spec/schemas/doctor.test.ts`, `test/helpers/cleanup.ts`

## Approach

- Build a script under `scripts/` and expose it as `bun run test:package`.
- Use tarball-first verification. Prefer `bun pm pack --quiet --destination <tmp>` or keep `npm pack` only if it better mirrors the publish workflow.
- Install from the tarball into isolated temp `HOME`, `GNO_HOME`, package-manager cache, and install prefix/bin paths.
- Verify package contents against `package.json:28`, including runtime embed files now required by task 3 such as `src/embed/retry.ts`, and executable behavior with `gno --version`, `gno --help`, and `gno doctor --json`.
- Assert the shipped doctor contract from task 2: the JSON output should contain the `embedding-fingerprint` check and its additive `embeddingFingerprint` payload (`currentFingerprint`, `pendingChunks`, `legacyChunks`, `mixedGroups`, `groups`), not just parse as generic JSON.
- Make doctor failures fatal for this smoke. Optional model-heavy init/embed checks may skip with explicit reason.
- Reuse command-runner and cleanup patterns from `desktop/electrobun-shell/scripts/verify-packaged-runtime.ts:62` and `test/helpers/cleanup.ts:18`.

## Investigation targets

**Required**

- `package.json:28` — package files allowlist.
- `package.json:54` — scripts section.
- `.github/workflows/publish.yml:217` — current CI package smoke baseline.
- `desktop/electrobun-shell/scripts/verify-packaged-runtime.ts:62` — command runner pattern.
- `src/embed/retry.ts:1` — shared same-run retry helper now imported by CLI and SDK embed paths.
- `src/cli/commands/doctor.ts:185` — `embedding-fingerprint` check name and JSON payload source.
- `spec/output-schemas/doctor.schema.json:45` — additive doctor JSON contract for fingerprint health.
- `test/spec/schemas/doctor.test.ts:17` — concrete schema example for the packaged smoke assertion.
- `test/helpers/cleanup.ts:18` — temp cleanup helper.
- `docs/PACKAGING.md:170` — verification minimums.
- `.github/CONTRIBUTING.md:44` — release/checklist guidance.

**Optional**

- `test/cli/smoke.test.ts:52` — isolated CLI env pattern.
- `test/cli/search-smoke.test.ts:100` — temp content smoke pattern.

## Key context

Avoid `npm link` as proof; it does not test packed file layout. Task 3 moved retry behavior into `src/embed/retry.ts`, so the smoke should fail if that runtime file is missing from the tarball even when `gno doctor --json` still works. Preserve temp dirs/tarballs only behind a debug flag or on explicit failure guidance, not by default.

## Acceptance

- [ ] `bun run test:package` creates a tarball in a temp directory and verifies required runtime files are present, including the task 3 retry helper path used by packaged embed flows.
- [ ] Smoke installs from the tarball into isolated temp paths without using host user config.
- [ ] Smoke runs `gno --version`, `gno --help`, and `gno doctor --json`; failures include exact command, stdout, stderr, and temp path guidance.
- [ ] Packaged `gno doctor --json` proves the shipped `embedding-fingerprint` check shape from task 2, not merely overall JSON validity.
- [ ] Optional model-heavy checks skip explicitly when offline/no-model conditions prevent them.
- [ ] Publish workflow reuses or matches the local smoke so local and CI gates do not drift.
- [ ] Packaging/release docs mention the new gate if wired into prerelease or CI.

## Done summary

Added a reusable tarball-first package smoke gate exposed as `bun run test:package`, with isolated npm/global install paths, packed file assertions including `src/embed/retry.ts`, and packaged doctor fingerprint JSON shape validation. Updated publish CI and package/release docs to use the same local gate.

## Evidence

- Commits: 8dca5768d6e7f0fd5ed7b937e84870188c8735c1
- Tests: bun test test/spec/schemas/doctor.test.ts, bun run docs:verify, bun run lint:check, bun run test:package, bun run typecheck, bun test
- PRs:
