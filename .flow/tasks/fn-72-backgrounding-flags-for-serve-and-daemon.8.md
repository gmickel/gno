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

- `assets/skill/cli-reference.md` — serve section ~L492, daemon section ~L321. Add all five new flags. Triggers a ClawHub skill version bump at release time (per root `CLAUDE.md` rules). Document the `--json` gating rule (only `--status` accepts `--json`) and the silent `--stop` behavior (no stderr when no pid-file) so the agent doesn't try to parse stderr for a NOT_RUNNING envelope. <!-- Updated by plan-sync: fn-72.3 added --json gating + silent --stop; agents reading the skill reference need to know -->
- `docs/adr/005-daemon-detach-lifecycle.md` — new ADR using `docs/adr/000-template.md` as template. Document:
  - why `resolveDirs().data` over `~/.gno/`;
  - why JSON pid-file over bare PID (and why strict validation + version cross-check — not a bare integer);
  - why exit code 3;
  - why Windows has NO native detach (clean VALIDATION error pointing to WSL — `taskkill` was NOT ultimately implemented, fn-72.6 is blocked);
  - why the `DETACHED_CHILD_FLAG` sentinel (`--__detached-child`, exported from `src/cli/detach.ts`) is hidden from `--help`;
  - why a sidecar `.startlock` via O_CREAT|O_EXCL rather than a lock inside the pid-file;
  - why `stopProcess` returns a `StopOutcome` discriminated union (including `foreign-live`) rather than throwing for every non-success path;
  - why the child runs a bounded `verifyPidFileMatchesSelf` poll rather than the simpler "assert on first tick" originally sketched in the epic spec;
  - **why `--json` is gated to `--status` only** (rather than silently no-op'd on other branches): hard fail prevents users from thinking they'll get structured output on `--detach`/`--stop`, and keeps the format-matrix in `spec/cli.md` honest. <!-- Updated by plan-sync: fn-72.3 introduced the explicit gating; ADR should record the rationale -->
  - **why `--stop` is silent on no-process** (rather than emitting an error envelope): `--stop` is idempotent in spirit; scripts retrying it shouldn't have to grep stderr. Exit code 3 is the contract. <!-- Updated by plan-sync: fn-72.3 routes the not-running stop branch through CliError silent mode; ADR should record the rationale -->
  - **why `--status` exits 3 (NOT_RUNNING) when `running:false`** even though stdout carries a valid schema payload: separates "did the call succeed?" (yes, here's the state) from "is the process running?" (no, exit 3), so shell pipelines can branch on `$?` without re-parsing JSON. <!-- Updated by plan-sync: fn-72.3 throws NOT_RUNNING after writing stdout; ADR should record the rationale -->
  - **why foreign-live metadata rides on `CliError.details`** (not a parallel stderr write in JSON mode): keeps JSON-mode stderr a single parseable envelope. <!-- Updated by plan-sync: fn-72.3 chose the single-envelope shape -->
  - **why `installPidFileCleanup` uses sync `unlinkSync` on SIGINT/SIGTERM/beforeExit** (rather than extending `createSignalPromise`): the serve runtime doesn't already own a signal-handling primitive in the same shape; a one-shot sync handler is the smallest change that survives crashes in subsequent async teardown. Daemon ended up stacking BOTH — its existing `createSignalPromise` (in `src/cli/commands/daemon.ts:34-64`) handles the orderly shutdown message, and `installPidFileCleanup` is layered on top in `program.ts` (`handleDaemonAction` detached-child branch) for the sync unlink. Document the stacking explicitly so a future refactor doesn't collapse them. <!-- Updated by plan-sync: fn-72.4 stacked installPidFileCleanup on top of the existing createSignalPromise rather than replacing or extending it; ADR should record the actual decision, not the spec's "may diverge" hedge -->
  - **why `stripDetachFlag` removes only the literal `--detach`** (not short forms or other variants): the only registered flag is the long form; documenting this prevents future contributors from over-engineering the strip. <!-- Updated by plan-sync: fn-72.3 added a deliberately minimal stripDetachFlag -->
  - **why detach-child argv is sourced from `Command.rawArgs` via `resolveCliArgv(cmd)`** (rather than `process.argv.slice(2)`): the original implementation read from the process-global `process.argv`, which meant programmatic callers — `runCli(["node", "gno", "daemon", "--detach", ...])` from tests or embedded callers — would re-exec the host process's argv (e.g. `bun test ...`) instead of the requested invocation. `resolveCliArgv` walks up to the root Commander Command and reads `rawArgs.slice(2)`, which is per-`parseAsync()`-call state. Back-to-back `runCli([...])` invocations in the same process can no longer taint each other's child argv. Regression tests live in `test/cli/detach-argv.test.ts`. <!-- Updated by plan-sync: fn-72.4 introduced resolveCliArgv to fix a process-state-taint bug in both serve and daemon detach paths; ADR should record the rationale -->
  <!-- Updated by plan-sync: fn-72.2 shipped start-lock, StopOutcome union, verifyPidFileMatchesSelf, strict pid-file validation, and retired native Windows detach; fn-72.3 added --json gating, silent --stop, status-exits-3, single-envelope foreign-live, sync unlinkSync cleanup, and stripDetachFlag; fn-72.4 added resolveCliArgv (per-invocation argv source) and confirmed daemon stacks installPidFileCleanup on top of its existing createSignalPromise — the ADR should cover all of these decisions -->

Note: the `~/.gno` convention documented elsewhere is irrelevant here; defaults come from `resolveDirs().data` and honour `GNO_DATA_DIR`.

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
- [ ] `~/work/gno/assets/skill/cli-reference.md` lists all five new flags AND documents `--json`-gated-to-`--status` + silent `--stop` <!-- Updated by plan-sync: fn-72.3 added gating + silent behaviors that agents need to know about -->
- [ ] `~/work/gno/docs/adr/005-daemon-detach-lifecycle.md` filed using `000-template.md`, covering all decisions enumerated above (including fn-72.3-introduced ones: --json gating, silent --stop, status-exits-3, single-envelope foreign-live, sync unlinkSync cleanup, stripDetachFlag minimalism; and fn-72.4-introduced ones: resolveCliArgv per-invocation argv source, daemon stacking installPidFileCleanup on top of createSignalPromise) <!-- Updated by plan-sync: fn-72.3 + fn-72.4 added several design decisions worth recording in the ADR -->
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
