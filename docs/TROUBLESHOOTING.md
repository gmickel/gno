---
title: Troubleshooting
description: Diagnose and fix common GNO issues across installation, models, indexing, workspace UI, and agent integrations.
keywords: gno troubleshooting, local search issues, model install issues, indexing issues, mcp troubleshooting
---

# Troubleshooting

Common issues and solutions for GNO's local search engine, workspace UI, models, and agent integrations.

## Quick Diagnosis

Run `gno doctor` first:

```bash
gno doctor
```

This checks:

- Configuration validity
- Database accessibility
- SQLite extensions
- Model cache status
- Per-collection corpus-derived lexical retrieval

`gno status --json` always exits 0 after a successful read and exposes degraded
state under `.activation`. `gno doctor` exits 2 when lexical activation fails.
Semantic pending and connector-only warnings do not block lexical use.

## Exit Codes

| Code | Meaning          | Common Causes                                                                                      |
| ---- | ---------------- | -------------------------------------------------------------------------------------------------- |
| 0    | Success          | Command completed                                                                                  |
| 1    | Validation error | Bad arguments, missing options                                                                     |
| 2    | Runtime error    | IO, database, model failures                                                                       |
| 3    | `NOT_RUNNING`    | `gno serve --status` / `--stop` or `gno daemon --status` / `--stop` found no live matching process |

## Installation Issues

### "Command not found: gno"

GNO not in PATH after install.

```bash
# Verify installation
which gno

# If not found, reinstall globally
bun install -g @gmickel/gno

# Or add to PATH
export PATH="$HOME/.bun/bin:$PATH"
```

### "sqlite-vec not available" (macOS)

Apple's bundled SQLite lacks extension support.

```bash
# Install Homebrew SQLite
brew install sqlite3

# Verify
ls /opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib
```

GNO auto-detects Homebrew SQLite. If still failing:

```bash
# Check doctor output
gno doctor --json | jq '.checks[] | select(.name == "sqlite-vec")'
```

Runtime vector failures preserve the original sqlite-vec load/probe reason.
`gno vsearch` returns that reason directly; `gno query --explain` includes it
while degrading to BM25-only. Repeated status/API checks should not spam the
same warning.

### Bun Version Too Old

```bash
# Check version
bun --version

# Update Bun
bun upgrade
```

## Indexing Issues

### Retrieval activation failed

Inspect the exact collection, stage, code, and remediation:

```bash
gno status --json | jq '.activation.collections[] | select(.ready == false)'
```

- `no_documents`: index at least one supported text document.
- `no_probe_term`: the bounded document prefixes contain no safe searchable
  term; check filters/content and reindex.
- `index_out_of_sync`: an owned FTS row or sync marker is missing/stale; run
  `gno index <collection> --no-embed`.
- `index_query_failed` or `retrieval_mismatch`: transient/recoverable failures
  are retried on the next check; rebuild the collection if they persist.

A cold proof reads at most 64 document prefixes of 32,768 characters and tries
at most 64 terms. Receipts persist hashes and result identity, never the raw
probe term, query, snippet, or passage.

Supported GNO writers maintain `fts_mirror_hash` transactionally. Migration 013
compares legacy FTS bodies once before trusting/backfilling that marker. Direct
post-migration mutation of internal FTS bodies outside GNO is unsupported and
may not change the metadata-only passive identity; rebuild through
`gno index <collection> --no-embed`.

### Connector is installed but not verified

Installation and `gno mcp status` confirm config presence only. From the Web
Connectors page, run **Verify retrieval** for a configured MCP target and choose
the collection to test. The proof checks tool discovery, `gno_status`, and a
scoped `gno_search` without rewriting client config. Skill-only integrations
remain `target_runtime_unverifiable`; the client must load and use them itself.

### "Collection not found"

Collection name doesn't exist.

```bash
# List collections
gno collection list

# Add collection
gno collection add /path/to/folder --name myname
```

### "Path does not exist"

Collection path is invalid or moved.

```bash
# Check path
ls /path/in/config

# Update config manually or re-add
gno collection remove oldname
gno collection add /correct/path --name newname
```

