# fn-177-restore-full-windows-test-compatibility.1 Restore full Windows regression compatibility

## Description
Diagnose grouped Windows failures and implement the smallest verified corrections.

## Acceptance
Satisfy the parent goal, requirements and boundaries; retain negative evidence and verify the complete Windows inventory.

## Done summary
Restored complete Windows CI coverage and corrected observed platform/runtime failures without blanket skips or weakened assertions. Final Windows run: 5,375 pass, 29 existing skips, 0 fail across 644 files; Linux/macOS, watcher, CodeQL, clipper and packaging gates pass. Private writes await bounded ACL validation, receipt writers serialize, SID checks use native identities, and bootstrap reads bind metadata and bytes to one descriptor. Git docs, integration docs and hosted audit guidance updated; site PR70 passed live desktop/mobile QA. v2.5.1 release metadata prepared; publication/deployment remain the next authorized workflow stages. Review stages skipped by repository policy.
## Evidence
- Commits: 260c57fa219e09c6c90019569ac89593dc7e9331, 0e4d9355949a8bf45110c630d78761c723f0b852, 0c59094c838b8353f66b7f6fd6d5f23f90e74409, 5232e3efb9e6fab87ce9e4589ef515b9da3eefac, 23933c2171877ad04aabcecb4b993786154dda02, 1f700ac3d7cfab24d9310e50035c91d6d8f69e76, fc94700b520b984c2bb71394a5f4e04c987d70ff, 64644cd94f214f6685cc870d3868256d93bd4d63, 1231b0af8a2fbe6c25ca7aad510ec89febc562af, dac3aa36f9e391770760ab6a3412315c6ad221bb, 8d5112e10230c59e73e8a61be43cf620a6c74f72, c72e2b996bb5b60e8e8cba15c3ca7bd9a2c9c933
- Tests: mise exec bun@1.4.2 -- bun test, bun test --max-concurrency=1 (Windows Actions run35924825875), bun run lint:check, bun run docs:verify, bun run test:package, bun run prerelease, uv run eval.py (47/47 skill checks), gno.sh desktop/mobile live QA and CI in PR70
- PRs: https://github.com/gmickel/gno/pull/245, https://github.com/gmickel/gno.sh/pull/70