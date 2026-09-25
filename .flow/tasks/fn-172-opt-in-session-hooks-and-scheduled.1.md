---
satisfies: [R1, R2, R3, R4, R5, R6, R7]
---
# fn-172-opt-in-session-hooks-and-scheduled.1 Implement Opt-in session hooks and scheduled ingestion

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Opt-in session automation on top of the fn-171 importer: owner profiles in `sessions.automation`, a Claude Code SessionEnd hook with one owned settings entry (live-verified on Claude Code 2.1.280 in `claude -p`), daemon-only elapsed-cadence schedules, a durable generation-safe pending marker per profile in `<archiveRoot>/.gno-sessions/automation.json`, run-now through the manual importer, and status/run surfaces on CLI, MCP, REST, SDK and the Web UI Automation panel, with repo docs, specs, schemas, skill and the gno.sh mirror.

Tier: session (jev intelligent)

stage: impl-review - failed(ESCALATE: stall guard refused round 4 after 3 verdict rounds; last verdict NEEDS_WORK on the remove-during-run lineage, fixed in def0545c but not re-reviewed)

Review rounds: round 1 fan-out (3 codex draws, 6 merged findings) fixed in d6c78bc1; round 2 residual (removed profile hid a running import) fixed in 545bffc1; round 3 residual (check outside the marker lock) fixed in def0545c with a deterministic interleaving test.

Gates on def0545c: bun test 5608 pass / 0 fail; lint:check 0 (34 pre-existing warnings, same as baseline); docs:verify pass; eval:memory 100% (19); eval:sessions 100% (35); skill autoresearch eval 47/47 new and baseline (no automation cases in that eval).

Live evidence: hook foreground 66-71 ms; `claude -p --settings <temp>` fired SessionEnd once (payload keys cwd, hook_event_name, prompt_id, reason, session_id, transcript_path; reason other), admitted one pending generation, archived nothing until the run; real settings checksum unchanged. Daemon smoke: startup drain imported hook work; a real 1m schedule tick (trigger schedule) imported a newly added session; after stop, status shows not running: no daemon. Web UI driven by keyboard at 1380 and 375 px.

gno.sh: worktree ~/work/gno.sh-fn172, branch fn-172-session-automation (from origin/fn-171-session-ingestion, upstream unset), commits bf3a321 and 58ae355; check/typecheck/build/tests exit 0; 23 pages driven at desktop and 375 px; HTML, Markdown twins and llms files agree. Not pushed or deployed.

Follow-ups (not built): per-index resident owner lock (today an archive daemon needs its own GNO_DATA_DIR beside a curated serve/daemon); session-automation cases in the skill autoresearch eval; interactive `/exit` SessionEnd firing unverified.

stage: impl-review - ran [codex:gpt-6-astra:medium rounds 1-3 NEEDS_WORK (all findings fixed), stall guard; conductor standalone review of def0545c: SHIP]
## Evidence
- Commits: dec57a5408530bf49b2c61f7f71c085e9bd001d0, d6c78bc18c597e13bb9b6f80dddbf8ace7f97d56, 545bffc15d6930f424a451f82d3b7d4d59dbe035, def0545cbdce610f469a3bb59475f4e1d9476f84
- Tests: mise exec bun@1.4.2 -- bun test (5608 pass, 0 fail), mise exec bun@1.4.2 -- bun run lint:check, mise exec bun@1.4.2 -- bun run docs:verify, mise exec bun@1.4.2 -- bun run eval:memory (100%, 19), mise exec bun@1.4.2 -- bun run eval:sessions (100%, 35), mise exec bun@1.4.2 -- bun test test/sessions/automation.test.ts (36 pass), live: claude -p --settings <temp> SessionEnd hook against isolated GNO instance (Claude Code 2.1.280), live: gno daemon startup drain + 1m schedule tick smoke (isolated temp roots), live: Web UI /sessions Automation panel driven with agent-browser (keyboard, 1380px and 375px), skill autoresearch eval on scratch copies: 47/47 new, 47/47 base, baseline: green (bun test, lint:check, docs:verify pre-edit), focused impl-review codex:gpt-6-astra:medium (standalone, base 545bffc1, conductor-run after stall guard): SHIP; no findings
- PRs: