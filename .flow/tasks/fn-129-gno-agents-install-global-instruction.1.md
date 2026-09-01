---
satisfies: [R1, R2, R3, R4, R5, R6]
---
# fn-129-gno-agents-install-global-instruction.1 Implement gno agents install — global instruction-block installer for harness files

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Shipped `gno agents install|update|verify|uninstall`: a marker-managed, versioned GNO protocol block installer for the global (user-scope) instruction files of every detected harness (claude, codex, cursor, opencode, hermes, openclaw; grok reported "covered via claude" through a data-driven import chain). Backup-first, idempotent, symlink-aware (write-through + same-realfile dedupe), fail-closed marker validation, --dry-run unified diffs, repeatable --extra-dir, --json everywhere; block body ~1.14 KB with version + hash stamp and a state-aware skill pointer. Docs: spec/cli.md, docs/CLI.md, new docs/AGENT-INSTRUCTIONS.md (harness matrix with deployment evidence), CHANGELOG.

Notes:
- baseline: green (bun test 4434 pass, lint clean, pre-edit)
- Live verification (R1-R4) ran the real CLI end-to-end against an isolated home via GNO_AGENTS_HOME_OVERRIDE with fabricated harness dirs and a symlinked canonical file — not against the operator's real global files, which carry a hand-managed protocol block and would have been a live mutation of operator config. The override also suppresses harness env redirects (CLAUDE_CONFIG_DIR/CODEX_HOME) for isolation.
- Implemented in-host rather than via the cursor-grok bridge pin: dispatched as a timeboxed flow-next worker with conductor-owned host review; bridging an 11-file feature through a fire-and-forget bridge inside the timebox would have forfeited marker-safety control. Reporting per routing-policy fallback clause.
- Follow-up (not built, per YAGNI): fn-130 memory-loop rungs arrive via block version bump; fn-133 site reference.

stage: impl-review - skipped(config: REVIEW_MODE=none)
## Evidence
- Commits: 4da7b1be150d6a4f05d5e2366321762535e862e2
- Tests: bun test (full suite: 4457 pass / 0 fail, suite_rc=0), bun test test/cli/agents.test.ts (23 pass), bun run lint:check (0 warnings, 0 errors), live sandboxed CLI verification under GNO_AGENTS_HOME_OVERRIDE: install --target all + --extra-dir, idempotent re-run, dry-run diff writes nothing, update outdated->ok with exit codes, malformed-marker fail-closed, symlink write-through, uninstall byte-identical restore, backups created
- PRs: