# Contributing

## CI/CD Matrix

| Trigger                   | Ubuntu | macOS | Windows | npm publish |
| ------------------------- | ------ | ----- | ------- | ----------- |
| PR                        | ✓      | ✓     | -       | -           |
| PR + label `test-windows` | ✓      | ✓     | ✓       | -           |
| Push main                 | ✓      | ✓     | ✓       | -           |
| Tag `v*`                  | ✓      | ✓     | ✓       | ✓           |
| Manual dispatch           | ✓      | ✓     | ✓       | optional    |

**Rationale:**

- PRs run Ubuntu + macOS (core dev platforms)
- Windows only on main/tags/manual (slow, less critical)
- Label `test-windows` for Windows-specific PR testing
- npm publish only on explicit version tags

## Cache

- Bun packages cached per-OS with lockfile hash
- Auto-invalidates when `bun.lockb` changes
- Falls back to partial cache on lockfile change

## Windows Optimizations

- TEMP on D: drive (faster than C: on GH runners)
- SQLite CI-mode pragmas (synchronous=OFF, journal_mode=MEMORY)
- Batch transactions in SyncService (50 docs/tx)

## Release Process

**First-time setup (npm):**

1. Go to https://www.npmjs.com/package/@gmickel/gno/access
2. Add trusted publisher: owner=`gmickel`, repo=`gno`, workflow=`publish.yml`

**Pre-release Checklist (DoD):**

```bash
bun run lint:check      # Must pass
bun test                # Must pass
bun run eval            # Must pass 70% threshold
```

**Release:**

```bash
bun run version:patch   # bump version
# Update CHANGELOG.md (move Unreleased, keep empty header, update compare links)
git add package.json CHANGELOG.md
git commit -m "chore: bump to vX.Y.Z"
git tag vX.Y.Z && git push --tags
```

Tag push triggers full CI + npm publish via OIDC (no token needed).

## Manual Workflow Dispatch

```bash
gh workflow run ci.yml                        # run all platforms
gh workflow run publish.yml -f publish=false  # dry run
gh workflow run publish.yml -f publish=true   # actual publish
```
