# Browser clipper: persistent selection and collection chooser

## Problem
The 2.0 clipper resets its collection field on reopening and expects users to know collection names. Its toolbar popup disappears when the user clicks the source page, preventing the natural open-clipper, select-text, extract workflow.

## Scope and approach
Replace the ephemeral toolbar popup with a native Chromium side panel reusing the existing preview/pairing/recovery UI. Remember the most recently explicitly selected collection locally per normalized gateway origin. Offer a keyboard-accessible collection picker populated through a narrow paired-clipper endpoint. Preserve explicit extraction, preview and confirmation.

## Acceptance Criteria
- **R1:** Reopening the panel and restarting the browser restore the last explicit collection for that gateway. A new gateway, missing/renamed collection, corrupt preference or storage failure must never silently select another destination. Show a recoverable state. Do not remember article paths, notes, tags, authentication disclosures or article text as reusable defaults. Existing pending-write recovery always takes precedence over preferences.
- **R2:** The picker lists collection names using the paired clipper's existing capture/policy boundaries. Loading, empty, offline, revoked/expired grant and stale-list states are distinct and actionable. Revalidate a remembered name; preview/write remain authoritative for filesystem availability and actual path eligibility. Return only minimal names/labels, never absolute paths, update commands, models or document content. Do not create new destination restrictions solely in the picker.
- **R3:** A toolbar gesture opens a persistent side panel. Clicking and dragging on the webpage leaves it open and preserves in-session edits; Extract now captures the newly selected exact text. Explicit closing remains possible. Feature-detect side-panel support and document the supported Chromium minimum; unsupported browsers receive clear guidance. No unsupported promise to keep a native popup open.
- **R4:** Bind extraction to the intended window/tab/document. Tab switch, navigation, reload, source closure, stale async completion and loss of activeTab permission cannot silently capture a different page or confirm an old preview against new content. Show the source and require an explicit new extraction/toolbar authorization when necessary. A saved draft must not be silently overwritten by another tab.
- **R5:** Keep exact-origin pairing, grant expiry/revocation, loopback restriction, content-free errors, preview invalidation, explicit confirmation, exact provenance and idempotent pending-write recovery intact. New collection discovery requires a valid paired grant and exact-origin CORS. Opening the panel or changing a preference never writes a note. Do not broaden to arbitrary host permissions or generic REST credentials. Old storage migrates without losing grants/pending writes; no extension-sync storage.
- **R6:** Real Chromium QA proves open-panel then page selection, extraction, preview and one confirmed write; reopen/restart preference retention; tab/navigation races; revoked/offline and pending-recovery cases. Use disposable fixtures only. Update installation/pairing/destination guidance in repository docs and gno.sh, and validate packaged extension contents/permissions. Preserve all existing real user clips.

## Boundaries / non-goals
No implementation in this planning task. No vault ingestion/routine changes: that work belongs to the separate gv-codex handoff. No remote enrichment, arbitrary URL fetching, Firefox release, collection creation UI, raw-clip deletion or automatic confirmation. Extraction-quality changes are a separate follow-up: the observed real product Reader capture contained headings/shipping text but omitted price and detailed specifications. Preserve reader_partial/canonical_url_differs warnings and do not claim complete product capture. Do not copy the user's real saved file into test fixtures or mutate it.

## Strategy Alignment
- **Local knowledge lifecycle:** make explicit web capture usable without weakening provenance or recovery.
- **Coherent agent and application surfaces:** expose the existing collection identity consistently through the paired extension.

## Decision context
Chromium toolbar popups close on focus loss; persistent selection needs a side panel, not a blur workaround. Prefer one native side-panel surface over maintaining popup plus window plus panel implementations. Chrome sidePanel API starts at 114; sidePanel.open requires 116 and a user gesture. Check actual target support during implementation. Existing activeTab grants do not automatically extend to a newly selected tab when clicking inside an already-open panel.

## Reuse points
- browser-extension/manifest.json: action.default_popup, activeTab/scripting/storage permissions.
- browser-extension/src/preview.tsx:33: empty defaultDestination; existing preview invalidation and PendingRecoveryView.
- browser-extension/src/storage.ts: strict local-state schema, clearGrant and pending persistence; avoid silently invalidating old stored state.
- browser-extension/src/service-worker.ts:52: EXTRACT currently resolves active tab; add explicit source identity.
- browser-extension/src/controller.ts and gateway.ts: preserve controller sequencing and gateway validation.
- src/serve/routes/clipper.ts:126 and :150: route gateway and paired grant authentication. Add narrow collection discovery here rather than exposing generic /api/collections.
- src/serve/capture-service.ts:170: current capture planning authority.
- browser-extension/test/{storage,controller,preview-workflow.dom,manifest,gateway}.test.* and test/clipper/{routes,pairing-security,recovery,e2e}.test.ts: extend existing coverage.

## Dependencies and ownership
Depends on completed fn-106-browser-clipper-with-provenance. No dependency on paused vault ingestion or fn138/fn141. Backend catalog and persistent surface can proceed in parallel with disjoint ownership; picker/preferences integrate after both. Final QA/docs follows integration. Preserve shared-file ordering for preview.tsx, service-worker.ts and types.ts.

## Verification
Focused extension, route/security/schema and real-browser integration checks; frozen install; lint/typecheck; full required tests; docs verification; package:clipper and verify:clipper-package. Hosted docs changes additionally require site gates and local/live page checks. Never use the real Comet clip as disposable QA data.

## References
- https://developer.chrome.com/docs/extensions/develop/ui/add-popup
- https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
- docs/integrations/browser-clipper.md
- STRATEGY.md
