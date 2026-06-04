# Workspace-native note creation and open-or-create flows

## Closure Note
This spec is closed as superseded, not as fully completed according to its original broad April plan.

Current code already contains the baseline this spec was trying to create:
- shared note path/collision resolver in `src/core/note-creation.ts`
- API create flow in `src/serve/routes/api.ts` (`POST /api/docs`)
- SDK create flow in `src/sdk/client.ts` (`client.createNote`)
- MCP write/create flow in `src/mcp/tools/capture.ts` (`gno_capture`)
- Browse and command-palette create-note entry points in the Web UI

Remaining gaps that still matter for second-brain capture are moved into `fn-82-second-brain-capture-and-provenance.1`:
- harden resolver behavior for capture defaults
- include disk-only collision checks, not only indexed relPaths
- align `open_existing` parity across capture surfaces
- keep raw note creation distinct from capture-with-provenance
- update stale docs/spec/schema surfaces as part of `fn-82`

## Original Intent Preserved
The useful parts of this spec are now baseline assumptions for `fn-82`: humans and agents should use one shared path/collision contract rather than UI-only creation rules.
