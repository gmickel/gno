# fn-89-runtime-correctness-completion.2 Expose vector diagnostics and correct docs

## Description

Surface preserved vector load failure reason and recovery guidance in Web UI status/Health Center, add regression coverage, and correct core/skill/hosted documentation for verified indexed URI and diagnostics behavior.

## Acceptance

- [ ] Status Health Center includes vector loadError and guidance when unavailable.
- [ ] Repeated status calls do not emit repeated warnings.
- [ ] Existing healthy status remains compatible.
- [ ] Core docs, assets/skill, changelog, and gno.sh docs match tests.

## Done summary
Web status preserves sqlite-vec load failure and recovery guidance without log spam; BM25 fallback remains explicit; docs corrected.
## Evidence
- Commits: 0a1db7b
- Tests: test/serve/api-status.test.ts, full bun test: 2034 pass
- PRs: