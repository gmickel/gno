# fn-68-collection-special-docs-and-canonical Collection special docs and canonical paths

## Overview

Some collection-oriented workflows have a few canonical documents:

- a home/MOC/index note
- a log/timeline note
- maybe an inbox, outputs page, or source index

Today GNO treats these as ordinary files. This epic adds a generic collection
metadata layer for "special docs" so the product can surface them in UI, CLI,
API, MCP, and agent workflows without forcing one specific wiki pattern.

## Scope

Included:

- config shape for per-collection special docs / canonical paths
- optional auto-detection defaults for common names such as `_index.md` and `log.md`
- collection metadata surfaces that expose these docs
- Web UI affordances for opening/highlighting them from collection views
- agent/API/CLI access patterns for the same metadata

Excluded:

- opinionated `raw/`, `wiki/`, `outputs/` folder semantics
- hardcoded Karpathy wiki workflow
- automatic wiki compilation or linting
- forcing `_index.md` / `log.md` as required names
- moving/renaming docs automatically

## Approach

### Product stance

- this should be a flexible metadata layer, not a rigid wiki-mode product
- users may choose `_index.md`, `MOC.md`, `overview.md`, `log.md`, or nothing
- defaults can help discovery, but explicit config must win
- UI should surface special docs as shortcuts, not as a second navigation system

### Proposed config shape

Likely under each collection:

```yaml
collections:
  - name: ai
    path: /Users/you/Vault/Spaces/AI
    specialDocs:
      home: "_index.md"
      log: "log.md"
      inbox: "inbox.md"
```

### Detection model

Support:

- explicit config
- lightweight suggested autodetect for common names when config is absent

Examples of suggested defaults:

- `home`: `_index.md`, `index.md`, `MOC.md`
- `log`: `log.md`

Autodetection should be advisory. Do not silently mutate config just because a
matching filename exists.

### Surfaces

- Web UI collections page:
  - show quick-open links/buttons for configured special docs
  - if autodetected but not configured, maybe a subtle suggestion
- API / SDK / MCP:
  - return special-doc metadata with collection info
  - allow agents to ask "what is the home note / log note for this collection?"
- CLI:
  - likely read-only discovery first, not full mutation

### Design guidance

Any UI work should follow:

- `docs/adr/001-scholarly-dusk-design-system.md`

The feature should feel like a natural extension of collection management, not a
generic settings dump or a second MOC browser.

## Quick commands

- `bun run lint:check`
- `bun test`
- `bun run docs:verify`

## Acceptance

- [ ] Collections can declare special/canonical docs without forcing one workflow.
- [ ] Explicit config and auto-detected suggestions have clear precedence.
- [ ] Web UI can surface configured special docs from the collections view.
- [ ] API/agent surfaces can discover the same metadata.
- [ ] The design remains generic enough for varied user workflows, not just one wiki pattern.

## References

- `/Users/gordon/Documents/GordonsVault/AGENTS.md`
- `/Users/gordon/Documents/GordonsVault/Spaces/*/_index.md`
- `docs/adr/001-scholarly-dusk-design-system.md`
- `src/config/types.ts`
- `src/serve/public/pages/Collections.tsx`
- `src/serve/routes/api.ts`
