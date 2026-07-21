# fn-105 Verified Folder Setup

## Goal & Context
<!-- scope: business -->

Provide one reliable command that turns a folder into a usable GNO collection: `gno setup <folder>`. Users should receive a successful BM25 result immediately, semantic models may continue downloading/indexing in the background, and installed agent connectors are verified before setup is declared complete.

## Architecture & Data Models
<!-- scope: technical -->

Build an idempotent setup orchestrator over existing init, collection add, index, model bootstrap, connector install/status, and the `fn-94` activation verifier. Stages are resumable and receipt-backed: preflight, config/collection, lexical index, retrieval proof, semantic bootstrap, connector verification, final summary.

Never duplicate underlying collection/index/model logic. Derive a safe collection name with collision handling, preserve existing configuration, and use the resident runtime when available. A versioned setup receipt records inputs, stage state, generated paths, fingerprints, pending background work, and rollback guidance.

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
