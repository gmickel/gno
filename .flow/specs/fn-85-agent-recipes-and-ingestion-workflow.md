# Agent recipes and ingestion workflow playbooks

## Goal & Context
Ship reusable, agent-facing workflows that teach Codex/Claude/OpenCode users how to operate GNO as a second brain across capture, meeting notes, email context, source summaries, and brain-first lookup. Keep this as docs/skills/playbooks first; runtime integrations can follow later.

Inspiration: `garrytan/gbrain` cloned at `/tmp/gbrain`, especially `skills/RESOLVER.md`, meeting/email/calendar/X recipes, brain-first lookup, entity detection, and operational discipline docs. Use as inspiration only; do not copy code verbatim.

## Architecture & Data Models
Add a recipe layer to GNO’s existing skill assets:

- `assets/skill/recipes/brain-first-lookup.md`
- `assets/skill/recipes/capture-and-file.md`
- `assets/skill/recipes/meeting-ingestion.md`
- `assets/skill/recipes/email-context.md`
- `assets/skill/recipes/source-summary.md`
- `assets/skill/recipes/idea-capture.md`
- `assets/skill/recipes/citation-and-provenance.md`

Expose through installed skills and docs:

- Agent skill `SKILL.md` points to the recipes by task.
- `gno skill show` or docs list available recipes.
- Recipes use existing GNO commands first (`search`, `query`, `get`, `capture`, `index`) and only mention external tools/connectors as optional examples.

Core protocol:

1. Search GNO before web/API when local context may exist.
2. Capture new durable facts/ideas with provenance.
3. Use templates/types for people, companies, meetings, decisions, and source summaries.
4. Re-index after file writes when needed.
5. Prefer evidence and citations over unsupported synthesis.

## API Contracts
No new runtime API required initially. This spec is satisfied by docs/skill assets, with optional helper commands only if they naturally fall out of other specs.

Possible future command:

```bash
gno recipes list
gno recipes show meeting-ingestion
```

## Edge Cases & Constraints
- Recipes must not claim integrations exist before they do.
- Avoid prescribing one external email/calendar provider.
- Keep privacy boundaries explicit: GNO indexes local/exported files unless the user intentionally captures external data.
- Skill docs must remain concise enough for agent use.
- Avoid always-on entity capture instructions that imply GNO mutates automatically.

## Acceptance Criteria
- [ ] Agent skill assets include a recipe resolver or concise routing table.
- [ ] Recipes cover brain-first lookup, capture, idea capture, source summary, meeting ingestion, email-context workflow, and citation/provenance practice.
- [ ] Recipes reference actual GNO commands and clearly mark future/optional surfaces.
- [ ] `gno skill install --target codex` includes the recipe updates.
- [ ] Docs and hosted `gno.sh` include a second-brain workflows page.
- [ ] Autoresearch GNO skill eval is rerun and `assets/skill/SKILL.md` is updated if score regresses.

## Documentation Requirement
Every implementation task from this spec must update all relevant GNO documentation surfaces in the same change set: repo docs/specs, CLI/MCP/API references, skill assets where applicable, and the hosted website repo at `/Users/gordon/work/gno.sh`. Do not mark the spec or a user-facing task complete while hosted website docs remain stale.

## Boundaries
- No native Gmail/Calendar/Slack connectors in this spec.
- No background agent/minion runtime.
- No autonomous signal detector.

## Decision Context
The gbrain comparison showed that a lot of second-brain value lives in repeatable agent behavior, not just code. GNO can gain that value cheaply by shipping high-quality recipes that match its existing CLI/MCP surfaces.
