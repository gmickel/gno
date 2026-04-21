# fn-72-backgrounding-flags-for-serve-and-daemon.8 Update website/ hand-maintained docs + skill/ reference + ADR

## Description
Update the external marketing/docs website at **`~/work/gno.sh`** (separate Vite + TanStack Router repo, NOT the legacy in-repo `website/`), plus the agent skill package, plus a new ADR in this repo. Deploy the website after merge.

This task spans two repos. Open two PRs, one per repo, and coordinate the merge order so gno.sh doesn't ship docs for unreleased flags.

**Size:** M

**Files in `~/work/gno.sh` (external website):**
- `src/lib/gno-docs.tsx` — CLI reference section around L581-705 (`gno serve`, `gno daemon`, `--port`). Add the five new flags with usage examples.
- `src/lib/product-pages.ts`:
  - L566-592 — `daemon-mode` feature page. Replace `"nohup gno daemon > /tmp/gno-daemon.log 2>&1 &"` at L582 with `"gno daemon --detach --log-file /tmp/gd.log"`. Add `gno daemon --status` and `gno daemon --stop` to the commands list. Update the "Reuses the same watch, sync, and embed runtime" benefit bullets to include the new lifecycle controls.
  - L118 — `gno serve` commands list: add `"gno serve --detach"` variant.
  - L663 — FAQ: drop "Use nohup, launchd, or systemd if you want supervision" — replace with native `--detach`/`--status`/`--stop` guidance.
  - L731-733 — `serve` vs `daemon` FAQ: note that both now support `--detach`/`--status`/`--stop` and the choice remains about UI vs headless.
- `src/lib/gno-comparisons.tsx` — L92-94 "Headless daemon" comparison row. Optional polish; verify it still reads correctly with the new lifecycle story.
- `src/routes/install.tsx` — L254 "desktop build wraps `gno serve`" — check whether to mention `--detach` as a self-hosted alternative.

**Files in `~/work/gno` (this repo):**
- `assets/skill/cli-reference.md` — serve section ~L492, daemon section ~L321. Add all five new flags. Triggers a ClawHub skill version bump at release time (per root `CLAUDE.md` rules).
- `docs/adr/005-daemon-detach-lifecycle.md` — new ADR using `docs/adr/000-template.md` as template. Document: why `resolveDirs().data` over `~/.gno/`; why JSON pid-file over bare PID; why exit code 3; why `taskkill` fallback on Windows; why the `--__detached-child` sentinel is hidden from `--help`.

## Approach
- Keep the gno.sh edits minimal — CLI reference section gets the flag tables, daemon-mode feature page gets updated commands + copy, FAQ gets de-staled. No new components, no redesigns.
- The `nohup gno daemon > /tmp/gno-daemon.log 2>&1 &` string at `~/work/gno.sh/src/lib/product-pages.ts:582` is the single most important fix — it's currently the recommended pattern on the public daemon-mode page.
- Verify the site builds with `bun run dev` locally before opening the gno.sh PR (Vite dev server on :3344).
- For the ADR, follow the same structure as `docs/adr/001-scholarly-dusk-design-system.md` or whichever 00X is most recent; keep it under 200 lines.
- Note in the gno repo PR description that a post-merge ClawHub skill republish is required.

## Deploy (after gno.sh PR merges to main)

Production deploy is a single SSH-driven script at `~/work/gno.sh/scripts/deploy-prod.sh`. It fetches the latest `main` on the remote, installs deps, builds, and reloads the service.

```bash
cd ~/work/gno.sh
DEPLOY_HOST=root@178.104.180.89 ./scripts/deploy-prod.sh
```

Default target is the `main` branch; override with `DEPLOY_REF=<branch>` if staging a hotfix. The script expects `bun` on the remote and uses `DEPLOY_PATH=/srv/gno-sh/repo` by default.

Verify after deploy:
- `curl -sSf https://gno.sh/docs | grep -i "detach"` confirms the new flags rendered in the CLI reference.
- Load `https://gno.sh/features/daemon-mode` in a browser; confirm the stale `nohup` example is gone.

## Investigation targets
**Required:**
- `~/work/gno.sh/src/lib/gno-docs.tsx:581-705` — CLI reference section
- `~/work/gno.sh/src/lib/product-pages.ts:566-592` — daemon-mode feature page (stale `nohup` example)
- `~/work/gno.sh/src/lib/product-pages.ts:663, 731-733` — FAQ entries mentioning daemon
- `~/work/gno.sh/scripts/deploy-prod.sh` — production deploy mechanics
- `~/work/gno/assets/skill/cli-reference.md` — serve + daemon flag tables
- `~/work/gno/docs/adr/000-template.md` — ADR format

**Optional:**
- `~/work/gno.sh/src/lib/gno-comparisons.tsx:92-94` — daemon comparison row
- `~/work/gno.sh/src/routes/install.tsx` — install page serve mentions
- Root `CLAUDE.md` ClawHub publish workflow section — exact steps for post-release skill bump

