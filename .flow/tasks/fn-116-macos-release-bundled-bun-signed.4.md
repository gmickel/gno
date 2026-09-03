---
satisfies: [R6, R7]
---
# fn-116-macos-release-bundled-bun-signed.4 Maintainer gate: notarized build launches on a clean Apple Silicon machine

## Description
Maintainer-owned release gate. Verify once that a Developer-ID-signed, notarized build produced by the fixed pipeline actually launches on a clean Apple Silicon machine.

### Why this is a separate task

This is the only acceptance criterion in fn-116 that the contributing party cannot close. It requires the project's Developer ID signing certificate and notarytool credentials, which are held only by the maintainer, and the `package-macos-desktop` CI job cannot run on a fork (it needs `APPLE_CERT_P12_BASE64`, `APPLE_CERT_PASSWORD`, `KEYCHAIN_PASSWORD`, and the three `APPLE_NOTARY_*` secrets from the `release` environment).

Everything else in fn-116 is verified: the entitlement is applied, the gate asserts it, unit tests cover the signing-argument construction, and R6 proves the changed code path yields a launchable artifact under an ad-hoc identity. What remains unproven is the interaction with real Developer ID signing and with notarization — specifically, that notarization still succeeds with `com.apple.security.cs.allow-jit` present, and that the stapled, Gatekeeper-assessed artifact launches.

Keeping this as an open task is deliberate. It is why fn-116 should not be marked complete on merge.

### Also confirm the entitlement set is right (R6)

The shipped plist contains only `com.apple.security.cs.allow-jit`. That is the narrowest entitlement that addresses the fault and matches Apple's hierarchy and Electron's practice, but it could NOT be empirically confirmed by the contributor: under ad-hoc signing the app fails library validation and JIT page validation for reasons a Developer ID build does not have, so a full ad-hoc boot required two broader entitlements that mask the question.

On the first real build, if the app still fails to reach its running server state with `allow-jit` alone, the next narrowest step is to add `com.apple.security.cs.allow-unsigned-executable-memory` — and only that. Do not add `disable-library-validation` unless a concrete dlopen failure demands it; under a single-team Developer ID signature it should not.

## Procedure

1. Run the real release path with credentials: `APPLE_SIGNING_IDENTITY=... NOTARYTOOL_PROFILE=... bun run release:macos` from `desktop/electrobun-shell`, or trigger the `package-macos-desktop` job.
2. Confirm the new entitlement gate passed rather than being skipped — it runs before `notarytool submit`, so a silent skip is itself a failure.
3. Confirm notarization succeeded with the entitlement present. This is the specific unknown; a rejection here means the entitlement set needs revisiting, not that the fix is wrong.
4. On a clean Apple Silicon machine that has never run a dev build, mount the resulting DMG and launch the app.
5. Confirm it reaches its running server state and that no new `bun` crash report appears in `~/Library/Logs/DiagnosticReports/` with `EXC_BREAKPOINT` at `pthread_jit_write_protect_np`.

### Files

None. This task produces evidence, not code.

## Acceptance
- [ ] A Developer-ID-signed, notarized build produced by the fixed pipeline was created.
- [ ] The post-sign entitlement gate ran and passed during that build (not skipped).
- [ ] `xcrun notarytool` accepted the submission with `com.apple.security.cs.allow-jit` embedded — recording that notarization is unaffected by the added entitlement.
- [ ] The stapled artifact launched on a clean Apple Silicon machine and reached its running server state.
- [ ] No new `bun` crash report with `EXC_BREAKPOINT` at `pthread_jit_write_protect_np` was produced by that launch.
- [ ] Evidence (commands, notarytool submission id, launch confirmation) recorded in the task's Done summary.


## Done summary
Maintainer gate satisfied: Gordon confirmed on 2026-09-03 that the JIT-entitlement fix shipped and the notarized desktop app launches (CHANGELOG: allow-jit embedded when signing; macOS 27 executable-memory permission; Homebrew SQLite library validation). Closed as part of the fn-130 to fn-135 slate wrap-up; the remaining desktop work is tracked in docs/DESKTOP-BETA-ROLLOUT.md.
## Evidence
- Commits:
- Tests: manual: Gordon confirmed the shipped DMG launches (2026-09-03)
- PRs: