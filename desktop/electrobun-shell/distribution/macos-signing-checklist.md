# macOS Signing Checklist

Before shipping a signed desktop beta:

1. confirm bundle identifier
2. confirm Apple Developer team and certificate
3. confirm notarization credentials
4. build unsigned artifact
5. sign app bundle
6. notarize app bundle
7. staple notarization ticket
8. upload artifact to the beta channel location
9. publish matching release notes

If any of the above is missing, the desktop beta remains an internal/manual artifact, not a normal rollout path.

## Current repo release path

The shell now exposes a repo-local macOS release command:

```bash
cd desktop/electrobun-shell
APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
NOTARYTOOL_PROFILE="notarytool-profile" \
bun run release:macos
```

What it does:

1. builds the shell
2. runs packaged-runtime verification
3. signs the `.app` with hardened runtime
4. submits a zip to `notarytool`
5. staples the app
6. validates with:
   - `codesign --verify --deep --strict`
   - `xcrun stapler validate`
   - `spctl --assess`
7. creates a final versioned zip from the stapled app
8. optionally creates and notarizes a DMG

Flags:

- `--app-only` - skip DMG creation
- `--skip-build` - reuse existing build output
- `--dry-run` - print resolved config and env use without changing artifacts

Artifacts are written under:

- `desktop/electrobun-shell/artifacts/release-macos/`

## CI release environment

The GitHub Actions release path expects a `release` environment with:

Secrets:

- `APPLE_CERT_P12_BASE64`
- `APPLE_CERT_PASSWORD`
- `KEYCHAIN_PASSWORD`
- `APPLE_NOTARY_KEY_ID`
- `APPLE_NOTARY_ISSUER_ID`
- `APPLE_NOTARY_API_KEY_P8`

Vars:

- `APPLE_SIGNING_IDENTITY`

The workflow creates a temporary macOS keychain, imports the Developer ID
certificate, stores a `notarytool-profile`, and then runs:

```bash
cd desktop/electrobun-shell
bun run release:macos
```
