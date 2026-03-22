# Desktop Beta: Import and Migration Assistant

## Overview

Create guided import flows for existing knowledge folders, especially Obsidian-style vaults and mixed work-doc folders, so users can adopt GNO without re-learning folder setup.

## Prior Context

- `fn-41-document-workspace-foundation-for` is already complete. That means GNO now has: read-only converted-document handling, editable markdown copies, optimistic save conflicts, local editor snapshots, deep links with line targets, live document-refresh plumbing, wiki-link autocomplete, and a fast Cmd/Ctrl+K quick switcher.
- The larger goal is not just “native app”, but “usable for Gordon's team and normies”: install easily, connect agents easily, understand what is happening, and trust the product without using the terminal.
- `docs/` is the source of truth for product behavior and architecture decisions. If behavior changes, update docs and website in the same implementation.
- Until the explicit runtime evaluation epic, keep implementation stack-agnostic. Do not prematurely lock the product to Tauri/Electron/Electrobun-specific assumptions outside the runtime/shell epics.

## Difficulty

Medium.

## Why now

Import is a major normie blocker and remains stack-agnostic.

## Start Here

- `src/serve/public/pages/Collections.tsx`
- `src/serve/public/components/AddCollectionDialog.tsx`
- `src/serve/routes/api.ts`
- `docs/comparisons/obsidian.md`
- `docs/USE-CASES.md`
- `website/_data/faq.yml`

## Dependencies

- Blocked by: `fn-41-document-workspace-foundation-for`, `fn-42-desktop-beta-onboarding-and-health`
- This epic should reuse the existing collection/indexing model rather than creating a parallel import-only storage concept.

## Constraints Already Decided

- Obsidian import should be honest: GNO aims to replace the day-to-day workspace, but not by claiming full Obsidian-plugin parity.
- Converted binary documents remain read-only source material; import copy must explain that clearly.
- Import must preview what will happen before indexing starts.

## Scope

- Obsidian vault import flow
- mixed-folder import with file-type guidance
- duplicate collection/path detection
- import recommendations for notes vs archives vs binary assets
- migration docs/comparison updates

## Explicit Non-goals

- Full two-way Obsidian plugin sync
- native shell packaging

## Required Deliverables

- Import wizard/assistant in the existing app
- Preview/summary state before indexing begins
- Clear migration guidance in docs/website/comparison pages
- Regression coverage for import validation and duplicate detection

## Acceptance

- Users can point GNO at an existing vault/folder and understand exactly what will happen before indexing starts.
- Import copy honestly explains what GNO does and does not replace yet.
