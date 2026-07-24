# fn-105 Verified Folder Setup

## Goal & Context
<!-- scope: business -->

Provide one reliable command that turns a folder into a usable GNO collection: `gno setup <folder>`. Users should receive a successful BM25 result immediately, semantic models may continue downloading/indexing in the background, and installed agent connectors are verified before setup is declared complete.

## Architecture & Data Models
<!-- scope: technical -->

Build an idempotent setup orchestrator over existing init, collection add, index, model bootstrap, connector install/status, and the `fn-94` activation verifier. Stages are resumable and receipt-backed: preflight, config/collection, lexical index, retrieval proof, semantic bootstrap, connector verification, final summary.

Never duplicate underlying collection/index/model logic. Derive a safe collection name with collision handling and preserve existing configuration. A setup invoked inside a resident-owned surface may use its runtime; direct `gno setup` remains standalone and must never auto-attach to an existing resident process. A versioned setup receipt records inputs, stage state, generated paths, fingerprints, pending background work, and rollback guidance. <!-- Updated by plan-sync (cross-spec): fn-99-resident-local-context-gateway.5 proved direct CLI is a standalone lifecycle; resident status is observational, not an attachment protocol -->

## API Contracts
<!-- scope: technical -->

- CLI: `gno setup <folder> [--name] [--connector <target>] [--no-semantic] [--json]`.
- Exit 0 requires lexical retrieval proof; semantic/optional connector stages may be explicit `pending` only when the summary explains completion commands/status.
- Re-running resumes/idempotently verifies rather than duplicating collections or downloads.
- JSON schema exposes stage status, created/reused resources, activation receipt, pending jobs, and remediation.

## Edge Cases & Constraints
<!-- scope: technical -->

- Missing/unreadable/empty/huge folders, nested configured collections, name collisions, symlinks, network volumes, and unsupported-only content need explicit outcomes.
- Never index repository secrets through an implicit broad default; show excludes and require confirmation where risk is detected.
- Lexical proof must not wait for semantic models or remote services.
- Connector trust/auth prompts remain user-controlled.
- Interrupted runs resume safely and do not corrupt config/index state.
- `--json` remains stdout-clean while progress goes to stderr.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** `gno setup <folder>` idempotently creates/reuses a collection, indexes supported text, and returns a real corpus-derived BM25 result.
- **R2:** Semantic models/indexing can continue in the background with truthful pending status; users can search lexically immediately.
- **R3:** Requested installed connectors complete the `fn-94` read-only verification without bypassing trust/auth boundaries.
- **R4:** Interrupt/resume, empty/unsupported folder, nested collection, collision, symlink, and secret-risk fixtures produce safe deterministic receipts.
- **R5:** JSON output has a versioned schema; terminal output gives concise success, pending work, and remediation.
- **R6:** CLI docs, quickstart, skill instructions, Web/Desktop handoff, and hosted gno.sh installation flow use the same verified setup contract.

## Boundaries
<!-- scope: business -->

No new file converter, OAuth login, automatic remote upload, hidden background daemon install, trust-prompt automation, or removal of granular init/collection/index commands.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

A single verified path reduces activation friction and ends with real value rather than a checklist of infrastructure steps.

### Implementation Tradeoffs
<!-- scope: technical -->

Composing existing primitives minimizes new failure modes. Lexical-first readiness separates immediate utility from heavier optional semantic setup.

## Frozen fn-105.1 pilot contract

The first increment is core-only. Its durable receipt is one latest canonical JSON file per canonical index identity and SHA-256 fingerprint of the folder realpath, under the local data directory's `setup-receipts/` tree. Exact-path collection matches are reused; explicit-name conflicts and nested collection overlaps fail closed; derived-name conflicts receive deterministic numeric suffixes.

The core rejects missing, non-directory, unreadable, dangerous-root, unapproved secret-risk, empty, unsupported-only, and no-indexable-lexical-corpus inputs. Its frozen recovery stages are `preflight`, `config_saved`, `store_synced`, `lexical_indexed`, `lexical_proved`, and `completed`. Each side effect is bracketed by an atomic receipt update. Reruns re-derive config/store/index/proof truth and repair config-saved/store-unsynced state without duplicate collections, content, jobs, downloads, connector work, resident attachment, or remote work.

Task 1 owns no CLI, semantic model work, connector verification, resident runtime integration, Web/Desktop changes, or documentation. The shipped `verifyLexicalActivation` remains the only lexical proof, fingerprint, cache, and retry authority.
## Implementation Plan

1. `fn-105-verified-folder-setup.1` — Build the resumable setup orchestrator and receipt (**M**)
2. `fn-105-verified-folder-setup.2` — Add safe setup CLI UX and semantic background handoff (**M**); depends on `fn-105-verified-folder-setup.1`
3. `fn-105-verified-folder-setup.3` — Integrate connector verification onboarding and optional profiles (**M**); depends on `fn-105-verified-folder-setup.2`
4. `fn-105-verified-folder-setup.4` — Prove idempotency package behavior and activation documentation (**M**); depends on `fn-105-verified-folder-setup.3`

## Quick commands

```bash
bun test test/cli/setup* test/core/setup*
bun run docs:verify
bun run test:package
.flow/bin/flowctl validate --spec fn-105-verified-folder-setup --json
```

## References

- `src/cli/commands/init.ts`, `src/collection/add.ts`, and `src/ingestion/sync.ts` — existing primitives.
- `src/core/config-mutation.ts` — config mutation guard.
- fn-94 activation receipt contract.

## Early proof point

Task `fn-105-verified-folder-setup.1` validates the core approach (a safe folder fixture reaches a real BM25 result through composed existing primitives before model download).
If it fails, re-evaluate the stage transaction/resume receipt and lexical-first boundary before continuing with `fn-105-verified-folder-setup.2`+.

## Requirement coverage

| Req | Description | Task(s) | Gap justification |
|-----|-------------|---------|-------------------|
| R1 | `gno setup <folder>` idempotently creates/reuses a collection, indexes supported text, and returns a real corpus-derived BM25 result. | fn-105-verified-folder-setup.1, fn-105-verified-folder-setup.2, fn-105-verified-folder-setup.4 | — |
| R2 | Semantic models/indexing can continue in the background with truthful pending status; users can search lexically immediately. | fn-105-verified-folder-setup.1, fn-105-verified-folder-setup.2, fn-105-verified-folder-setup.3 | — |
| R3 | Requested installed connectors complete the `fn-94` read-only verification without bypassing trust/auth boundaries. | fn-105-verified-folder-setup.3, fn-105-verified-folder-setup.4 | — |
| R4 | Interrupt/resume, empty/unsupported folder, nested collection, collision, symlink, and secret-risk fixtures produce safe deterministic receipts. | fn-105-verified-folder-setup.1, fn-105-verified-folder-setup.2, fn-105-verified-folder-setup.4 | — |
| R5 | JSON output has a versioned schema; terminal output gives concise success, pending work, and remediation. | fn-105-verified-folder-setup.1, fn-105-verified-folder-setup.2, fn-105-verified-folder-setup.4 | — |
| R6 | CLI docs, quickstart, skill instructions, Web/Desktop handoff, and hosted gno.sh installation flow use the same verified setup contract. | fn-105-verified-folder-setup.3, fn-105-verified-folder-setup.4 | — |
