---
satisfies: [R1, R2, R4, R5]
---
# fn-105-verified-folder-setup.2 Add safe setup CLI UX and semantic background handoff

## Description
Deliver the user-facing `gno setup <folder>` command over the landed core transaction, plus a truthful standalone semantic background/resume handoff.

**Size:** M
**Files:** `src/cli/program.ts`, `src/cli/commands/setup.ts`, `src/cli/commands/setup-semantic.ts`, `src/cli/setup-semantic-worker.ts`, `src/cli/commands/completion/scripts.ts`, `spec/cli.md`, `spec/output-schemas/setup-command-result.schema.json`, `spec/output-schemas/setup-semantic-receipt.schema.json`, `docs/CLI.md`, `test/cli/setup.test.ts`, `test/cli/setup-semantic.test.ts`

## Frozen CLI contract

### Command, flags, and defaults

```text
gno setup <folder>
  [-n, --name <name>]
  [--exclude <pattern>]...
  [--authorize-secret-risk]
  [--no-semantic]
  [--json]
```

- `<folder>` is required. Global `--index`, `--config`, `--offline`, `--yes`, `--quiet`, and `--verbose` keep their existing meanings.
- `--name` is optional and passes unchanged into `FolderSetupOptions.name`; the core owns normalization, collision suffixing, exact-root reuse, and disagreement failures.
- `--exclude` is repeatable and each occurrence is one literal collection exclusion pattern. It is not CSV. No occurrence passes `undefined`, preserving the core's create defaults and exact-root configured filters. An empty occurrence is a validation error. Preserve caller order only for argument diagnostics; the core owns canonical deduplication/sorting in the receipt.
- `--authorize-secret-risk` is the only setup-specific pre-authorization. Global `--yes` accepts safe defaults and never authorizes likely credentials/private keys/env files.
- Semantic work is enabled by default. `--no-semantic` disables scheduling and reports `skipped`; it never changes lexical setup behavior.
- Task 2 exposes no connector flag or behavior. Connector composition remains fn-105.3.

### Bootstrap and core composition

- A missing installation is bootstrapped only by composing the existing init-without-folder path to create config/data/database state. The CLI must not ask init to add the folder and must not duplicate collection planning.
- Open the selected global `--index` store, then call landed `setupFolder(FolderSetupOptions)` as the sole folder safety, collection create/reuse, config/store synchronization, lexical ingestion, activation proof, and canonical lexical receipt transaction.
- The selected config/data/database paths and canonical index identity passed to the core must match the opened store. Close every CLI-owned store on all outcomes.
- Direct `gno setup` is standalone. It never probes, contacts, attaches to, or queues work in an existing resident/MCP/Web runtime.

### Secret-risk confirmation and noninteractive behavior

- Without `--authorize-secret-risk`, first call the core with `secretRiskAuthorized:false`.
- Only a terminal TTY may prompt, and only after the core returns `secret_risk`. Show the canonical folder plus effective exclusions from the failed receipt, ask one default-No confirmation, and on explicit Yes rerun the same core transaction with `secretRiskAuthorized:true`.
- `--json`, global `--yes`, or non-TTY input is noninteractive and never prompts. A secret-risk result remains failed unless the caller supplied repeatable exclusions that remove the risk or explicitly passed `--authorize-secret-risk`.
- Declining or EOF preserves the failed core receipt and returns the validation/safety exit.

### Progress and output

- Add closed `setup-command-result@1.0`. It references the unchanged closed `FolderSetupReceipt@1.0`; exposes exactly one lexical setup outcome plus a separate semantic projection; and never adds semantic stages/fields to the lexical receipt.
- JSON mode emits exactly one canonical result object on stdout and no progress. Domain failures also emit that result once, then terminate silently with the classified nonzero exit.
- Terminal mode emits concise stage transitions on stderr by wrapping the core `receiptWriter` seam while still calling shipped `persistSetupReceipt`. Global `--quiet` suppresses progress but not the final one-line result/remediation.
- Terminal success shows created/reused collection identity, exact activation `resultUri`, canonical setup receipt path, semantic status, and its resume/status command. A success claim is forbidden without `receipt.status=="completed"`, `activation.ready==true`, and a non-empty exact `activation.evidence.resultUri`.
- Collision, reuse, interruption, and resume state come from the core receipt; the CLI must not infer or relabel them.

### Exit codes

