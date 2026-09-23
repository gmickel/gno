# Run the full Windows suite in CI and releases

## Goal

Make Windows CI and publication gates execute the complete test inventory with a supported Bun concurrency flag.

## Reproduction

Publish run 35877336136 used `bun test --concurrency 1` on Bun 1.4.2. The unsupported flag left `1` as a filename filter, so the successful job ran only 22 tests across four files. Bun documents `--max-concurrency=1` for serial concurrency limiting.

## Requirements

Use the supported flag in both ordinary CI and the release workflow. Add an executable command-contract regression with numbered and unnumbered test filenames so a path filter cannot produce another false green. Retain the failed scope evidence. Verify a full Windows run before publication; do not weaken test expectations or hide platform failures. Update CI documentation. No product behavior, dependency or hosted-site behavior change is needed.

## Release boundary

The v2.5.0 tag's workflow was cancelled before publication. Preserve that tag and its negative evidence; use a fresh version for the release containing the verified gate.
