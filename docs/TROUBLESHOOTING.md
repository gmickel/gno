# Troubleshooting

Common issues and solutions.

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

| Code | Meaning | Common Causes |
|------|---------|---------------|
| 0 | Success | Command completed |
| 1 | Validation error | Bad arguments, missing options |
| 2 | Runtime error | IO, database, model failures |

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

| Symptom | Cause | Fix |
|---------|-------|-----|
| High BM25, low vector | Query too keyword-specific | Use `gno query` not `gno search` |
| Low BM25, high vector | Query too abstract | Add specific keywords |
| Good scores, wrong order | Fusion needs tuning | Use `gno query` (reranking on by default) |
| All low scores | Content not indexed | Check `gno ls`, re-index |

**Improve Results:**

1. **Add contexts** - Semantic hints improve relevance
2. **Use reranking** - `gno query` has reranking on by default (slower but better)
3. **Choose right mode:**
   - `gno search` - Exact keyword matching
   - `gno vsearch` - Conceptual/semantic matching
   - `gno query` - Combined (usually best)
4. **Adjust min-score** - Filter low-confidence results: `--min-score 0.3`
5. **Try expansion** - Query expansion is on by default, disable with `--no-expand` if getting off-topic results

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
  activePreset: slim
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

| Error | Solution |
|-------|----------|
| "missing required argument" | Check command usage with `--help` |
| "unknown command" | Check spelling, run `gno --help` |
| "collection already exists" | Use different name or remove first |
| "invalid path" | Use absolute path |
| "database not initialized" | Run `gno init` |
| "model not cached" | Run `gno models pull` |
