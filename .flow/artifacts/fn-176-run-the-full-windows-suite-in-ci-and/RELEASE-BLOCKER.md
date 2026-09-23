# Publication blocked by full Windows verification

The workflow flag correction is locally verified, but the first correctly scoped Windows run exposed a wider compatibility backlog. Before cancellation after about 20 minutes, the run recorded 4,135 passing tests and 179 failures. These are partial counts; the remaining tests did not complete. The cancellation retained diagnostics instead of treating a long, failing run as success.

Failure identities are in `windows-partial-run.json`. They span watcher/trace tests, native lifecycle fixtures, config validation, path assumptions, platform-specific scripts and timeouts. Causes must be grouped and reproduced before fixes; the count is not a claim of 179 independent product defects.

PR245 remains draft and must not merge while its required Windows check is red. Follow-up fn-177 captures compatibility work. The v2.5.0 publish run was cancelled before npm/GitHub release publication; npm remains at v2.4.0. The v2.5.0 source tag is preserved, and no replacement version has been tagged or published. Both requested feature/site PRs are merged, but production site deployment remains held with publication.