### "No documents indexed"

No files match patterns.

```bash
# Check what would be indexed
gno ls

# Verify patterns
cat ~/.config/gno/config/index.yml
```

Common causes:

- Pattern doesn't match files (`**/*.md` vs actual extensions)
- Exclude patterns too aggressive
- Empty directory

### "Invalid PDF structure" while indexing

The PDF is incomplete or damaged. GNO records it as a non-fatal `CORRUPT`
document, keeps the rest of the collection and Web UI available, and does not
retry the unchanged file on every update.

Validate the source independently:

```bash
qpdf --check /path/to/file.pdf
```

Replace or re-export the PDF, then run `gno update` or **Update All** in the Web
UI. A changed source hash makes GNO try the repaired file again.

### Saved Context Capsule reverification failed

Inspect the registration in its index:

```bash
gno --index <name> context watches --json
gno --index <name> context reverify <capsule-registration-id> --json
```

- `capsule_file_changed`: the exact saved bytes no longer match the registered
  hash. Unwatch and register the intended canonical Capsule again.
- `capsule_file_missing`: restore the caller-owned file at its absolute path,
  then retry.
- `capsule_read_failed`: replace invalid JSON with a valid canonical Capsule
  and register it again.
- `invalid_filter`: the active index does not match the Capsule's canonical
  index; rerun with the matching global `--index`.

Failures never rewrite the file and never masquerade as a freshness receipt.
If the resident journal cursor expired under bounded retention, the next
settled cycle runs one conservative bounded pass over registrations and moves
the durable high-water mark only after non-cancelled work completes.

### "I changed a collection embedding model and vector results look stale"

Collection-level `models.embed` overrides do not rewrite old vectors immediately.

After changing the embed model for an existing collection:

```bash
# Re-run embeddings for that collection
gno embed --collection my-collection
```

Or re-index that collection from the Web UI / API and let embedding catch up.

Until that finishes:

- BM25 still works
- vector/hybrid quality may lag behind the new collection setting
- the Collections page warns about this when you save an embed override

### "The collection model override I entered does not load"

Check:

- the URI is valid (`hf:` or `file:` or your configured HTTP embedding backend)
- the model is available locally or auto-download is allowed
- `GNO_NO_AUTO_DOWNLOAD` / offline mode is not blocking first use

Useful commands:

```bash
gno doctor
gno models pull
```

## Recovery

### I overwrote or mangled a note in the editor

For editable markdown/plaintext files, GNO now keeps local snapshots before successful in-app saves.

Use the editor's **History** button to:

- inspect recent local snapshots
- restore a prior version into the editor
- recover first before touching the file in Finder or asking for support

This local history is meant for common self-recovery cases, not long-term version control.

### Slow Indexing

Large collections take time.

Tips:

- Use specific patterns (`**/*.md` vs `**/*`)
- Add excludes (`node_modules`, `dist`)
- First run is slowest (subsequent runs are incremental)

### Slow Indexing on Windows

Windows can be significantly slower due to NTFS overhead and real-time antivirus scanning.

**Exclude GNO data directory from Windows Defender:**

1. Open Windows Security → Virus & threat protection
2. Under "Virus & threat protection settings", click "Manage settings"
3. Scroll to "Exclusions" and click "Add or remove exclusions"
4. Add folder: `%LOCALAPPDATA%\gno\data`

This can improve indexing speed by 2-4x on Windows.

## Daemon Issues

### "Daemon not refreshing after I changed config"

V1 `gno daemon` reads config on startup.

If you add/remove collections or change patterns while it is running, restart it:

```bash
# Foreground: Ctrl+C, then re-run gno daemon
# Detached: stop and re-launch
gno daemon --stop
gno daemon --detach
```

### "Daemon is running but nothing updates"

Check:

```bash
gno collection list
gno ls
gno daemon --status
```

Common causes:

- no collections configured
- file changes happened outside configured patterns
- the daemon was started with `--no-sync-on-start` and is only watching future changes

### "I ran gno serve and gno daemon together"

Serve and daemon are two modes of the same resident owner. The second process
fails startup with an owner-status hint instead of opening a competing store.

