---
title: Packaging Matrix
description: Packaging and support matrix for GNO CLI and desktop shell across macOS and Linux.
keywords: gno packaging, desktop shell packaging, cli support matrix, mac linux packaging
---

# Packaging Matrix

Support matrix for what GNO should actually ship on macOS and Linux.

This is split by product surface:

- CLI
- desktop shell

Use this document when deciding what artifacts to publish, what to test in CI,
and what to claim in release notes.

## Support Tiers

- **Supported**: intended normal path; tested and documented; issues are treated
  as product bugs
- **Beta**: explicitly offered to real users, but rollout/update/support is
  still narrower and may require caveats
- **Experimental**: allowed for advanced users, but not promised as a stable
  release surface
- **Unsupported**: do not claim, publish, or recommend

## Runtime Constraints

Current repo/runtime facts that drive the matrix:

- GNO still requires Bun for the CLI path
- desktop shell currently uses Electrobun
- `fts5-snowball` is vendored only for:
  - `darwin-arm64`
  - `darwin-x64`
  - `linux-x64`
  - `windows-x64`
- `sqlite-vec` is loaded from npm/runtime bindings rather than a separate
  vendored binary
- macOS CLI vector search still relies on extension-capable Homebrew SQLite;
  Bun's default SQLite is not enough on macOS
- Linux and Windows use Bun's bundled SQLite extension support natively

## Recommended Matrix

| Surface | OS / Arch   | Tier         | Recommended artifact                        | Notes                                                     |
| :------ | :---------- | :----------- | :------------------------------------------ | :-------------------------------------------------------- |
| CLI     | macOS arm64 | Supported    | npm package via Bun global install          | default macOS CLI path                                    |
| CLI     | macOS x64   | Supported    | npm package via Bun global install          | same support story as arm64                               |
| CLI     | Linux x64   | Supported    | npm package via Bun global install          | simplest Linux path today                                 |
| CLI     | Linux arm64 | Experimental | npm package via Bun global install          | no vendored `fts5-snowball` proof yet                     |
| Desktop | macOS arm64 | Beta         | signed `.app` inside DMG                    | primary desktop target                                    |
| Desktop | macOS x64   | Beta         | signed `.app` inside DMG                    | keep parity with Apple Silicon when signing path is ready |
| Desktop | Linux x64   | Experimental | unpacked app dir or AppImage-style artifact | only after runtime proof on Ubuntu baseline               |
| Desktop | Linux arm64 | Unsupported  | none                                        | no runtime proof and no vendored stemmer binary           |

## Artifact Guidance

### CLI

Recommended public artifact:

- npm package as the first-class CLI distribution path

Why:

- already works
- keeps release complexity low
- matches current install docs and support model

Not recommended as first-class right now:

- separate tarball/zip-only CLI releases for macOS/Linux

Those can exist later for convenience, but they should not replace the npm path
until they have the same verification and support story.

### Desktop: macOS

Recommended first real desktop artifact:

- signed `.app` delivered in a DMG

Why:

- normal Mac install UX
- compatible with notarization/stapling flow
- clearer support story than loose unsigned bundles

Allowed internal/manual artifact:

- unsigned local build output for internal smoke testing only

Defer for now:

- PKG installer as the primary user-facing path

PKG may still be useful for managed org rollout later, but DMG is the simpler
beta path.

### Desktop: Linux

Recommended first artifact if Linux desktop moves forward:

- one explicit `linux-x64` beta target
- Ubuntu `22.04+` as the baseline distro
- artifact shape:
  - unpacked portable bundle first, or
  - AppImage-style beta artifact if the shell toolchain proves reliable

Why not broader Linux claims yet:

- distro fragmentation
- desktop shell verification is still thinner than macOS/Windows
- vendored `fts5-snowball` only covers `linux-x64`

Do not claim:

- “Linux supported” as a blanket statement for all distros/arches

## Bundling Assumptions

### CLI

Assume present on the user machine:

- Bun runtime
- on macOS: Homebrew SQLite with extension loading support

Bundle/ship with the package:

- TypeScript source/runtime code
- vendored `fts5-snowball` binaries already present in `vendor/`

### Desktop

Bundle inside the packaged app:

- Bun runtime
- staged GNO runtime
- vendored `fts5-snowball` for the target platform
- anything needed so `gno doctor --json` can validate the packaged runtime in
  place

Do not rely on end users having separately installed:

- Bun
- Homebrew SQLite
- shell-specific helper tools

Desktop distribution is only credible if the app bundle is self-sufficient.

## Release Guidance

Today:

- CLI on macOS + Linux x64 is the normal supported shipping surface
- macOS desktop is the primary next desktop beta target
- Linux desktop should remain experimental until there is packaged-runtime proof
  on the chosen Ubuntu baseline

That means release notes should avoid implying:

- Linux desktop GA
- Linux arm64 support
- packaged macOS desktop GA before signing/notarization exist

## Verification Minimums

Before claiming a surface as Supported/Beta:

- `bun run lint:check`
- `bun run typecheck`
- `bun test`
- `bun run docs:verify`

Desktop-specific proof:

- packaged shell boots
- `gno doctor --json` passes inside the packaged runtime
- `fts5-snowball` loads for the claimed platform/arch
- `sqlite-vec` loads for the claimed platform/arch
- basic indexing/search flow works in the packaged app

## Current Recommendation Summary

- **Ship CLI**: macOS arm64/x64 + Linux x64
- **Ship desktop beta**: macOS arm64/x64 first
- **Offer Linux desktop only as experimental**: `linux-x64`, Ubuntu `22.04+`,
  after packaged-runtime proof exists
- **Do not claim**: Linux arm64 desktop, Linux-wide desktop GA, or PKG/MSI as
  the primary cross-platform path today
