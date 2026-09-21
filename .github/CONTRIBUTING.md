# Contributing

## CI/CD Matrix

CI always reports **CI result**, runs lint/typecheck, and checks the CI selector
and documentation contracts. The result checks that every selected job succeeded; failed classification, missing outputs,
cancellation, or unexpectedly skipped jobs fail the result. Branch protection
requires `CI result` for conditional runtime coverage, alongside CodeQL and
Dependency Review. Do not require the conditional per-platform job names;
docs-only runs do not emit those names. Documentation-only PRs and main pushes
skip runtime jobs, with that decision checked by the aggregate. Unknown paths
and unavailable diffs select full coverage.

| Trigger                        | Core Linux/macOS            | Windows full suite                                         | Watcher                             | Clipper Chromium E2E                                          |
| ------------------------------ | --------------------------- | ---------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------- |
| Relevant PR                    | Bun 1.4.2                   | Runtime/filesystem/package changes or `test-windows` label | Bun 1.3.11 on three OSes            | Clipper, web ingestion, package/dependency or unknown changes |
| Main push                      | Relevant changes            | Non-documentation changes or `test-windows` label          | Relevant changes                    | Relevant changes                                              |
| Weekly Monday / manual CI      | Bun 1.4.2                   | Always                                                     | Bun 1.3.11 and latest on three OSes | Always                                                        |
| Release tag / publish dispatch | Bun 1.4.2 on all three OSes | Always                                                     | Covered by release tests            | Package verification                                          |

PR label changes trigger classification immediately. Superseded PR runs cancel;
main/manual runs keep independent concurrency groups. Latest-Bun watcher
compatibility runs weekly and on demand, separate from the pinned PR gate.

Repository installs use Bun 1.4.2 to read the current lockfile format. Watcher
jobs install with 1.4.2 before selecting their declared compatibility runtime.
Windows desktop packaging runs for runtime, asset, dependency, shell, and its
own workflow changes, with PR cancellation and the same pinned build runtime.
Root `README.md` and user-facing `docs/` pages do not trigger it. Files under
runtime/asset directories retain coverage even when they are Markdown; shipped
skill instructions under `assets/skill/` are outside the docs-only allowlist.

Real macOS File Provider/cloud-placeholder acceptance, physical desktop behavior,
and retrieval/model performance acceptance remain local. Hosted platform checks
do not substitute for them. Evalite remains opt-in.

## Cache

- Bun packages cached per-OS with lockfile hash
- Auto-invalidates when `bun.lock` changes
- Falls back to partial cache on lockfile change

## Windows Optimizations

- TEMP on D: drive (faster than C: on GH runners)
- SQLite CI-mode pragmas (synchronous=OFF, journal_mode=MEMORY)
- Batch transactions in SyncService (50 docs/tx)

## Release Process

Documentation-only and CI-only merges do not require a version bump or release
tag. Do not add incidental package/lockfile changes to a docs-only PR; those
paths correctly select full runtime coverage. Use documentation/format checks
for docs and relevant workflow/classifier tests for CI changes. Changes to build
or test machinery can still require the affected jobs to run.

Prepare a product release for shipped behavior, skill assets, dependencies, or
packaging changes within an authorized shipping workflow, or when explicitly
requested. A merge alone does not authorize publishing. The full release gates
below continue to apply to release tags and publish dispatches.

Desktop beta rollout scaffolding:

- see `docs/DESKTOP-BETA-ROLLOUT.md`
- see `desktop/electrobun-shell/distribution/`

**First-time setup (npm):**

1. Go to https://www.npmjs.com/package/@gmickel/gno/access
2. Add trusted publisher: owner=`gmickel`, repo=`gno`, workflow=`publish.yml`

**Pre-release Checklist (DoD):**

```bash
bun run lint:check      # Must pass
bun test                # Must pass
bun run docs:verify     # Must pass
bun run test:package    # Must pass
```

Evalite suites are local-only and opt-in. Run `bun run eval` only when Gordon
explicitly asks or when changing retrieval/answer quality behavior.

`bun test` discovers the main, browser-extension and integration suites. It
excludes immutable `.flow/artifacts/` snapshots and local `notes/` experiments;
reproduce those only with their recorded commands and pinned inputs.

**Release:**

```bash
bun run version:patch   # bump version
# Update CHANGELOG.md (move Unreleased, keep empty header, update compare links)
# Match README.md current-source-version to package.json
git add package.json README.md CHANGELOG.md
git commit -m "chore: bump to vX.Y.Z"
git tag vX.Y.Z && git push --tags
```

Tag push triggers full CI + npm publish via OIDC (no token needed).

CLI and desktop are coordinated: npm publication waits for the tested package,
Windows desktop build, and signed/notarized macOS build plus launch test. The
package-smoke job retains exactly one tested tarball and its SHA-256 checksum;
the publication job downloads and verifies it, checks its package/version
identity against the source and any tag, then publishes that archive without
rebuilding. Missing or multiple tarballs fail closed. Publication is serialized
and is never cancelled by a newer release run. Manual publication uses the
package version for the GitHub release tag and the dispatched commit as its
release target. A dry run builds and validates artifacts without publishing.

A source-version bump does not itself authorize a tag or npm publication.

## Manual Workflow Dispatch

```bash
gh workflow run ci.yml                        # run all platforms
gh workflow run windows-packaging.yml         # build + verify packaged Windows desktop runtime
gh workflow run publish.yml -f publish=false  # dry run
gh workflow run publish.yml -f publish=true   # actual publish
```

## Skill distribution

`assets/skill/` is the canonical skill bundle for every harness. After the
coordinated release succeeds, `publish.yml` calls `publish-skill.yml` with
that release tag. The pinned ClawHub CLI skips unchanged content and
publishes changed bundles with explicit `--slug gno --owner gmickel`; its skill version is independent
of the GNO package version. No mirror repository is needed.

Configure the repository secret `CLAWHUB_TOKEN` once with a ClawHub publisher
token. Never put the token in a file committed to this repository. Missing
credentials fail the distribution job visibly; the npm release stays published.
Retry a released tag with the standalone workflow (dry-run defaults to true):

```bash
gh workflow run publish-skill.yml -f ref=vX.Y.Z -f dry_run=true
gh workflow run publish-skill.yml -f ref=vX.Y.Z -f dry_run=false
```

The workflow accepts only stable, existing public releases. Inspect its
`clawhub-skill-publish-json` artifact and the public listing after publication.
Skill publication uses a token; ClawHub's package OIDC support does not cover
skills. ClawHub publishes skills under MIT-0. Runtime code retains this
repository's license.

ClawHub can accept an upload as `pending-publication` before the version is
public. The workflow waits up to ten minutes for that exact public version,
then verifies every file hash. Processing or moderation that exceeds the wait
fails visibly and retains the upload receipt. Resume verification without a
second upload using the version from that receipt:

```bash
gh workflow run publish-skill.yml -f ref=vX.Y.Z -f dry_run=false -f verify_version=1.2.1
```

Use the original GNO release tag and submitted skill version. A pending upload
is not a published skill. The public-version check needs no token and cannot
mistake a private staged version for a public release.

Hash checks use ClawHub's public `/verify` envelope, validate its schema and
publisher/slug/version identity, and compare the exact `artifact.files` source
list with the release. ClawHub's generated `skill-card.md` is described separately
in that envelope; it does not count as an uploaded source file. Missing, changed,
or extra source files still fail verification.
