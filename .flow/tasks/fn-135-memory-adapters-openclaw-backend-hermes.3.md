---
satisfies: [R2, R4, R5]
---
# fn-135-memory-adapters-openclaw-backend-hermes.3 OpenClaw search-backend (market-driven)

## Description
OpenClaw memory plugin (market-driven). **Size:** M-L. **Files/Touches:** NEW plugin artifact; sandbox verification script in ~/work/sandbox/openclaw-dogfood; docs region: docs/MEMORY.md "OpenClaw plugin" subsection only.
INTERFACE CORRECTION (plan review, verified): OpenClaw 2026.8.1 RETIRED `memory.backend`; external memory ships as a `kind: "memory"` plugin selected via `plugins.slots.memory` (their docs/tools/plugin.md; the old qmd backend was removed). Verify the current contract against those docs at execution start; do not assume this note is still current.
Corpus provisioning (binding, was undefined): plugin init registers the OpenClaw workspace memory paths as a GNO collection (explicit config: collection name + paths); writes OpenClaw makes to memory files reach the index via sync-before-search (plugin triggers gno update on the collection before serving a search, or watch mode when the daemon runs — pick one, document; deletion reconciliation via existing watcher semantics; runtime state dirs excluded).
SELLING-POINT CORRECTION: drop "semantic memory with no API key" (OpenClaw supports local GGUF via memory.search.provider: local). Honest differentiators: one index across every harness and format (memory files searched NEXT TO PDFs/mail/code), gno:// citations with hashes, the evidence layer, scoped recall.

**Touches:** integrations/openclaw-gno-memory/** (new), sandbox verification script in ~/work/sandbox/openclaw-dogfood, docs/MEMORY.md OpenClaw subsection (safe: runs after tasks 1-2 via dependency)

## Acceptance
- [ ] Current OpenClaw plugin contract re-verified at execution and recorded; plugin loads via plugins.slots.memory in the sandbox
- [ ] Canaries retrieved through OpenClaw memory search backed by GNO; a NEW memory file written after init is retrievable (provisioning/sync proven, not just pre-seeded index)
- [ ] Deletion/rename of a memory file reconciles; runtime state dirs excluded from the collection
- [ ] Failure modes (gno missing/below-min, subprocess timeout, malformed output) degrade cleanly with clear errors; sync/watch observability: plugin logs index-trigger outcomes and exposes a stale-index warning when sync fails (documented contract)
- [ ] Docs subsection with the honest differentiator list (no no-API-key claim)

- [ ] Deterministic unit suite green (faked subprocess cases); packaging README with install commands
- [ ] fn-134 gate evidence recorded at start

## Done summary
Built the OpenClaw memory plugin at `integrations/openclaw-gno-memory/`: a `kind: "memory"` plugin selected through `plugins.slots.memory` that registers `memory_search` / `memory_get` (plain JSON-schema tools), the memory capability with a "Memory Recall" prompt section, an `openclaw gno-memory <search|get|status|sync>` CLI namespace, and a `gno-memory-init` service. Every GNO call goes through one subprocess bridge (`src/gno-cli.ts`, `node:child_process` because the code runs inside OpenClaw's Node runtime) with a `1.41.0` version pin and stable error kinds; the plugin never writes a memory file. Corpus provisioning registers the workspace as a GNO collection with the brace pattern `{MEMORY.md,USER.md,memory/**/*.md}` (the pattern is the runtime-state guard); sync-before-search runs `gno index <collection> --no-embed` before every search (`syncBeforeSearch: false` when a daemon watches); every sync outcome is logged and a failed sync marks the index stale (`stale: true` + warning in the tool response, `STALE:` line in `status`). Failure modes (gno missing, below pin, timeout, malformed JSON) return `disabled: true` with the error kind; the CLI exits 1 with the same message. README with install commands, `docs/MEMORY.md` "OpenClaw plugin" subsection with the honest differentiators (no "no API key" claim), one CHANGELOG bullet under the fn-135 entry.

Contract re-verified at execution against the sandbox install (OpenClaw 2026.8.1: `docs/tools/plugin.md`, `docs/plugins/manifest.md`, `docs/cli/memory.md`, `dist/extensions/memory-core/index.js`, plugin-sdk `.d.ts`): `memory.backend` is gone and QMD removed; a memory plugin = manifest `kind: "memory"` + `plugins.slots.memory`; the plugin registers tools via `api.registerTool` (plain JSON-schema `parameters`, as memory-core does), `api.registerMemoryCapability({deterministicRecallToolName, promptBuilder})`, and its own root CLI via `api.registerCli` + manifest `cliCommands`. Correction to the task wording: `openclaw memory search` belongs to memory-core and is unavailable once the slot moves (memory-lancedb ships `ltm` the same way), so the CLI surface is `openclaw gno-memory search`. TypeScript entries load directly from `plugins.load.paths` / `--link` (Jiti); `openclaw plugins inspect gno-memory --runtime --json` reports `status: loaded`, `activationReason: "selected memory slot"`, both tools, the CLI command, and the service.

Live sandbox verification (isolated `~/work/sandbox/openclaw-dogfood/`, keyword path, no model auth needed; script `~/work/sandbox/openclaw-dogfood/verify-gno-memory.sh`, transcripts under `/tmp/fn-135.3-e2e/`): plugin loads via the slot; `sync` registered the collection and indexed 2 files; `amber-falcon-72` and `teal-heron-19` retrieved with `gno://` citations and hashes; a NEW file written after init was retrievable on the next search; rename moved the hit to the new URI; deletion dropped the hit and `gno ls` no longer lists it; only memory paths are indexed; `memory_get` returned the exact line. Isolation note (recorded in the script): the launcher's HOME override does not isolate `gno` (it honors the desktop's absolute `XDG_CONFIG_HOME`/`XDG_DATA_HOME`), so the script pins `GNO_CONFIG_DIR`/`GNO_DATA_DIR`/`GNO_CACHE_DIR` under the sandbox home. My first un-isolated run registered `openclaw-memory` in the operator's global GNO config and indexed the 2 canary files there; reverted (collection removed, the 2 docs deactivated via a no-match-pattern sync, collection removed again; `gno status` still lists the empty name from the inactive rows, 0 docs).