## Key context
- `~/work/gno.sh` is a separate git repo and will need its own PR.
- Coordinate merge order: land the gno CLI change first so gno.sh doesn't document flags that don't exist yet.
- `assets/skill/` changes trigger a ClawHub release. Do NOT publish to ClawHub from this task — that's a manual dashboard step post-merge.
- `~/work/gno.sh` uses Vite + TanStack Router; CLI docs are inline JSX (NOT markdown). Edit TSX directly.
- Production deploy is manual and gated on PR merge — run `DEPLOY_HOST=root@178.104.180.89 ./scripts/deploy-prod.sh` from `~/work/gno.sh`. No auto-deploy.
## Approach
- Keep the gno.sh edits minimal — CLI reference section gets the flag tables, daemon-mode feature page gets updated commands + copy, FAQ gets de-staled. No new components, no redesigns.
- The `nohup gno daemon > /tmp/gno-daemon.log 2>&1 &` string at `~/work/gno.sh/src/lib/product-pages.ts:582` is the single most important fix — it's currently the recommended pattern on the public daemon-mode page.
- Verify the site builds with `bun run dev` locally before opening the gno.sh PR (Vite dev server on :3344).
- For the ADR, follow the same structure as `docs/adr/001-scholarly-dusk-design-system.md` or whichever 00X is most recent; keep it under 200 lines.
- Note in the gno repo PR description that a post-merge ClawHub skill republish is required.

## Investigation targets
**Required:**
- `~/work/gno.sh/src/lib/gno-docs.tsx:581-705` — CLI reference section
- `~/work/gno.sh/src/lib/product-pages.ts:566-592` — daemon-mode feature page (stale `nohup` example)
- `~/work/gno.sh/src/lib/product-pages.ts:663, 731-733` — FAQ entries mentioning daemon
- `~/work/gno/assets/skill/cli-reference.md` — serve + daemon flag tables
- `~/work/gno/docs/adr/000-template.md` — ADR format

**Optional:**
- `~/work/gno.sh/src/lib/gno-comparisons.tsx:92-94` — daemon comparison row
- `~/work/gno.sh/src/routes/install.tsx` — install page serve mentions
- Root `CLAUDE.md` ClawHub publish workflow section — exact steps for post-release skill bump

## Key context
- `~/work/gno.sh` is a separate git repo and will need its own PR.
- Coordinate merge order: land the gno CLI change first so gno.sh doesn't document flags that don't exist yet.
- `assets/skill/` changes trigger a ClawHub release. Do NOT publish to ClawHub from this task — that's a manual dashboard step post-merge.
- `~/work/gno.sh` uses Vite + TanStack Router; CLI docs are inline JSX (NOT markdown). Edit TSX directly.
## Approach
- **Website:** User was emphatic that website docs land with the feature. These three files are NOT auto-synced — they must be edited directly in `website/`. Verify with `bun run website:build` that the bento card, FAQ, and feature page all render correctly.
- **Skill:** Update `assets/skill/cli-reference.md` with the new flags so Claude/Codex/OpenClaw agents can reach for them. Per root `CLAUDE.md`, new flags the agent should know about require a ClawHub version bump. Add a line to the session-completion checklist / PR description noting the ClawHub republish is needed post-merge.
- **ADR:** Document the design decisions — why `resolveDirs().data` over `~/.gno/`, why JSON pid-file over bare PID, why exit code 3 for `NOT_RUNNING`, why `taskkill` fallback on Windows, why detach sentinel is a hidden internal flag.

## Investigation targets
**Required:**
- `website/features/daemon-mode.md` — full file (it's short)
- `website/_data/features.yml` — `daemon-mode` entry
- `website/_data/faq.yml` — daemon-related Q&As
- `assets/skill/cli-reference.md` — serve + daemon flag tables
- `docs/adr/000-template.md` — ADR format
- `docs/adr/004-*.md` — most recent ADR for style reference

**Optional:**
- Root `CLAUDE.md` ClawHub publish workflow section — exact steps for post-release skill bump

## Key context
- `website/_data/faq.yml` currently says daemon "in v0.30 stays in the foreground" — that claim becomes false.
- `assets/skill/` changes trigger a ClawHub release per root `CLAUDE.md` rules. Note the bump in CHANGELOG + release notes; do NOT publish to ClawHub from this task (manual dashboard step post-merge).
## Acceptance
- [ ] `~/work/gno.sh/src/lib/gno-docs.tsx` CLI reference lists all five new flags for both `gno serve` and `gno daemon`
- [ ] `~/work/gno.sh/src/lib/product-pages.ts` daemon-mode page: `nohup` command replaced, `--status`/`--stop` examples added
- [ ] `~/work/gno.sh/src/lib/product-pages.ts` FAQ entries no longer claim users must reach for nohup/launchd/systemd
- [ ] `bun run dev` in `~/work/gno.sh` renders the updated CLI reference and daemon-mode page without errors
- [ ] `~/work/gno/assets/skill/cli-reference.md` lists all five new flags
- [ ] `~/work/gno/docs/adr/005-daemon-detach-lifecycle.md` filed using `000-template.md`
- [ ] Separate PR opened on `~/work/gno.sh` repo
- [ ] Gno repo PR description notes a post-merge ClawHub skill republish is required
- [ ] Post-merge production deploy run from `~/work/gno.sh`: `DEPLOY_HOST=root@178.104.180.89 ./scripts/deploy-prod.sh`
- [ ] Deploy verified live: `curl https://gno.sh/docs` shows the new flags; daemon-mode page shows no stale `nohup` example
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
