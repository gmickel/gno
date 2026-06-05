# fn-88-fix-evalite-eval-runner-ergonomics.1 Make Evalite opt-in and deterministic

## Description

Make the Evalite runner safe to use on demand without making releases depend on it. The current known failures are: Evalite discovers duplicate suites under `.claude/worktrees/**`; ask-mode generation can fail local hardware with node-llama-cpp VRAM/context errors; and a focused ask eval produced zero-citation answers.

## Acceptance

- [ ] Standard release docs/checklists do not require `bun run eval`.
- [ ] Evalite commands run only canonical repo eval files, not `.claude/worktrees/**` duplicates.
- [ ] Ask eval either passes with citation-bearing answers on supported hardware or skips with clear resource diagnostics.
- [ ] Runner behavior and hardware expectations are documented for explicit opt-in use.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
