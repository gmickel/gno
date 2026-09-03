# fn-116-macos-release-bundled-bun-signed.6 Permit bundled Bun JIT executable memory on macOS 27 and detect all crash reports

## Description
A notarized v1.34.3 app passes clean-runner CI but macOS 27 beta kills Contents/MacOS/bun after Electrobun creates its Worker. The crash report proves SIGKILL (Code Signature Invalid), CODESIGNING Invalid Page, in a JIT-generated executable region. A Developer-ID-signed diagnostic adding only com.apple.security.cs.allow-unsigned-executable-memory to the already scoped Bun reaches /api/status and exits 0. Also make the release crash-report guard detect hidden .bun files and both user/system DiagnosticReports directories.

## Acceptance
Contents/MacOS/bun alone carries allow-jit, allow-unsigned-executable-memory, and disable-library-validation; post-sign release assertions and unit tests require all three; macOS launch gate fails on visible or hidden Bun .ips/.crash reports in readable user/system DiagnosticReports directories; docs explain the macOS 27 failure signature and exact entitlement scope; full local gate and credentialed dry run pass; public hotfix DMG passes notarization/signature/entitlement/Homebrew SQLite /api/status/no-new-crash verification on this Mac.

## Done summary
Granted only the packaged Bun executable com.apple.security.cs.allow-unsigned-executable-memory alongside allow-jit and disable-library-validation; release gate checks user and system crash reports. Work landed in 3b08da5c and shipped (CHANGELOG: notarized macOS desktop app killed during Electrobun Worker startup on macOS 27); the task state was never advanced, corrected on 2026-09-03.
## Evidence
- Commits: 3b08da5ca6dd334543dd03a2e01b2c4fabba6288
- Tests: bun test test/scripts/release-macos-signing.test.ts test/desktop/electrobun-shell.test.ts (49 pass), bun test (4039 pass, 2 skip, 0 fail)
- PRs: