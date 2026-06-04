# Second-brain capture and provenance foundation

## Overview
Make GNO a real second-brain input surface, not only a retrieval layer. Add one obvious capture path across CLI, Web UI, MCP, REST/API, and SDK, with durable provenance metadata so later answers can explain where a claim came from.

Inspiration: `garrytan/gbrain`, cloned at `/tmp/gbrain`, especially its human-facing `capture` verb, stable inbox slugs, JSON/quiet receipts, and source-attribution operating model. Use it as product/UX inspiration only; do not copy code verbatim.

## Scope
- Add a new `gno capture` CLI surface.
- Upgrade existing `gno_capture` MCP behavior in place rather than versioning a second MCP write tool.
- Add/settle REST and SDK capture contracts while preserving existing `POST /api/docs` and `client.createNote()` as lower-level note creation surfaces.
- Extend the Web UI quick capture flow to use the same capture semantics and expose provenance without making simple capture heavier.
- Define one provenance schema and one capture receipt contract shared across surfaces.
- Build one shared capture facade/planner; adapters stay thin and own only transport-specific parsing, auth/gating, lock context, and sync strategy.

## Dependency Posture
- `fn-59-workspace-native-note-creation-and-open-or-create` is closed as superseded by the current implementation baseline plus `fn-82.1` hardening work. `fn-82` no longer depends on it as an open Flow spec.
- `fn-62-authoring-accelerators-and-note-presets` is closed as superseded by the current implementation baseline plus `fn-82.1` hardening work. `fn-82` no longer depends on it as an open Flow spec.
- `fn-82.1` owns the remaining note-creation and preset contract work needed for capture: disk-only collision checks, `open_existing` parity, structured `source:` frontmatter, content/preset validation, and docs/schema parity.
- Coordination only: `fn-63-workspace-native-commands-and-agent-callable-actions` if the Web UI capture entry point is also registered in the command/action registry during this work.
- Downstream: `fn-83`, `fn-85`, and deferred `fn-86` should build on this capture/provenance foundation.

## Approach
Implement contract and core facade first, then thin adapters.

Existing reuse points:
- CLI command wiring follows `src/cli/program.ts:217` and related `wire*Command()` groups.
- Note path/collision planning comes from `src/core/note-creation.ts:14` and `src/core/note-creation.ts:68`.
- Preset/frontmatter scaffolding comes from `src/core/note-presets.ts:74` and `src/core/note-presets.ts:141`.
- Editable-copy provenance seed lives in `src/core/document-capabilities.ts:88`.
- API note creation flow lives in `src/serve/routes/api.ts:2803`; editable-copy delegation lives in `src/serve/routes/api.ts:2676`.
- SDK note creation lives in `src/sdk/client.ts:722` and `src/sdk/types.ts:113`.
- MCP capture already exists in `src/mcp/tools/capture.ts:115`; write registration/gating lives in `src/mcp/tools/index.ts:887` and `src/mcp/server.ts:149`.
- API jobs and MCP jobs stay intentionally separate: `src/serve/jobs.ts:45` vs `src/core/job-manager.ts:71`.

Shared core responsibilities:
- validate text safety, size limits, NUL rejection, source fields, tags, content/preset combinations, and collision policy
- normalize body content for hash/dedupe while preserving stored content bytes where practical
- derive default path using UTC `capturedAt` date and injectable clock in tests
- combine indexed document paths and filesystem existence before deciding collision outcomes
- assemble content with presets, tags, existing frontmatter, and canonical `source:` provenance
- parse/serialize/merge structured frontmatter, preserving unknown fields and body
- build capture receipts and status enums, including legacy MCP compatibility fields where needed
- expose a capture facade/planner that adapters can call with their own config/store/sync/lock strategy

Terminology:
- capture write: file write to an editable collection
- sync / FTS ingestion: update file metadata/content search index
- embed / vector indexing: embedding generation for semantic/vector retrieval
- index command: existing full sync + embed operation where applicable

## API Contracts
CLI examples:

```bash
gno capture "thought to remember"
gno capture --stdin --collection notes --preset source-summary --tags inbox,gno
gno capture --file ./clip.md --source-url https://example.com --source-kind web --source-date 2026-06-04 --json
gno capture --file ./clip.md --collision-policy create_with_suffix --quiet
```

Content validation matrix:
- Inline argument, `--stdin`, and `--file` are mutually exclusive content sources.
- A content source is required unless `presetId` is present and the preset can produce non-empty scaffold content.
- Empty/whitespace body without a scaffold-capable preset is rejected across CLI, MCP, REST, SDK, and Web UI.
- Preset plus content is allowed; preset scaffolding wraps/augments the supplied body through shared core.
- Title alone is metadata, not content, unless paired with a scaffold-capable preset.

