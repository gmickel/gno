# fn-41-document-workspace-foundation-for.5 Upgrade markdown authoring foundations in the editor

## Description

Upgrade the markdown editing experience so linked-note workflows feel native inside GNO. Wire the existing wiki-link autocomplete into CodeMirror, support create-linked-note flows, and surface live related-note context while editing. Keep all new UI inside the current shadcn/Radix/CodeMirror stack.

**Files:** `src/serve/public/components/editor/CodeMirrorEditor.tsx`, `src/serve/public/pages/DocumentEditor.tsx`, `src/serve/public/components/WikiLinkAutocomplete.tsx`, `src/serve/public/components/RelatedNotesSidebar.tsx`, `src/serve/public/components/ui/*`, docs/tests

## Acceptance

- Typing `[[` in the editor opens the existing wiki-link autocomplete with searchable note targets.
- When a target note does not exist, the editor can create a linked markdown note in an allowed collection and insert the resulting wiki link without leaving edit mode.
- Related-note context is available while editing and can react to the current draft content with bounded debounce/caching.
- All new interaction surfaces use existing shadcn/Radix primitives under `src/serve/public/components/ui/*`; no second UI framework/headless library is introduced.
- Tests and docs cover autocomplete, linked-note creation, edit-mode related-note behavior, and the updated Obsidian/website messaging around linked-note authoring.

## Notes For Implementer

- `WikiLinkAutocomplete` already exists but does not appear wired into the editor: `src/serve/public/components/WikiLinkAutocomplete.tsx:1-220`.
- `CodeMirrorEditor` already exposes imperative insertion/wrap hooks that can support autocomplete actions: `src/serve/public/components/editor/CodeMirrorEditor.tsx:26-39`, `src/serve/public/components/editor/CodeMirrorEditor.tsx:118-181`.
- `RelatedNotesSidebar` already supports draft-content-driven updates: `src/serve/public/components/RelatedNotesSidebar.tsx:52-65`, `src/serve/public/components/RelatedNotesSidebar.tsx:116-125`.
- Attachment paste/drop, templates, and the quick switcher remain follow-on work unless they become necessary to finish the acceptance above.
- Current Obsidian comparison copy still treats quick vault navigation and editor workflows as Obsidian-only advantages: `docs/comparisons/obsidian.md:96-104`, `docs/comparisons/obsidian.md:147-166`.
