# Repair GNO 2.0 desktop release packaging

## Problem
The v2.0.0 npm release is published and all core platform tests and package smoke passed. Desktop packaging fails because Electrobun invokes its bundled Bun 1.3.9 for staging, which cannot read the root Bun 1.4 lockfile. The packaged runtime must also honor the repository Bun pin.

## Requirements
- R1: Stage using the verified pinned repository Bun; ship and verify that same Bun version. Reject mismatches before destructive staging changes.
- R2: Validate the exact staging failure with the old hook runtime and focused regression tests, then build and verify actual platform artifacts.
- R3: Recover desktop publication without retagging v2.0.0, republishing npm, or repeating already-passing core tests. Preserve signing/notarization and artifact provenance. Record the desktop packaging commit separately from the immutable npm tag.

## Scope
Desktop scripts/config, focused tests, release workflow recovery, desktop release documentation and evidence only. No retrieval/runtime product changes, dependencies, fn138/fn141 edits, or hosted website deployment.

## Acceptance
- Pinned Bun production staging works under the original old-Bun hook.
- Focused tests and configured local gates pass.
- Windows and signed/notarized macOS artifacts verify and attach to v2.0.0 release.
- npm2.0.0 remains at98fd4eb11db9708a51915df7d2cb113515ed482f, unchanged.
