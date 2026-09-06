# Contributing

## CI/CD Matrix

CI always reports **CI result** and runs lint/typecheck once. The result checks
that every selected job succeeded; failed classification, missing outputs,
cancellation, or unexpectedly skipped jobs fail the result. The existing
`test (ubuntu-latest)` and `test (macos-latest)` names remain available to branch
protection. Documentation-only PRs skip runtime jobs, with that decision checked
by the aggregate. Unknown paths and unavailable diffs select full coverage.

| Trigger                        | Core Linux/macOS            | Windows full suite                                         | Watcher                             | Clipper Chromium E2E                                          |
| ------------------------------ | --------------------------- | ---------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------- |
| Relevant PR                    | Bun 1.4.2                   | Runtime/filesystem/package changes or `test-windows` label | Bun 1.3.11 on three OSes            | Clipper, web ingestion, package/dependency or unknown changes |
| Main push                      | Relevant changes            | Always                                                     | Relevant changes                    | Relevant changes                                              |
| Weekly Monday / manual CI      | Bun 1.4.2                   | Always                                                     | Bun 1.3.11 and latest on three OSes | Always                                                        |
| Release tag / publish dispatch | Bun 1.4.2 on all three OSes | Always                                                     | Covered by release tests            | Package verification                                          |

PR label changes trigger classification immediately. Superseded PR runs cancel;
main/manual runs keep independent concurrency groups. Latest-Bun watcher
compatibility runs weekly and on demand, separate from the pinned PR gate.

Repository installs use Bun 1.4.2 to read the current lockfile format. Watcher
jobs install with 1.4.2 before selecting their declared compatibility runtime.
Windows desktop packaging runs for runtime, asset, dependency and shell changes,
with PR cancellation and the same pinned build runtime.

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
git add package.json CHANGELOG.md
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
