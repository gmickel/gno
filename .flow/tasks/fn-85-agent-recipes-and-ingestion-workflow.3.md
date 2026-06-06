---
satisfies: [R7, R10]
---

## Description

Update repo docs, skill docs, and legacy checked-in website surfaces so users can discover and use the new agent recipes. Hosted `gno.sh` docs are handled separately in task 5.

**Size:** M
**Files:** `README.md`, `docs/USE-CASES.md`, `docs/integrations/skills.md`, `docs/CLI.md` if skill show/install behavior changed, `docs/MCP.md` if needed to clarify recipes are agent-side guidance, `docs/GLOSSARY.md`, `CHANGELOG.md`, `website/features/agent-integration.md`, `website/_data/features.yml`, `website/_data/faq.yml`, `website/index.md`.

## Approach

- Explain recipes as installed skill playbooks for second-brain workflows, not runtime commands.
- Add or update a second-brain workflows section that covers local-first lookup, capture, meeting/email/source ingestion from supplied material, idea capture, and citation/provenance.
- Update legacy checked-in website surfaces only where they are still part of release/docs expectations.
- Avoid updating `spec/mcp.md` or MCP docs as if recipes are MCP tools/prompts unless a runtime MCP surface exists.
- Include a stale-surface pass for repo docs: remove or correct nonexistent commands, flags, targets, and integrations found while touching these docs.

## Investigation targets

**Required**

- `README.md:479-507` — current agent integration section.
- `docs/USE-CASES.md:66-96` — typed second-brain page guidance.
- `docs/USE-CASES.md:181-207` — meeting transcript and meeting preset guidance.
- `docs/USE-CASES.md:262-290` — AI agent integration section.
- `docs/integrations/skills.md:1-57` — current skills install/use docs.
- `docs/CLI.md:731-783` — skill command docs if task 1 changes show/install behavior.
- `docs/MCP.md:1-130` — MCP overview if a recipes-vs-MCP note is needed.

**Optional**

- `website/features/agent-integration.md` — legacy site feature copy.
- `website/_data/features.yml` and `website/_data/faq.yml` — legacy site cards/FAQ if still synced by release flow.
- `docs/GLOSSARY.md` — add `Agent recipe`, `Brain-first lookup`, or related terms if docs use them repeatedly.

## Key context

The first plan review found selected docs may already contain stale skill CLI/target claims. This task owns stale-surface correction for repo and legacy checked-in docs, while task 5 owns hosted `gno.sh` source.

## Acceptance

- [ ] README and repo docs explain agent recipes/playbooks in the agent integration and second-brain workflow areas.
- [ ] `docs/integrations/skills.md` explains that installed skills include recipe references and how to preview/reinstall them.
- [ ] CLI docs/specs mention nested recipe preview/install behavior only if task 1 changed that behavior.
- [ ] MCP docs do not imply recipes are MCP tools/prompts; if mentioned, they are clearly agent-side skill guidance.
- [ ] Legacy checked-in website surfaces are updated where applicable; stale paths like nonexistent `website/docs/integrations/skills.md` are not used.
- [ ] Updated repo/legacy docs avoid false native connector, cron, background-agent, and nonexistent command/flag/target claims.
- [ ] Docs note fn-83 page-type/preset behavior without implying fn-83 spec closure if it remains open.

## Done summary

Not started.

## Evidence

Not started.
