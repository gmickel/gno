# fn-67-evaluate-qwen3-embedding-06b-gguf-for.3 Design clean reindex semantics for global embedding model changes

## Description
Figure out the clean operator flow when the active global embedding model changes.

Start here:

- `src/cli/commands/models/use.ts`
- `src/cli/commands/embed.ts`
- `src/store/vector/stats.ts`
- `src/store/sqlite/adapter.ts`
- `src/serve/context.ts`
- `src/serve/routes/api.ts`
- `docs/CONFIGURATION.md`
- `docs/WEB-UI.md`

Current tension:

- vector backlog code is model-aware
- top-level status/backlog reporting is not fully model-aware
- switching active preset can change query embedding behavior immediately
- existing collections may still only have vectors for the old embed model

This task must produce a concrete answer for:

- what should happen right after `models.activePreset.embed` changes?
- how should CLI/web/API signal that the active embed model changed and embeddings need to catch up?
- is plain `gno embed` enough, or do we need a more explicit reindex/re-embed action?
- should old-model vectors remain until explicit cleanup?
- what should status pages count as “embedded” after a model switch?

Likely recommendation to evaluate:

- keep old vectors; do not destructively rewrite on preset switch
- immediately treat missing vectors for the new active embed model as backlog everywhere
- make status/backlog reporting model-aware
- surface a clear note/banner after preset change until new embeddings are ready
- leave old-vector garbage collection as a separate explicit cleanup concern

Deliverable:

- concrete design written into this task and/or a small ADR/follow-up note
- if the clean path is obvious and small, spec the code surfaces needed too

Docs/website:

- `docs/CONFIGURATION.md`
- `docs/CLI.md`
- `docs/WEB-UI.md`
- `docs/API.md`
- `docs/TROUBLESHOOTING.md`

Non-goal:

- do not silently change default models in this task

## Acceptance
- [ ] The repo has an explicit recommended behavior for active global embed-model changes.
- [ ] The recommendation covers CLI, API, and web UI status/recovery flow.
- [ ] The design states whether plain `gno embed` is sufficient or whether another action is needed.
- [ ] The design states what happens to old-model vectors.
- [ ] Documentation targets for the chosen flow are identified.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
