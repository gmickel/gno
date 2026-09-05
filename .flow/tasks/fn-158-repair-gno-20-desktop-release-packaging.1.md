# fn-158-repair-gno-20-desktop-release-packaging.1 Repair pinned desktop runtime and recover release artifacts

## Description
Repair the Electrobun hook/runtime Bun mismatch and finish the existing 2.0.0 desktop release. Use the exact repository Bun pin for production staging and bundled runtime verification. Preserve the immutable published npm version and tag. Recover Windows packaging through the existing targeted workflow and macOS signing/notarization through an isolated Heimdall build.
## Acceptance
- [ ] R1: Original Bun 1.3.9 hook stages successfully using verified pinned Bun; mismatch fails before replacing prior artifacts.
- [ ] R2: Focused regressions, local gates, Windows packaged-runtime verification and signed/notarized macOS artifact checks pass.
- [ ] R3: Verified desktop artifacts attach to v2.0.0 with packaging source identity recorded; npm and tag unchanged; no repeated core CI publication.
## Done summary
Fixed desktop staging and bundled Bun version selection; mismatch rejected before replacing prior staging. Original Bun1.3.9 hook now stages with pinned1.4.2. Local full gate5223pass2skip0fail; lint/typecheck/docs pass. Windows targeted build and packaged verifier passed. Heimdall signed/notarized/stapled app and DMG; final ZIP roundtrip and Gatekeeper checks passed. PR218 merged; v2.0.0 GitHub release published with five assets, npm/tag unchanged. PR183/207 closed as superseded; AI major181/182 retained. gno.sh PR50/51 merged, user deployed8421909, productionQA passed. Evidence .flow/artifacts/fn-158-repair-gno-20-desktop-release-packaging/.
## Evidence
- Commits: b3db6ae2808a8aecc766c1e073d0ab0da1372cf6, e5b9d13df194b34921f83779afde82d883376be0
- Tests: Bun1.4.2 full suite5223pass2skip0fail, bun run lint:check, bun run docs:verify, Windows packaging run33972434075 PASS, Heimdall release-macos.ts signed/notarized ZIP+DMG PASS
- PRs: https://github.com/gmickel/gno/pull/218