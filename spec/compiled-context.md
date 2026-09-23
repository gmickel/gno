# Compiled project context

Compiled context is a deterministic, extractive Markdown artifact derived from
a verified Capsule. Source text remains fenced untrusted evidence. It does not
install or overwrite agent instructions.

## Shared contract

- Preview input: {capsule: object, budgetTokens: positive integer, budgetBytes?: positive integer}.
- Check input: {capsule: object, markdown: string}. The artifact's own bounded
  metadata records rendering settings; no filesystem paths are accepted remotely.
- Preview result: {schemaVersion:"1.0", rendererVersion:"1", capsuleId,
  markdown, digest, verificationDigest, lineageDigest, budget:
  {requestedTokens,requestedBytes,usedTokens,usedBytes,estimator,tokenizerFingerprint},
  coverage:{complete,coveredFacets,unresolvedFacets}, evidenceIds,
  omissions:[{evidenceId,reason}]}.
- Check result: {schemaVersion:"1.0",status:"current"|"stale"|"conflict"|"unverifiable",
  reasons:string[],digest:string|null,capsuleId:string|null}. It never returns
  artifact/evidence bytes on drift or authorization failure.
- Whole output (metadata, framing, citations and evidence) fits both budgets.
  Bounds: 4 MiB input artifact/Capsule, 1,000,000 tokens, 4 MiB output bytes.
- Use the Capsule's recorded estimator. A matching active-tokenizer authority
  is mandatory when recorded; there is no silent estimator fallback.
- Capsules1.1/1.2 contain required normalized retrieval/egress provenance.
  Older Capsules must be rebuilt for compilation.
- Markdown begins with an owned gno:compiled-context metadata comment, recording
  format/renderer versions, Capsule/verification/lineage identities, payload
  digest and settings. The response digest hashes all output bytes.
- Compile/preview reject stale or unauthorized evidence. Check is read-only.
  Current scope/config/model/index/tokenizer/policy identity must remain valid.
- Check and preview enforce current configured collections and egress for every
  scope/evidence/lineage source, including same-index inline requests.
- Missing/invalid inputs are errors, never empty successful context.

## Local files

CLI: gno context compiled preview --capsule FILE --budget N [--bytes N]
CLI: gno context compiled compile --capsule FILE --budget N --output NAME.gno-context.md
CLI: gno context compiled check NAME.gno-context.md [--capsule FILE]
CLI: gno context compiled refresh NAME.gno-context.md --capsule-output FILE.gno-context.capsule.json

Compile requires a new output. The private adjacent sidecar records the explicit
Capsule path, output digest, renderer settings and format. Refresh checks the
owned output digest, rebuilds via the existing Capsule request, then rechecks
source/policy before atomic replacement. Unexpected manual edits conflict.
A no-change refresh is a verified no-op. Missing companions are unverifiable.
File output forbids symlink traversal and refuses unowned destinations.
Refresh must preflight the explicitly selected Capsule destination before
publishing; failure preserves the prior complete artifact bytes.

Check exit codes: 0 current, 3 stale, 4 conflict, 2 unverifiable.
Other invalid command input uses existing validation exit1.
Existing gno context check retains its unrelated configuration contract.

## Remote and browser

MCP: gno_context_compiled_preview and gno_context_compiled_check, read-only,
inline inputs only. REST: POST /api/context/compiled/preview and
POST /api/context/compiled/check with the same inputs. No remote file writes.
Local SDK exposes preview/check plus compile/check-file/refresh-file helpers.

Web UI previews verified bytes, exact cost, citations and omitted facets,
checks supplied artifact bytes, and downloads the server-produced Markdown.
Local file refresh is a CLI recipe, never a server path submission.

Generated _.gno-context._ paths and recognized compiled artifact/sidecar content
are excluded from ingestion, including renamed copies. Intentional indexing of
compiled context is not supported in this version.