Use one of:

- `gno serve` for browser/desktop sessions
- `gno daemon` for headless continuous indexing

Stop the current owner before switching modes.

### Resident `/mcp` returns 401 or 403

- `401`: a daemon non-loopback listener did not receive the current bearer
  token. Read the restrictive token file locally and send
  `Authorization: Bearer <token>`; rotating the file revokes existing sessions.
- `403`: the socket peer, exact Host, present Origin, session identity, or write
  authorization failed. Do not add wildcards. Authentication alone never
  enables writes; set `gateway.enableWrite: true` or `--mcp-enable-write`
  separately.
- `gno serve --host 0.0.0.0` always fails. Serve carries Web/REST on the same
  listener and remains loopback-only; use the headless daemon for an explicitly
  secured non-loopback MCP listener.

### Detached status has `"resident": null`

`gno serve|daemon --status --json` fetches the live redacted snapshot on a
best-effort 500 ms budget. The process can still be running when its listener is
starting, stopping, blocked, or otherwise unreachable. Confirm the recorded
port, then retry `GET /api/resident/status`; never treat a null snapshot as
permission to start a second owner.

### "pid-file exists but `--status` says not running"

The recorded pid is dead. `--status` reports stale pid-files as `running:false`
and exits with code `3` (`NOT_RUNNING`). The next `--detach` cleans the stale
pid-file automatically before spawning the new child — no manual cleanup
needed.

```bash
gno daemon --status      # exits 3, "running no"
gno daemon --detach      # succeeds, replaces stale pid-file
```

### "live-foreign pid: refusing to signal"

You upgraded gno while a detached `serve` or `daemon` was still running. The
new binary refuses to manage the old process because it was started by a
different version. `--stop` errors with `VALIDATION` (exit 1):

```
gno daemon (pid 12345) is live but was started by gno 1.0.4; this binary is 1.1.0.
Refusing to signal pid 12345; terminate it manually and delete /path/to/daemon.pid.
```

Resolve manually:

```bash
kill 12345
rm /path/to/daemon.pid
gno daemon --detach
```

`--status --json` exposes the same metadata to machine consumers via a
`NOT_RUNNING` envelope on stderr:

```json
{
  "code": "NOT_RUNNING",
  "details": {
    "foreign_live": {
      "pid": 12345,
      "recorded_version": "1.0.4",
      "current_version": "1.1.0"
    }
  }
}
```

The stdout payload is still schema-shaped (`running:false`); foreign-live
clients can rely on `details.foreign_live` to distinguish "nothing running"
from "live but unmanageable".

### "another serve/daemon start is in progress"

`--detach` takes out an atomic start-lock (a `.startlock` sidecar next to the
pid-file) for the duration of the spawn. Two parallel `--detach` invocations
race for the same lock; the loser sees:

```
another gno daemon start is in progress (lock-file /path/to/daemon.pid.startlock)
```

Stale locks (>30s old) auto-recover on the next attempt. If a fresh lock is
stuck inside the 30s window — for example because the racing process was
killed mid-spawn — delete the `.startlock` sidecar manually before retrying.

### "`--stop` exited 3 but printed nothing"

That's by design. `--stop` is silent when there is no pid-file (or the
recorded pid is dead): no error envelope, no stderr text, just exit code 3
(`NOT_RUNNING`). Script `--stop` against the exit code, not stderr.

## Search Issues

### No Results

```bash
# Check if indexed
gno ls --json | jq '.documents | length'

# Try broader search
gno search "test"

# Check doctor
gno doctor
```

### Poor Relevance

**Diagnose with --explain:**

```bash
gno query "my search" --explain
```

This shows scoring breakdown for each result:

- `bm25`: Keyword match score (high = exact terms found)
- `vector`: Semantic similarity (high = meaning matches)
- `fusion`: Combined RRF score
- `rerank`: Cross-encoder judgment (if enabled)
- `blended`: Final score

**Common Issues:**

| Symptom                  | Cause                      | Fix                                       |
| ------------------------ | -------------------------- | ----------------------------------------- |
| High BM25, low vector    | Query too keyword-specific | Use `gno query` not `gno search`          |
| Low BM25, high vector    | Query too abstract         | Add specific keywords                     |
| Good scores, wrong order | Fusion needs tuning        | Use `gno query` (reranking on by default) |
| All low scores           | Content not indexed        | Check `gno ls`, re-index                  |

**Improve Results:**

1. **Add contexts** - Semantic hints improve relevance
2. **Use reranking** - `gno query` has reranking on by default (slower but better)
3. **Choose right mode:**
   - `gno search` - Exact keyword matching
   - `gno vsearch` - Conceptual/semantic matching
   - `gno query` - Combined (usually best)
4. **Adjust min-score** - Filter low-confidence results: `--min-score 0.3`
5. **Try expansion** - On `slim` / `slim-tuned`, balanced mode already expands by default. On larger presets, try `--thorough` or remove `--no-expand` if recall seems too low.

**Lexical edge cases:**

- hyphenated technical terms like `real-time`, `gpt-4`, and `DEC-0054` are handled intentionally by BM25 search
- quoted phrases are supported: `gno search '"zero downtime deploy"'`
- negation requires at least one positive term: `gno search 'dashboard -lag'`
- unmatched quotes fail as a validation error instead of surfacing raw SQLite FTS syntax noise

## Terminal Links Not Clickable

CLI OSC 8 hyperlinks only appear when:

- you are using terminal output (not `--json`, `--csv`, `--xml`, `--files`, or `--md`)
- stdout is a TTY
- the result has an absolute path available

If you want editor-specific deep links, configure either:

- `editorUriTemplate` in `~/.config/gno/index.yml`
- `GNO_EDITOR_URI_TEMPLATE` in the environment

Env override wins over YAML config.

If your template uses `{line}` but a result has no line hint, GNO falls back to plain text for that result rather than inventing `:1`.

**Score Interpretation:**

Scores are normalized 0-1 per query. A 0.8 doesn't mean "80% confident" - it means "ranked high relative to other results for this query." Scores are NOT comparable across different queries.

See [How Search Works](HOW-SEARCH-WORKS.md) for full pipeline details.

### "Embed model not cached"

Vector search requires embedding model.

```bash
# Download embed model
gno models pull --embed

# Or all models
gno models pull --all
```

### Code-aware chunking not active

Run `gno doctor` and look for the `code-chunking` check.

