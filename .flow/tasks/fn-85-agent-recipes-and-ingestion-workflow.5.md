---
satisfies: [R7, R10]
---

## Description

Update hosted `~/work/gno.sh` docs for agent recipes and second-brain workflows, with separate build evidence. This task exists because hosted docs are mandatory and live in a separate repo.

**Size:** M
**Files:** `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`, `/Users/gordon/work/gno.sh/src/lib/prerender-routes.ts`, `/Users/gordon/work/gno.sh/src/lib/product-pages.ts`, `/Users/gordon/work/gno.sh/src/routes/index.tsx` only if landing copy changes, other `~/work/gno.sh` docs/navigation files discovered during implementation.

## Approach

- Add or update hosted docs so public users can discover the same recipe workflow story as repo docs.
- Keep hosted copy aligned with the actual recipe files and installed skill behavior.
- Update product/feature page copy only where recipes become a public product claim.
- Build the hosted site locally; deploy only if the work/release flow calls for it.

## Investigation targets

**Required**

- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx:1849-1955` — hosted skills doc.
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx:1958-2062` — hosted how-to / personal memory doc.
- `/Users/gordon/work/gno.sh/src/lib/prerender-routes.ts:23-46` — docs route list if adding a new slug.
- `/Users/gordon/work/gno.sh/src/lib/product-pages.ts` — agent integration product copy if recipes become first-class public copy.

**Optional**

- `/Users/gordon/work/gno.sh/src/routes/index.tsx` — landing copy only if needed.
- `/Users/gordon/work/gno.sh/scripts/deploy-prod.sh` — deployment path if release closeout includes hosted deploy.

## Key context

Production hosted docs are not the legacy `website/` directory in this repo. Do not call fn-85 complete while hosted `gno.sh` source is stale. If deployment is not part of the task run, build locally and record the deploy state/blocker.

## Acceptance

- [ ] Hosted `gno.sh` docs explain agent recipes/playbooks and second-brain workflows with the same boundaries as repo docs.
- [ ] Hosted docs avoid false native connector, cron, background-agent, nonexistent command/flag/target, and nonexistent MCP tool/prompt claims.
- [ ] Hosted docs note the recipe/preset behavior without implying fn-83 spec closure if it remains open.
- [ ] `cd ~/work/gno.sh && bun run build` passes, or evidence records a blocker unrelated to this change.
- [ ] If a new hosted docs route is added, `prerender-routes.ts` or equivalent route metadata includes it.

## Done summary

Updated hosted gno.sh docs/source copy for second-brain recipes. The hosted skills docs, how-to docs, product page, and FAQ/site-content now describe recipe workflows, preview commands, supported skill targets, and connector boundaries.

## Evidence

- Commits: 753cbdd
- Tests: cd ~/work/gno.sh && bun run typecheck, cd ~/work/gno.sh && bun run build, cd ~/work/gno.sh && rg prerendered output for recipe copy, cd ~/work/gno.sh && rg stale-claim audit over src docs package.json
- PRs:
