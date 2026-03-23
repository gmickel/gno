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