- automatic first pass currently applies to `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, and `.rs`
- unsupported extensions fall back to the default markdown chunker
- files without useful structural boundaries also fall back to the default chunker

If search snippets still look oddly split for a supported code file:

1. confirm the file extension is one of the supported code types
2. re-sync the collection
3. use `gno query --explain` to inspect the retrieval path

### Collection model overrides not taking effect

Collection-specific model overrides only apply when the operation resolves a specific collection.

Resolution order:

1. collection role override
2. active preset role
3. built-in default fallback

Checks:

1. confirm the collection name in `index.yml` matches exactly
2. confirm the override is nested under that collection's `models:` block
3. confirm the operation actually targets that collection
4. if a CLI command also passes an explicit `--model`/`--embed-model`/`--rerank-model` style override, that explicit CLI override still wins

### I switched the global preset and vector search looks stale

If `gno models use <preset>` changes the active embedding model:

- old vectors are kept
- GNO now counts backlog/readiness against the new embed model
- vector and hybrid retrieval may look incomplete until embeddings catch up

Fix:

```bash
gno models use quality
gno embed
```

The same idea applies in the Web UI after switching the active preset.

The same logic also applies after upgrading to a release where the built-in
default embedding model changed. Old vectors are kept, but GNO counts backlog
against the new active embed model so the need to re-embed is visible.

The same is true if a release changes the formatting profile for your active
embedding model. If document/query vectors are produced differently after the
upgrade, run `gno embed` again so stored vectors match the new formatter.

`gno doctor` reports this as the `embedding-fingerprint` check. It shows the
current fingerprint, pending/stale chunks, legacy empty-fingerprint vectors, and
stored fingerprint groups. Warnings mean vector search can still run, but you
should re-embed:

```bash
gno doctor
gno embed
```

If doctor still reports stale or mixed vectors after a normal embed, force a
full refresh:

```bash
gno embed --force
```

### I want to remove old embeddings after switching models

Use collection-level cleanup when you want to reclaim space or remove stale
models explicitly:

```bash
gno collection clear-embeddings my-collection         # stale models only
gno collection clear-embeddings my-collection --all   # remove everything
```

Then, if you used `--all`:

```bash
gno embed --collection my-collection
```

### Embedding run says `Object is disposed` or a batch failed partway through

GNO now retries smaller batches, resets the embedding port when node-llama-cpp
disposes a context unexpectedly, and prints sample failures in verbose mode.

The safest retry commands are:

```bash
gno --verbose embed --force
```

or for one collection:

```bash
gno --verbose embed --collection my-collection
```

If you changed embedding formatting/profile behavior for the same model URI,
prefer a full reset first:

```bash
gno collection clear-embeddings my-collection --all
gno embed --collection my-collection
```

### GPU Backend Selection

Before forcing a backend, check what `node-llama-cpp` actually detects on this
machine. This works on Linux, Windows, and macOS and reports the active GPU
backend (CUDA / Vulkan / Metal), available VRAM, and which prebuilt binary is in
use:

```bash
bunx --bun node-llama-cpp inspect gpu
```

(`npx --no node-llama-cpp inspect gpu` works too.) Read the result before
reaching for `GNO_LLAMA_GPU`:

- If CUDA or Vulkan shows as `available` here but GNO still runs on CPU, the
  backend is being selected or initialized incorrectly — continue below.
- If it does _not_ show as available, the GPU driver/toolchain is the problem,
  not GNO (e.g. missing CUDA runtime, no WSL GPU passthrough, stale Vulkan ICD).

Set `GNO_LLAMA_GPU` to force a local backend while debugging runtime issues.
`GNO_LLAMA_GPU` takes precedence over `NODE_LLAMA_CPP_GPU`.

```bash
GNO_LLAMA_GPU=metal gno embed --yes
GNO_LLAMA_GPU=vulkan gno doctor --json
GNO_LLAMA_GPU=false gno embed --yes
```

Accepted values: `auto`, `metal`, `vulkan`, `cuda`, `false`, `off`, `none`,
`disable`, `disabled`, `0`. If an explicit GPU backend fails during init, GNO
warns once and retries CPU. On Windows, GNO also retries CPU when automatic
backend selection fails, because broken Vulkan/CUDA probes can otherwise fall
into native build tooling.

GNO uses prebuilt `node-llama-cpp` backends by default and does not source-build
native backends during normal commands. If you intentionally want local source
build fallback, set:

```bash
GNO_LLAMA_BUILD=autoAttempt gno doctor
```

Backend initialization times out after 30 seconds by default. Override only for
debugging:

```bash
GNO_LLAMA_INIT_TIMEOUT_MS=60000 gno doctor
```

CPU embedding uses a small adaptive context pool. On Windows, GNO keeps one
context below 16GB RAM and uses at most two contexts from 16GB upward. Override
only if you have headroom and `bench:cpu-embeddings -- --real` shows a gain:

```bash
GNO_EMBED_CONTEXTS=2 gno embed --yes
```

## Model Issues

### Downloaded Model Is Not GGUF

GNO validates the first bytes of every local GGUF model before loading it. If a
cached Hugging Face download is actually HTML or another non-GGUF response, GNO
removes the bad cache entry and reports whether it looked like proxy, firewall,
or captive portal interception.

Recovery:

```bash
gno models pull --force --all
gno doctor
```

Explicit `file:` and absolute model paths are validated too, but GNO never
deletes user-owned model files. Replace the file with a real `.gguf` export if
the error names a user path.

### Large Document Or Native Embedding Failure

GNO chunks large documents before embedding and clamps oversized direct
embedding inputs to the active model context when tokenizer metadata is
available. If native inference still fails on a pathological document, run:

```bash
gno update
gno embed --force --verbose
```

Check the sample error path, then split the document or remove generated
single-line blobs from the collection.

### Models Fail to Download

```bash
# Check network
ping huggingface.co

