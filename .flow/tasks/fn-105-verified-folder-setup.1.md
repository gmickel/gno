---
satisfies: [R1, R2, R4, R5]
---
# fn-105-verified-folder-setup.1 Build the resumable setup orchestrator and receipt

## Description
Build the core-only, resumable setup orchestrator and canonical receipt. This increment starts with a safe local folder, creates or reuses exactly one collection, synchronizes its configuration into the selected store, runs lexical ingestion, and accepts success only after the shipped `verifyLexicalActivation` returns a real scoped BM25 proof.

**Size:** M
**Files:** `src/core/folder-setup.ts`, `src/core/setup-receipt.ts`, `src/core/config-mutation.ts` only if a minimal recovery seam is required, `spec/output-schemas/setup-receipt.schema.json`, `test/core/folder-setup.test.ts`

### Frozen pilot contract

#### Receipt identity, path, privacy, and retention

- Persist one latest canonical JSON receipt per `(canonical index identity, canonical folder realpath fingerprint)` at `<dataDir>/setup-receipts/<canonical-index-name>/<sha256(realpath(folder))>.json`.
- Create the receipt directory as local/private and atomically replace the receipt file. The receipt may contain local setup paths, but its filename contains only the root fingerprint; it never contains corpus text, probe terms, secrets, connector identities, or model input/output.
- Retain exactly one latest receipt for each tuple. Failed, interrupted, and successful states remain available for recovery and are overwritten only by a rerun of the same tuple. Cross-root garbage collection and history are out of scope.
- The versioned schema is closed and canonical. It records input/config/index fingerprints, selected collection identity, stage tokens, generated paths, pending/failure remediation, and the shipped activation receipt without inventing a second lexical-proof contract.

#### Collection reuse and collision rules

- Canonicalize the requested folder through realpath before any containment, identity, or receipt decision.
- An exact configured realpath match reuses that collection. If an explicit requested name disagrees with the exact-path collection, fail closed instead of renaming or aliasing it.
- A derived-name collision on another root receives the first deterministic available `-2`, `-3`, and so on suffix while staying within the 64-character collection-name limit. An explicit-name collision on another root fails closed.
- An ancestor/descendant overlap with a configured collection is ambiguous and fails closed. Setup never creates an implicit nested collection.

#### Safe input boundary

- Missing, non-directory, unreadable, dangerous-root, secret-risk-without-explicit-authorization/exclusions, empty, unsupported-only, and no-indexable-lexical-corpus inputs cannot produce setup success.
- Empty or unsupported-only inputs fail before collection creation. The core is noninteractive: it reports a stable code/remediation and never confirms risk on the caller's behalf.
- This task may expose the risk/exclusion decision as a core input seam for task 2, but owns no prompts or CLI flags.

#### Stages and interruption recovery

- Frozen stage order: `preflight`, `config_saved`, `store_synced`, `lexical_indexed`, `lexical_proved`, `completed`.
- Persist `in_progress` before each side effect and `passed` or `failed` after observation. Inject test-only failures after config save, store/DB sync, lexical indexing, and lexical proof.
- On rerun, treat the receipt only as a recovery hint and re-derive external truth. Reuse an exact-path config entry; repair a missing store projection; rerun incremental `SyncService` ingestion; and call shipped `verifyLexicalActivation`, which owns activation fingerprint/cache/retry behavior.
- A saved config followed by failed DB sync is an explicit recoverable state. Rerun must converge without a duplicate collection, config rewrite when unchanged, duplicate content, model download, semantic job, connector check, resident attachment, or remote work.

### Approach

- Compose existing collection/config, `SyncService`, and `verifyLexicalActivation` primitives; do not duplicate their indexing, FTS, receipt, retry, or cache logic.
- Add focused source-of-truth tests first for successful proof, exact-path reuse, deterministic collision handling, unsafe/empty/unsupported rejection, every interruption checkpoint, partial config-before-store recovery, and side-effect-free convergence.
- Keep the task core-only. CLI, semantic handoff, connectors, resident runtime, Web/Desktop, skill, repo docs, and gno.sh remain later tasks.

### Investigation targets

**Required** (read before coding):
- `src/cli/commands/init.ts`
- `src/collection/add.ts`
- `src/ingestion/sync.ts`
- `src/core/config-mutation.ts`
- `src/core/activation-verifier.ts`
- `src/core/file-ops.ts`
- `src/app/constants.ts`

**Optional** (reference as needed):
- `src/core/file-lock.ts`
- `src/serve/resident-runtime.ts:263-461` — resident-owned config, sync, and lifecycle surface; direct setup must not attach to it.

## Acceptance

- [ ] Safe folder fixture creates or reuses exactly one collection, indexes supported content through `SyncService`, and returns a real collection-scoped `verifyLexicalActivation` BM25 receipt.
- [ ] The closed setup receipt schema and canonical serializer implement the frozen path, identity, privacy, stage, fingerprint, and one-latest-per-tuple retention contract.
- [ ] Exact-path reuse, explicit/derived name collisions, nested roots, symlinks, unsafe roots, secret risk, empty folders, unsupported-only folders, and no-indexable-corpus outcomes are deterministic and safe.
- [ ] Injected failures after config save, store sync, lexical indexing, and lexical proof leave truthful resumable receipts; rerun converges without duplicate collections, config rewrites when unchanged, duplicate content, jobs, downloads, or remote work.
- [ ] Config-saved/store-unsynced partial state is repaired idempotently, while shipped activation fingerprint/cache/retry semantics remain authoritative.
- [ ] Focused tests, full tests, lint/typecheck, schema validation, and a fresh implementation review pass with no core-task scope leakage.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