CLI precedence:
- `--json` wins over `--quiet`; quiet prints only the created/opened `uri` on success.
- `--collision-policy <error|open_existing|create_with_suffix>` selects collision behavior.
- `--source-date` maps to `source.observedAt` and must parse as an ISO-like date/time.
- `--source-id` maps to `source.externalId`.
- URL fields validate before write.
- `--file` accepts text/markdown-like content only in this spec; binary and suspicious NUL-byte payloads are rejected in shared core.
- `--collection` must resolve to an editable configured collection.
- Explicit `--path` wins. Otherwise `--folder`/`--title` and default inbox policy produce a safe relative path through the shared planner.

Shared provenance shape:

```yaml
source:
  kind: direct|web|email|meeting|chat|file|api|unknown
  title: "..."
  url: "..."
  uri: "..."
  docid: "..."
  mime: "..."
  ext: ".pdf"
  author: "..."
  observedAt: "2026-06-04T00:00:00.000Z"
  capturedAt: "2026-06-04T00:00:00.000Z"
  externalId: "..."
```

Compatibility:
- Existing editable-copy fields `gno_source_docid`, `gno_source_uri`, `gno_source_mime`, and `gno_source_ext` map to `source.docid`, `source.uri`, `source.mime`, and `source.ext`.
- This spec may keep writing flat compatibility keys during migration, but there must be one internal source model.

Collision and overwrite behavior:
- Core capture policies are `error`, `open_existing`, and `create_with_suffix`.
- Default policy is `open_existing` only for generated hash-path captures; explicit `--path` defaults to `error` unless a collision policy is provided.
- Same body + same UTC date + generated path defaults to opening existing and returning `openedExisting: true` without modifying existing provenance.
- Same body + different provenance follows the same collision policy; provenance is never overwritten by default.
- Existing MCP `overwrite` is not an alias for `collisionPolicy`. It is a legacy core-owned compatibility mode that must set `collisionPolicyResult: overwritten` and `overwritten: true`, or be rejected globally if implementation chooses a breaking removal.
- Adapters must not bypass shared core to implement overwrite.
- Collision checks consider indexed documents and disk-only files.

Shared receipt fields:
- `uri`
- `docid` when available; optional until sync completes except where legacy MCP compatibility can still provide it
- `collection`
- `relPath`
- `absPath` where local surface already returns it
- `created`
- `openedExisting`
- `createdWithSuffix`
- `overwritten` for legacy/compatibility receipts
- `contentHash`
- `source`
- `tags`
- `sync.status`: `not_requested|pending|running|completed|skipped|failed|unknown`
- `sync.jobId`, `sync.reason`, `sync.error` when applicable
- `embed.status`: `not_requested|pending|running|completed|skipped|failed|unknown`
- `embed.jobId`, `embed.reason`, `embed.error` when applicable
- `collisionPolicyResult`: `created|opened_existing|created_with_suffix|overwritten|conflict`
- MCP compatibility fields `docid`, `absPath`, `overwritten`, and `serverInstanceId` remain documented/tested for in-place upgrade compatibility where the current MCP schema requires them.

MCP:
- Upgrade `gno_capture` in place.
- Register only when write tools are enabled; direct handler still rejects if reached while disabled.
- Input mirrors the shared contract with conservative field/size limits.
- Output uses structured content/JSON-compatible receipt plus concise human text.

REST/API:
- Add `POST /api/capture` or an explicitly documented capture-compatible route that delegates into the shared core.
- Wire both the primary server route and fallback API router if both remain supported.
- Keep `POST /api/docs` as raw note creation; docs must distinguish raw creation from capture-with-provenance and editable-copy-from-converted-doc.
- Existing CSRF/token behavior applies.

SDK:
- Add `client.capture(input)` unless implementation proves `createNote()` can expose capture semantics without muddying the lower-level method.
- Return the shared receipt shape.

Web UI:
- Quick capture remains lightweight.
- Provenance fields are available without blocking basic text capture.
- Success UI communicates whether the note is written, sync/FTS-ingested, and embedded/pending/skipped/failed, including no-job and sync-busy cases.

## Quick Commands
```bash
bun run lint:check
bun test
bun run docs:verify
bun run website:sync-docs
```

## Test Notes
- Unit tests for source validation, structured frontmatter serialization/merge, body hash normalization, content/preset validation matrix, binary/NUL/size rejection, UTC clock/default path generation, and disk-only collisions.
- Contract tests for receipt JSON schemas, MCP compatibility fields, collision result values, and status enum vocabulary.
- CLI tests for inline/stdin/file precedence, `--collision-policy`, source flag mappings, JSON/quiet output, binary rejection, path safety, and collision behavior.
- MCP tests for write-gate behavior, schema/result parity, legacy `overwrite` behavior or rejection, `open_existing`, and no-auto-embed receipt wording.
- API/SDK tests for shared receipt shape, async sync status, fallback route wiring, and failed/deferred indexing.
- Web UI tests for provenance inputs, success state, no job id, sync busy/deferred/failed, and no-overlap with existing quick capture.
- Cross-surface golden test: same logical input through CLI/API/MCP/SDK yields the same frontmatter/body and receipt fields except expected transport metadata.