# Check disk space
df -h

# Clear and retry
gno models clear
gno models pull --all
```

### Model Load Timeout

Models may take time to load first time.

```bash
# Increase timeout in config
# models:
#   loadTimeout: 120000  # 2 minutes
```

### Out of Memory

Large models need RAM. Try smaller preset:

```yaml
# In config
models:
  activePreset: slim-tuned
```

## Database Issues

### "Database locked"

Another process has the database open.

```bash
# Find processes
lsof ~/.local/share/gno/*.sqlite

# Or wait and retry
```

### Corrupted Database

```bash
# Reset database (loses indexed data)
gno reset --confirm

# Re-index
gno update
```

### Retrieval trace migration or replay failed

Private retrieval receipts use schema migration v14. Opening a v12 or v13
index applies the remaining migrations and the trace tables in one
transaction. A failed upgrade leaves the previous schema version and existing
documents intact; it does not leave a partial trace schema.

Before moving an important index between GNO versions, stop its resident
`serve`/`daemon` owner and back up the active SQLite database together with any
`-wal` and `-shm` companions. Do not copy a live database. GNO does not expose
an in-place migration downgrade command. Existing receipts can be exported or
removed with `gno trace` even after new recording is disabled.

Replay failures are deliberately fail-closed:

- `manifest_missing` or `manifest_hash_mismatch`: the saved aggregate export
  is absent or its linked membership changed; create a fresh export from the
  intended terminal traces.
- `trace_missing`: retention or deletion removed a linked receipt.
- `redaction_incompatible`, `query_missing`, or `filters_incomplete`: the
  receipt is diagnostic-only or lacks the replay inputs; record a new trace
  with explicit `replay` consent.
- `source_stale`, `source_missing`, `inactive`, or `no_indexed_content`: inspect
  the reported source state, re-index if appropriate, then deliberately create
  a new baseline. Do not silently treat changed evidence as equivalent.

### Trace purge reports `wal_busy` or `failed`

Full purge deletes trace rows transactionally first, then separately attempts
secure physical cleanup and a truncating WAL checkpoint. Only
`physicalCleanup: "completed"` confirms that the WAL was truncated.

`wal_busy` usually means another reader still holds a database snapshot. Close
other GNO/SQLite readers and run `gno --yes trace purge --json` again.
`failed` means the checkpoint itself could not be verified; preserve the
receipt, stop the resident owner, check filesystem permissions and free space,
then retry. User-created export files and external backups are not owned by the
database purge and must be removed separately.

## MCP Issues

### "Tool not found" in Claude

GNO not properly configured.

1. Check global installation:

   ```bash
   which gno
   ```

2. Verify config path:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

3. Restart Claude Desktop

### MCP Server Not Responding

```bash
# Test manually
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | gno mcp
```

Should return valid JSON-RPC response.

## Permission Issues

### Cannot Write Config

```bash
# Check directory permissions
ls -la ~/.config/gno
ls -la ~/.local/share/gno

# Fix permissions
chmod 755 ~/.config/gno
chmod 755 ~/.local/share/gno
```

### Cannot Write Models

```bash
# Check cache directory
ls -la ~/.cache/gno  # Linux
ls -la ~/Library/Caches/gno  # macOS

# Fix permissions
chmod 755 ~/.cache/gno
```

## Debug Mode

Enable verbose logging:

```bash
# CLI verbose mode
gno --verbose search "test"

# Environment variable
GNO_VERBOSE=1 gno search "test"

# MCP debug
GNO_VERBOSE=1 gno mcp
```

## Getting Help

1. Run `gno doctor --json` and share output
2. Check [GitHub Issues](https://github.com/gmickel/gno/issues)
3. Include version: `gno --version`

## Common Error Messages

| Error                       | Solution                           |
| --------------------------- | ---------------------------------- |
| "missing required argument" | Check command usage with `--help`  |
| "unknown command"           | Check spelling, run `gno --help`   |
| "collection already exists" | Use different name or remove first |
| "invalid path"              | Use absolute path                  |
| "database not initialized"  | Run `gno init`                     |
| "model not cached"          | Run `gno models pull`              |
