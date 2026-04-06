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

## Exit Codes

| Code | Meaning          | Common Causes                  |
| ---- | ---------------- | ------------------------------ |
| 0    | Success          | Command completed              |
| 1    | Validation error | Bad arguments, missing options |
| 2    | Runtime error    | IO, database, model failures   |

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

### Bun Version Too Old

```bash
# Check version
bun --version

# Update Bun
bun upgrade
```

## Indexing Issues

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

If you add/remove collections or change patterns while it is running:

```bash
# Stop the daemon (Ctrl+C if foreground)
# Then restart
gno daemon
```

### "Daemon is running but nothing updates"

Check:

```bash
gno collection list
gno ls
```

Common causes:

- no collections configured
- file changes happened outside configured patterns
- the daemon was started with `--no-sync-on-start` and is only watching future changes

### "I ran gno serve and gno daemon together"

Current guidance: do not run both against the same index at the same time.

Until explicit cross-process coordination exists, use one of:

- `gno serve` for browser/desktop sessions
- `gno daemon` for headless continuous indexing

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

### Force CPU-only for testing

To disable Metal/CUDA/Vulkan and force `node-llama-cpp` onto the CPU backend
for a repro or benchmark:

```bash
NODE_LLAMA_CPP_GPU=false gno doctor --json
NODE_LLAMA_CPP_GPU=false gno embed --yes
```

Accepted values: `false`, `off`, `none`, `disable`, `disabled`.

If your machine only has GPU-backed `node-llama-cpp` binaries cached, the first
CPU-only run may build or download a separate CPU backend. For throughput
measurements, ignore that first run and time the second.

## Model Issues

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
