# fn-105 Verified Folder Setup

## Goal & Context
<!-- scope: business -->

Provide one reliable command that turns a folder into a usable GNO collection: `gno setup <folder>`. Users should receive a successful BM25 result immediately, semantic models may continue downloading/indexing in the background, and installed agent connectors are verified before setup is declared complete.

## Architecture & Data Models
<!-- scope: technical -->

Build the user-facing setup flow over fn-105.1's landed `setupFolder(FolderSetupOptions)` transaction, closed `FolderSetupReceipt@1.0`, existing semantic backlog/job primitives, connector install/status, and the `fn-94` activation APIs. The core receipt's frozen resumable stages are `preflight`, `config_saved`, `store_synced`, `lexical_indexed`, `lexical_proved`, and `completed`; semantic and connector state is composed as pending/status/activation output without adding stages or connector identities to that receipt. <!-- Updated by plan-sync: fn-105.1 landed setupFolder plus a closed six-stage lexical receipt; later work composes beside it. -->

Never duplicate underlying folder planning, collection/index/model, or activation logic. `setupFolder` owns canonical realpath safety, collision handling, config/store convergence, lexical ingestion, and proof. A setup invoked inside a resident-owned surface may use its runtime; direct `gno setup` remains standalone and must never auto-attach to an existing resident process. The versioned setup receipt records the canonical lexical transaction; user-facing summaries separately expose pending semantic work and shipped connector activation receipts. <!-- Updated by plan-sync (cross-spec): fn-99-resident-local-context-gateway.5 proved direct CLI is a standalone lifecycle; resident status is observational, not an attachment protocol -->

## API Contracts
<!-- scope: technical -->

- CLI: final surface `gno setup <folder> [--name] [documented exclusion/secret-authorization options] [--connector <target>] [--no-semantic] [--json]`; task 2 freezes core/semantic CLI behavior before task 3 adds connector composition.
- Exit 0 requires the completed core receipt and lexical retrieval proof; semantic/optional connector stages may be explicit `pending` only when the summary explains completion commands/status.
- Re-running calls the same core transaction and resumes/idempotently verifies rather than duplicating collections, config entries, documents, receipts, or downloads.
- `FolderSetupReceipt@1.0` remains the canonical closed lexical schema. Terminal/JSON composition may add separate semantic pending and shipped connector activation projections but must not merge those schemas or invent a second lexical receipt.

## Edge Cases & Constraints
<!-- scope: technical -->

- Missing/unreadable/empty/huge folders, nested configured collections, name collisions, symlinks, network volumes, unsupported-only content, output-path containment, filter disagreement, and store/index mismatch need explicit outcomes.
- Never index repository secrets through an implicit broad default; show effective excludes and require explicit confirmation/authorization where risk is detected.
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
bun test test/core/folder-setup.test.ts test/core/folder-setup-safety.test.ts test/core/file-lock.test.ts test/cli/setup.test.ts test/setup
bun run docs:verify
bun run test:package
.flow/bin/flowctl validate --spec fn-105-verified-folder-setup --json
```

## References

- `src/core/folder-setup.ts` and `src/core/folder-setup-planning.ts` — landed setup transaction and deterministic preflight/planning API.
- `src/core/setup-receipt.ts` and `spec/output-schemas/setup-receipt.schema.json` — closed canonical lexical receipt.
- `src/core/config-mutation.ts` and `src/core/file-lock.ts` — idempotent config/store projection and cross-process serialization.
- `src/cli/commands/init.ts`, `src/collection/add.ts`, and `src/ingestion/sync.ts` — existing primitives composed by the core.
- fn-94 activation receipt contract.

## Early proof point

Task `fn-105-verified-folder-setup.1` validated the core approach: a safe folder fixture reaches a real BM25 result through composed existing primitives, interruption recovery converges, and fresh inherited review returned SHIP. Semantic, connector, CLI, and documentation work remains in tasks 2-4.

## Requirement coverage

| Req | Description | Task(s) | Gap justification |
|-----|-------------|---------|-------------------|
| R1 | `gno setup <folder>` idempotently creates/reuses a collection, indexes supported text, and returns a real corpus-derived BM25 result. | fn-105-verified-folder-setup.1, fn-105-verified-folder-setup.2, fn-105-verified-folder-setup.4 | — |
| R2 | Semantic models/indexing can continue in the background with truthful pending status; users can search lexically immediately. | fn-105-verified-folder-setup.2, fn-105-verified-folder-setup.3 | fn-105.1 proved lexical readiness only; semantic handoff starts in fn-105.2. |
| R3 | Requested installed connectors complete the `fn-94` read-only verification without bypassing trust/auth boundaries. | fn-105-verified-folder-setup.3, fn-105-verified-folder-setup.4 | — |
| R4 | Interrupt/resume, empty/unsupported folder, nested collection, collision, symlink, and secret-risk fixtures produce safe deterministic receipts. | fn-105-verified-folder-setup.1, fn-105-verified-folder-setup.2, fn-105-verified-folder-setup.4 | — |
| R5 | JSON output has a versioned schema; terminal output gives concise success, pending work, and remediation. | fn-105-verified-folder-setup.1, fn-105-verified-folder-setup.2, fn-105-verified-folder-setup.4 | — |
| R6 | CLI docs, quickstart, skill instructions, Web/Desktop handoff, and hosted gno.sh installation flow use the same verified setup contract. | fn-105-verified-folder-setup.3, fn-105-verified-folder-setup.4 | — |

## Frozen fn-105.2 pilot contract

Task 2 ships `gno setup <folder> [-n|--name <name>] [--exclude <pattern>]... [--authorize-secret-risk] [--no-semantic] [--json]`. Exclusions are repeatable literal patterns, never CSV; omission lets the landed core select defaults or exact-root configured filters. `--authorize-secret-risk` is the only pre-authorization; global `--yes`, JSON, and non-TTY execution never authorize or prompt. A terminal TTY may ask one default-No question only after the core returns `secret_risk`.

The command bootstraps missing config/data/database state by composing init without a folder, then delegates all folder planning, config/store convergence, lexical ingestion, proof, interruption recovery, and receipt persistence to fn-105.1's `setupFolder`. Direct CLI stays standalone and never attaches to a resident/MCP/Web runtime.

Exit 0 requires a completed unchanged `FolderSetupReceipt@1.0`, ready lexical activation, and an exact result URI. The closed `setup-command-result@1.0` wrapper keeps semantic state separate. JSON is one stdout object with no progress; terminal stage progress is stderr-only and quiet-aware. Safe validation/refusal exits 1; lexical/runtime failures exit 2.

Semantic work is enabled by default but never blocks lexical success. After proof, an idempotency-guarded scheduler durably writes one latest private `setup-semantic@1.0` receipt per index/folder and starts a detached one-shot package worker that runs the existing collection-scoped embed/download path and exits. A live job is reused; dead/interrupted work resumes on rerun; scheduling failure becomes truthful pending state plus an exact foreground `gno embed <collection>` command while lexical exit remains 0. `--no-semantic` records skipped and starts nothing.

Task 2 owns only CLI/one-shot semantic scheduling, schemas/contracts/tests, command completion, and focused CLI documentation. Connector, resident, Web/Desktop, skill, hosted-site, and fn-105.3 work remain out of scope.
