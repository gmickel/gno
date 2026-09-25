# Releasing GNO

The checklist for an authorized product release: npm package, desktop and
clipper assets, the ClawHub skill, and the downstream sites (gno.sh and the
GNO page on mickel.tech). A release is not finished until every step below
is done; the downstream steps are part of the release, not a separate request. Policy on
when a change needs a release lives in [AGENTS.md](AGENTS.md#versioning--release)
and [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md#release-process).
Documentation-only and CI-only merges skip this file.

A release needs explicit authorization. Merging a PR, or bumping the source
version, does not authorize tagging, npm publication, or a site deploy.

## 1. Prepare the release PR

`main` is protected, so the version bump lands through a PR and the tag goes
on its merge commit.

1. Merge any open `chore/regenerate-og-images` PR (`gh pr list`).
2. Branch `release/vX.Y.Z` from `origin/main` in a clean worktree.
3. Bump with `bun run version:minor` for features, `version:patch` for fixes,
   `version:major` for breaking changes.
4. In `CHANGELOG.md`, move the `[Unreleased]` items into a dated
   `## [X.Y.Z] - YYYY-MM-DD` section, keep an empty `[Unreleased]`, and add the
   compare links. Set README.md's "Current source version" stamp to match
   `package.json`.
5. Run `bun run prerelease` (lint, full `bun test`, `docs:verify`, clipper
   and package checks). Use the repo-pinned Bun.
6. Commit `chore: bump to vX.Y.Z`, open the PR, wait for every required check
   (including `test-windows`), and squash-merge.

## 2. Tag and publish

```bash
git fetch origin main
git tag -a vX.Y.Z -m "vX.Y.Z" <merge-commit-sha>
git push origin vX.Y.Z
```

The tag triggers `publish.yml`: tests on all three platforms, desktop
packaging, the tested npm tarball, the GitHub release, and the ClawHub skill.
When it finishes, confirm:

- `npm view @gmickel/gno dist-tags` shows `latest` at X.Y.Z.
- `gh release view vX.Y.Z` lists the clipper zip and its `.sha256`, the macOS
  desktop `.dmg` and `.zip`, and the Windows desktop zip.
- The `publish-skill` jobs succeeded.

## 3. Propagate the release to gno.sh

Every user-facing item under the release's `### Added` (and any `### Changed`
item that alters what users can do) must be visible on gno.sh before the site
deploy. Do this in one gno.sh PR per release, or confirm the feature PRs
already did it. For each item check:

- **Docs:** a docs page or reference section, registered in the docs nav,
  with its Markdown twin, `llms.txt`, and `llms-full.txt` entry.
- **Feature page:** a `/features/<slug>` page when the capability stands on
  its own (compare the scope of existing pages in `src/lib/product-pages.ts`),
  listed on `/features` and registered for prerender and the sitemap.
- **Landing page:** a card in the right rung of the landing page ladder in
  `src/lib/site-content.ts` (`intake`, `retrieval`, `operations`,
  `surfaces`, `pillars`, `featureHighlights`, and so on). The landing page
  reveals capability from simple to advanced; add to the rung a feature
  belongs to, keep grids balanced, and add a section only when nothing fits.
  Every card links to the docs page or section it describes;
  `src/lib/landing-card-links.test.ts` fails on a missing link or anchor.
- **Counts and claims:** MCP tool counts, integration lists, comparison rows,
  FAQ answers, and `src/lib/public-truth-content.test.ts` pins match the
  release.

Run `bun run check`, `bun run typecheck`, `bun run test`, and `bun run build`
in gno.sh, then drive the changed pages locally at desktop and phone width.
Merge the PR.

## 4. Deploy gno.sh after npm publishes

Deploy only after step 2 confirms npm `latest`, so the site never documents
unreleased behavior. Run the deploy from a machine whose SSH key the server
accepts (currently heimdall):

```bash
cd ~/work/gno.sh && git pull --ff-only
DEPLOY_HOST=root@178.104.180.89 ./scripts/deploy-prod.sh
```

Verify production:

- `curl -fsSI https://gno.sh` returns 200.
- `ssh root@178.104.180.89 "systemctl is-active gno-sh; cat /srv/gno-sh/repo/.output/REVISION"`
  prints `active` and the deployed `origin/main` commit. The deploy leaves the
  remote source checkout alone, so `.output/REVISION` is the runtime identity.
- The pages changed in step 3, their Markdown twins, `/llms.txt`, and
  `/llms-full.txt` return 200 and show the new content, checked in a browser
  at desktop and phone width.

## 5. Update the GNO page on mickel.tech

Repo `~/work/mickel.tech` (Vercel deploys `main`; read its `CLAUDE.md` first,
including the frozen `pnpm-lock.yaml` rule). Work in a worktree from
`origin/main`; the main checkout often carries unrelated branches.

- `lib/releases.ts`: add the vX.Y.Z entry (EN and DE) linking the GitHub
  release.
- `app/apps/gno/page.tsx`: version, MCP tool counts, client and install
  commands, and a mention of each new user-facing capability in the section
  it fits, linked to its gno.sh feature or docs page. Remove any claim the
  release makes untrue.
- The GNO card in `lib/apps.ts` and `app/apps/gno/opengraph-image.tsx` when
  their summary changed.

Run the repo's checks (`bun x biome check .`, `bun x tsc --noEmit`,
`bun run build`), check `/apps/gno` at desktop and phone width, open a PR,
and merge when checks and the Vercel preview pass. Confirm production:
`https://mickel.tech/apps/gno` returns 200 and shows the new version.

