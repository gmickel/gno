# fn-116-macos-release-bundled-bun-signed.5 Permit bundled Bun to load Homebrew SQLite under hardened runtime

## Description
Fix the public macOS desktop launch failure on developer Macs where GNO selects Homebrew SQLite with a different Team ID. Scope disable-library-validation only to the bundled Bun runtime, strengthen the release gate and regression tests, document the rationale, and make the credentialed mounted-DMG CI self-test install and exercise Homebrew SQLite.

## Acceptance
Bundled Bun is signed with hardened runtime, allow-jit, and disable-library-validation; no other nested executable receives entitlements. Credentialed package-macos-desktop installs Homebrew SQLite and the mounted-DMG /api/status self-test passes without a new Bun crash report. Focused tests and full prerelease gate pass. v1.34.3 is published and its public DMG independently launches on a Homebrew-SQLite Mac.

## Done summary
Scoped allow-jit plus disable-library-validation to the bundled Bun runtime; strengthened signing checks and regression coverage; installed Homebrew SQLite in credentialed packaging; dry-run DMG passed. Work landed in 729bb943 and shipped (CHANGELOG: notarized macOS desktop app failing before launch on developer Macs with Homebrew SQLite); the task state was never advanced, corrected on 2026-09-03.
## Evidence
- Commits: 729bb943eba1ec6465de788d833634c7fdf249c1
- Tests: bun test desktop/electrobun-shell/test/release-macos.test.ts desktop/electrobun-shell/test/release-macos-policy.test.ts desktop/electrobun-shell/test/publish-workflow.test.ts (47 pass)
- PRs: