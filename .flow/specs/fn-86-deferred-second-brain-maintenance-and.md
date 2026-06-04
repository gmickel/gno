# Deferred second-brain maintenance and dream cycle

## Goal & Context

Capture the autonomous “dream cycle” idea as a deferred roadmap spec. The near-term GNO shape should be explicit `gno audit` / `gno maintain` commands that report and optionally prepare safe fixes, not always-on autonomous mutation.

Inspiration: `garrytan/gbrain` cloned at `/tmp/gbrain`, especially dream-cycle, contradiction probes, stale/citation checks, queue health, and operational discipline docs. Use as inspiration only; do not copy code verbatim.

This spec is intentionally deferred. Build capture, provenance, templates, typed graph, and recipes first.

## Architecture & Data Models

Phase 1: explicit read-only audits.

```bash
gno audit citations
gno audit stale
gno audit links
gno audit contradictions --query-fixture evals/fixtures/...
gno audit health --json
```

Audit targets:

- Missing provenance/source metadata on factual pages.
- Stale pages by type/category/date/source.
- Broken wiki links/backlinks/orphaned graph nodes.
- Retrieval contradictions or temporal conflicts surfaced as review candidates.
- Embedding/index freshness and daemon health.

Phase 2: explicit maintenance with dry-run/apply.

```bash
gno maintain links --dry-run
gno maintain citations --dry-run
gno maintain stale-summaries --dry-run
gno maintain all --dry-run --json
gno maintain links --apply
```

Maintenance must use preview/apply semantics and never silently rewrite user notes. Any LLM-written synthesis must be written as a draft, patch, or explicitly approved replacement.

Phase 3: optional scheduled maintenance.

- Reuse existing daemon/background work where possible.
- Default schedule is off.
- If enabled, run read-only audits by default.
- Mutating jobs require explicit config and per-operation safeguards.

## API Contracts

- CLI first: `audit` and `maintain` command groups.
- REST/API may expose read-only audit reports for Web UI health panels.
- MCP read-only audit tools can be available by default.
- MCP maintenance/apply tools require existing write gate plus explicit command options.

## Edge Cases & Constraints

- Do not call this autonomous by default.
- Do not create an always-on signal detector in this spec.
- Do not overwrite compiled synthesis without user approval.
- Contradiction detection must distinguish stale-but-valid temporal evolution from true conflict.
- LLM-as-judge paths need cost caps and graceful skip without API keys.
- Audits must be useful on local-only/offline installs.

## Acceptance Criteria

- [ ] Deferred status is clear in Flow, docs, and any task breakdown.
- [ ] `gno audit` read-only command group is specified before any mutating maintenance work.
- [ ] `gno maintain` requires dry-run/apply semantics and safe previews.
- [ ] Citation, stale, link, contradiction, and freshness audit categories are defined.
- [ ] Web UI/MCP exposure is scoped by read/write gates.
- [ ] Docs explicitly say always-on autonomous mutation is out of scope until the explicit commands prove useful.

## Documentation Requirement

Every implementation task from this spec must update all relevant GNO documentation surfaces in the same change set: repo docs/specs, CLI/MCP/API references, skill assets where applicable, and the hosted website repo at `/Users/gordon/work/gno.sh`. Do not mark the spec or a user-facing task complete while hosted website docs remain stale.

## Boundaries

- Deferred until capture/provenance/templates/typed graph exist.
- No durable subagent queue/minion system.
- No external enrichment pipeline.
- No hidden overnight note mutation.

## Decision Context

The dream-cycle concept is good, but GNO’s product fit is local-first trust and explicit user control. The safe path is to build observable audits and opt-in maintenance first, then revisit automation once users trust the reports.