- `0`: completed lexical setup with ready activation and exact result URI. Semantic `scheduled`, `running`, `pending`, `completed`, or `skipped` never changes lexical success.
- `1`: argument/name/exclusion validation, safe-input rejection, collection conflict/overlap/filter disagreement, store-index mismatch, secret-risk refusal/noninteractive failure, or user decline.
- `2`: config/receipt/data IO, store projection, indexing/proof runtime failure, or an internal invariant failure.
- Semantic scheduling/download/embedding failure never changes a proven lexical exit 0. It must be reported as `pending` or `failed` with an exact foreground resume command.

### Standalone semantic background receipt

- Add closed `setup-semantic@1.0`, one latest local receipt per canonical `(index identity, folder realpath fingerprint)`, stored beneath the selected data directory with private atomic persistence.
- Receipt state is `scheduled|running|completed|failed|pending|skipped` and records bounded identifiers/timestamps: job ID, collection, canonical index, PID when live, setup receipt fingerprint/path, log path, foreground resume command, completion counts or bounded error/remediation. Never persist model input/output, corpus text, probe term, secrets, or connector identity.
- After lexical success, an idempotency/file-lock guarded scheduler reuses a live matching job, accepts a current completed receipt, or replaces a dead/interrupted receipt and starts one detached one-shot worker. The worker belongs to this invocation/package version, opens its own selected store/model lifecycle, calls the existing collection-scoped `embed` implementation (including normal download/offline policy), atomically updates the semantic receipt, and exits.
- The setup parent writes `scheduled` durably before returning, never awaits download or embedding, and never starts a daemon/resident.
- Spawn or receipt persistence failure returns semantic `pending` plus the exact foreground resume command `gno [global index/config/offline flags] embed <collection>` and bounded remediation. `--no-semantic` writes/returns `skipped` without spawning.
- Rerunning setup re-derives PID liveness/receipt state under the same lock. It never starts a second live worker. A dead `scheduled|running` worker is resumable and is replaced deterministically.

### Approach

- Treat `setupFolder(options)` from `src/core/folder-setup.ts` as the only create/reuse, safety-preflight, config/store synchronization, lexical-ingestion, and lexical-proof boundary. Render `FolderSetupResult.error.code`, `message`, and `remediation` without reimplementing planner rules.
- Preserve the closed `FolderSetupReceipt@1.0` contract and its frozen stages (`preflight`, `config_saved`, `store_synced`, `lexical_indexed`, `lexical_proved`, `completed`).
- Reuse the existing collection-scoped embed path and download/offline policy inside the one-shot worker. Do not use a resident `JobManager`, resident status, REST, or MCP.
- Preserve granular init/collection/index/embed commands.

### Investigation targets
**Required** (read before coding):
- `src/core/folder-setup.ts`
- `src/core/folder-setup-planning.ts`
- `src/core/setup-receipt.ts`
- `src/core/file-lock.ts`
- `spec/output-schemas/setup-receipt.schema.json`
- `src/cli/program.ts`
- `src/cli/commands/init.ts`
- `src/cli/commands/embed.ts`
- `src/cli/detach.ts`
- `src/cli/errors.ts`
- `test/core/folder-setup.test.ts`
- `test/core/folder-setup-safety.test.ts`

**Optional** (reference as needed):
- `src/embed/backlog.ts`
- `src/core/job-manager.ts`

## Acceptance
- [ ] CLI contract implements the exact frozen command and repeatable exclusion behavior; no CSV ambiguity or implicit secret authorization remains.
- [ ] Missing installation bootstrap composes init without adding the folder, then one core attempt per authorization attempt owns all lexical work; direct CLI never contacts a resident.
- [ ] Terminal-only default-No risk confirmation, JSON/yes/non-TTY fail-closed behavior, and explicit authorization have deterministic tests.
- [ ] JSON validates against the closed command-result schema, remains stdout-clean, and preserves the unchanged setup receipt. Terminal progress/final output follows stderr/stdout/quiet rules.
- [ ] Exit 0 is impossible without a real exact activation result URI; domain validation versus runtime exits are deterministic.
- [ ] Default semantic scheduling persists a private canonical receipt and returns without waiting; a one-shot detached worker downloads/embeds collection-scoped backlog and exits. No-semantic, offline, spawn failure, completion, failure, live-job reuse, dead-job resume, and concurrent scheduling are truthful and idempotent.
- [ ] Collision/reuse and all four core interruption checkpoints remain visible and rerunnable without duplicate collections/documents/semantic workers.
- [ ] `spec/cli.md`, schemas, command completion, and `docs/CLI.md` match implementation. No connector/resident/Web/Desktop/skill/gno.sh work enters task 2.
- [ ] Focused tests, lint/typecheck, full suite, Flow validation, and fresh inherited implementation review pass.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
