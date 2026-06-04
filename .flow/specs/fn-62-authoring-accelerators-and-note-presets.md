# Authoring accelerators and note presets

## Closure Note

This spec is closed as superseded, not as fully completed according to its original broad April plan.

Current code already contains the baseline this spec was trying to create:

- shared preset model and resolver in `src/core/note-presets.ts`
- first-pass presets: blank, project, research, decision, prompt/pattern, source-summary
- preset application in Web quick capture
- preset actions in quick switcher
- editor insert preset behavior in `src/serve/public/pages/DocumentEditor.tsx`
- API preset listing via `/api/note-presets`
- API/SDK/MCP create paths accepting `presetId`

Remaining gaps that still matter for second-brain capture are moved into `fn-82-second-brain-capture-and-provenance.1`:

- structured/nested frontmatter support for canonical `source:` provenance
- content/preset validation matrix across CLI, REST, SDK, MCP, and Web UI
- frontmatter merge preserving existing unknown fields and body
- docs/spec/schema parity across repo docs, skill assets, and hosted `/Users/gordon/work/gno.sh`

## Original Intent Preserved

The useful parts of this spec are now baseline assumptions for `fn-82`: presets are shared product data and must remain consistent across all capture/create surfaces.
