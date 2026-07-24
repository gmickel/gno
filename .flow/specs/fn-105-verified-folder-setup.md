1. `fn-105-verified-folder-setup.1` — Build the resumable setup orchestrator and receipt (**M**) — completed
2. `fn-105-verified-folder-setup.2` — Add safe setup CLI UX and semantic background handoff (**M**); depends on `fn-105-verified-folder-setup.1`
3. `fn-105-verified-folder-setup.3` — Integrate connector verification onboarding and optional profiles (**M**); depends on `fn-105-verified-folder-setup.2`
4. `fn-105-verified-folder-setup.4` — Prove idempotency package behavior and activation documentation (**M**); depends on `fn-105-verified-folder-setup.3`

### Task 2 frozen CLI boundary

Task 2 ships `gno setup <folder> [-n|--name <name>] [--exclude <pattern>]... [--authorize-secret-risk] [--no-semantic] [--json]`. Exclusions are repeatable literal patterns, never CSV; omission lets the landed core select defaults or exact-root configured filters. `--authorize-secret-risk` is the only pre-authorization; global `--yes`, JSON, and non-TTY execution never authorize or prompt. A terminal TTY may ask one default-No question only after the core returns `secret_risk`.

The command bootstraps missing config/data/database state by composing init without a folder, then delegates all folder planning, config/store convergence, lexical ingestion, proof, interruption recovery, and receipt persistence to fn-105.1's `setupFolder`. Direct CLI stays standalone and never attaches to a resident/MCP/Web runtime.

Exit 0 requires a completed unchanged `FolderSetupReceipt@1.0`, ready lexical activation, and an exact result URI. The closed `setup-command-result@1.0` wrapper keeps semantic state separate. JSON is one stdout object with no progress; terminal stage progress is stderr-only and quiet-aware. Safe validation/refusal exits 1; lexical/runtime failures exit 2.

Semantic work is enabled by default but never blocks lexical success. After proof, an idempotency-guarded scheduler durably writes one latest private `setup-semantic@1.0` receipt per index/folder and starts a detached one-shot package worker that runs the existing collection-scoped embed/download path and exits. A live job is reused; dead/interrupted work resumes on rerun; scheduling failure becomes truthful pending state plus an exact foreground `gno embed <collection>` command while lexical exit remains 0. `--no-semantic` records skipped and starts nothing.

Task 2 owns only CLI/one-shot semantic scheduling, schemas/contracts/tests, command completion, and focused CLI documentation. Connector, resident, Web/Desktop, skill, hosted-site, and fn-105.3 work remain out of scope.
