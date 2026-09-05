# GNO 2.0 desktop packaging recovery

The npm package was published by trusted publishing in run 33965952391 from
`98fd4eb11db9708a51915df7d2cb113515ed482f`; `latest` resolves to 2.0.0. Its
provenance attestation is present. All three platform test jobs and package
smoke passed. Both desktop jobs then failed because Electrobun's Bun 1.3.9
could not read the Bun 1.4 lockfile. Raw failures are retained here.

Packaging source: `b3db6ae2808a8aecc766c1e073d0ab0da1372cf6`.
The fix uses the verified root Bun pin for staging and the bundled runtime;
it does not change the npm package source or move the release tag.

The old-Bun-hook staging reproduction and isolated version/init/update/search
results are retained as lossless gzip files. `manifest.json` hashes the
uncompressed evidence. The Windows-only build and packaged-runtime verifier
passed in run 33972434075. Heimdall built and verified the pinned runtime, signed the app with hardened
runtime and required entitlements, and notarized/stapled both app and DMG.
The final ZIP passed extraction, signature, stapler and Gatekeeper checks.
Artifact identities and raw signing/verification receipts are retained here.

The downloaded published npm archive has SHA256
`98f358434d43ab7c10b75409989d4462beb3353feebf82127b98150deead317b`.
Of 1,011 files, 1,010 are byte-identical to the frozen local acceptance tarball.
The only difference is regenerated `src/serve/public/globals.built.css`:
1,049 additional bytes of utility selectors (list-item, flex-shrink alias,
important text-decoration/filter utilities and backdrop-filter). Existing
utility declarations are unchanged. The registry reports the original tag
commit as gitHead; the archive is not claimed byte-identical to the local
prepublication tarball.

PR183 was closed as superseded by PR193 (shipped 1.34.6), with contributor
credit. Dependabot PR207 was closed as superseded by the 2.0 dependency sweep.
Deferred AI SDK major PRs181/182 remain open.

Local final gate: Bun 1.4.2, 5,223 pass / 2 pre-existing skips / 0 fail,
41,728 assertions across 616 files. Lint/typecheck passes with 26 existing
warnings; docs verification passes. An initial host-PATH test invocation
used Bun 1.3.14 and hit the same unsupported-lockfile condition; it was
stopped and its raw log retained. The complete pinned-runtime run is the
acceptance result.

GitHub release published2026-09-05T14:57:06Z with all five assets.
GitHub digest and size fields for all three desktop files match the verified
local artifacts. PR218 merged at e5b9d13d; fn158 task and spec closed.
The original failed publish workflow remains an honest failed run; recovery
used targeted Windows CI and the local Heimdall signed release pipeline.