fn-134 gate evidence (R5): `bun run eval:memory` at task start -> Score 100%, Threshold 100% (passed), 19 evals, log `/tmp/fn-135.3-e2e/eval-memory-gate.log`.

Follow-ups outside this task's Touches (not edited, flagged): (1) GNO core: `src/ingestion/sync.ts` `decideAction` never checks `existing.active`, so a file deleted and restored at the same path with identical content stays inactive ("unchanged"); repro `/tmp/fn-135.3-e2e/11c-rename-back.json`, any content change reactivates (`11d`); documented as a known gap in README and MEMORY.md. (2) `gno status --json` keeps listing a removed collection's name while inactive rows remain. (3) `~/work/gno.sh` integrations page for the plugin (site follow-up per spec R4). (4) npm/ClawHub packaging (built `dist/` entry) is not part of this task; install is `openclaw plugins install --link` or `plugins.load.paths`.

baseline: green via handoff (verified at d93671f9 by fn-135.2 - full bun test 4718 pass); GATE_SKIPPED:unittest:green-receipt d93671f9 - baseline reused from prior post-gate pass; lint:check green with one pre-existing warning (test/cli/query-text.test.ts:26).
Post-edit: bun run lint green (same single pre-existing warning); bun test integrations/openclaw-gno-memory 23 pass; full bun test 4741 pass / 2 skip / 0 fail (receipt 182ca76b-unittest).

Staging note: committed with explicit paths (`git add integrations/openclaw-gno-memory CHANGELOG.md docs/MEMORY.md`) rather than `git add -A` because the checkout carries pre-existing untracked `.flow/artifacts/*` directories the conductor forbade touching (same as tasks .1 and .2).

stage: impl-review - skipped(config: REVIEW_MODE=none)
## Evidence
- Commits: 182ca76bcfb3d4dd468f45111b06cf801dc396b6
- Tests: GATE_SKIPPED:unittest:green-receipt d93671f9 - baseline reused from prior post-gate pass, bun run lint:check, bun run eval:memory (Score 100%, Threshold 100% passed, 19 evals; /tmp/fn-135.3-e2e/eval-memory-gate.log), bun test integrations/openclaw-gno-memory (23 pass, faked gno subprocess), bun test (4741 pass / 2 skip / 0 fail; receipt 182ca76b-unittest), ~/work/sandbox/openclaw-dogfood/verify-gno-memory.sh (PASS; transcript /tmp/fn-135.3-e2e/14-verify-script-transcript.txt, evidence /tmp/fn-135.3-e2e/verify-run/)
- PRs:
stage: plan-sync - skipped(config: planSync.enabled != true)