## Documentation Requirement
Every implementation task from this spec must update relevant GNO documentation surfaces in the same change set. Task 1 owns canonical schema/docs snippets; surface tasks update only their surface docs/examples; task 6 performs the final parity sweep.

Required surfaces include repo docs/specs, CLI/MCP/API/SDK/Web UI references, skill assets where applicable, and the hosted website repo at `/Users/gordon/work/gno.sh`. If `/Users/gordon/work/gno.sh` is unavailable during implementation, record that as a blocker and do not mark a user-facing task complete with stale hosted docs.

Minimum docs surfaces:
- `README.md`
- `spec/cli.md`
- `spec/mcp.md`
- `spec/output-schemas/*`
- `docs/CLI.md`
- `docs/API.md`
- `docs/MCP.md`
- `docs/SDK.md`
- `docs/WEB-UI.md`
- `docs/QUICKSTART.md`
- `docs/USE-CASES.md` if second-brain narrative changes
- `assets/skill/SKILL.md`
- `assets/skill/cli-reference.md`
- `assets/skill/mcp-reference.md`
- `assets/skill/examples.md`
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`
- `/Users/gordon/work/gno.sh/src/lib/product-pages.ts`, `/Users/gordon/work/gno.sh/src/lib/site-content.ts`, and `/Users/gordon/work/gno.sh/src/routes/index.tsx` if product positioning changes

## Acceptance Criteria
- **R1:** `gno capture` supports inline, stdin, file, and scaffold-capable preset input modes, with JSON and quiet outputs.
- **R2:** Captured content lands in an editable collection using shared note creation/path safety and collision behavior.
- **R3:** Default generated captures use a deterministic UTC inbox path with a stable body-normalized content hash suffix unless explicit path/folder/title inputs override it.
- **R4:** Provenance frontmatter is written, schema-validated, merged safely with existing structured frontmatter, and returned in receipts.
- **R5:** Existing editable-copy `gno_source_*` provenance maps into the same internal source model or is migrated behind a compatibility layer so two competing provenance systems do not exist.
- **R6:** MCP, REST/API, SDK, CLI, and Web UI capture surfaces share one core capture facade and one receipt contract, with only transport-specific metadata and documented compatibility fields differing.
- **R7:** Receipts distinguish capture write success, sync/FTS-ingestion state, and embed/vector-indexing state; capture never implies embedding unless the receipt says embedding completed.
- **R8:** MCP write gates, server-side write locks, dangerous-path protections, filesystem-vs-indexed collision behavior, text safety, binary/NUL/size checks, legacy overwrite behavior/rejection, and content validation matrix are covered by tests.
- **R9:** Cross-surface golden tests prove the same logical capture writes the same frontmatter/body through CLI, API, MCP, and SDK.
- **R10:** Docs, skill references, specs, schemas, repo website sync, and hosted `/Users/gordon/work/gno.sh` docs describe the same capture/provenance workflow.
- **R11:** `bun run lint:check && bun test && bun run docs:verify` pass for the completed spec.

## Boundaries / Non-goals
- No autonomous enrichment or summarization.
- No always-on capture from chat/email/calendar.
- No dream-cycle mutation; that remains deferred in `fn-86` and should start later with explicit `gno maintain` / `gno audit` semantics.
- No remote multi-user/OAuth server work.
- No binary importer beyond rejecting unsupported binary-like inputs.
- No graph provenance schema expansion; typed graph work belongs in `fn-84`.
- No broad page-type/template system beyond the minimum needed to support capture; richer page types belong in `fn-83`.

## Risks & Open Questions
- REST may need both `POST /api/capture` and compatibility with existing `POST /api/docs`; docs must avoid endpoint drift.
- Structured `source:` frontmatter may require extending current flat frontmatter helpers or using Bun YAML support deliberately.
- API sync can be async/busy while MCP/SDK paths are more synchronous; receipt semantics must make that visible.
- Default editable collection selection must fail clearly if no editable collection exists.
- Web UI provenance should not slow down simple capture.

## Requirement Coverage
- Source repository inspiration captured without copying code: gbrain `capture`, stable inbox paths, attribution docs.
- Full autonomous dream cycle explicitly deferred to `fn-86`.
- Docs plus hosted `gno.sh` updates are first-class acceptance criteria, not cleanup.
- Specs are grouped by capability; this spec owns capture/provenance only.

## References
- `/tmp/gbrain`
- `src/core/note-creation.ts:14`
- `src/core/note-presets.ts:74`
- `src/core/document-capabilities.ts:88`
- `src/mcp/tools/capture.ts:115`
- `src/serve/routes/api.ts:2676`
- `src/serve/routes/api.ts:2803`
- `src/sdk/client.ts:722`
- `src/sdk/types.ts:113`
- `docs/MCP.md:684`
- `docs/API.md:1293`
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx:75`
