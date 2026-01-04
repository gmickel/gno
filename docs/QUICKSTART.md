# Quickstart

Get searching in under 5 minutes.

> **Prerequisites**: See [Installation](INSTALLATION.md) for setup. Run `gno doctor` to verify.

## 1. Initialize with Your Notes

```bash
# Initialize GNO with your notes folder
gno init ~/notes --name notes

# Or initialize with a specific pattern
gno init ~/Documents --name docs --pattern "**/*.md"
```

This creates your config and sets up the first collection.

## 2. Index Your Documents

```bash
# Full index: ingest files + generate embeddings
gno index
```

This runs both BM25 (keyword) and vector indexing. GNO indexes Markdown, PDF, DOCX, XLSX, PPTX, and plain text.

> **Note**: On first run, GNO automatically downloads the required embedding model (~80MB). Subsequent runs use the cached model.

Check what's indexed:

```bash
gno ls
```

## 3. Search Your Knowledge

### Full-Text Search (BM25)

```bash
gno search "project deadlines"
```

### Vector Search (Semantic)

```bash
gno vsearch "how to handle errors"
```

### Hybrid Search (Best of Both)

```bash
gno query "authentication best practices"
```

### Get AI Answers

```bash
gno ask "what is the main goal of project X" --answer
```

## Output Formats

Default output is terminal-friendly. For scripting:

```bash
# JSON output
gno search "important" --json

# Just file URIs
gno search "important" --files

# CSV
gno search "important" --csv

# Markdown
gno search "important" --md
```

## Common Workflows

### Add Another Collection

```bash
gno collection add ~/work/projects --name projects --pattern "**/*.md"
gno index
```

### Tag Your Documents

Tags are extracted from markdown frontmatter automatically. You can also manage them via CLI:

```bash
# List all tags
gno tags

# Add tags to a document
gno tags add abc123 work project/alpha

# Remove a tag
gno tags rm abc123 draft

# Search with tag filters
gno query "auth" --tags-all backend,security
gno query "meeting" --tags-any urgent,priority
```

### Re-Index After Changes

```bash
# Full re-index (sync + embeddings)
gno index

# Or just sync files without re-embedding (faster)
gno update
```

**Incremental by default**: GNO tracks file content via SHA-256 hashes. When you run `gno index` or `gno update`:

- **New files** → indexed
- **Modified files** → re-indexed
- **Unchanged files** → skipped (instant)

This makes re-indexing fast even for large collections. Just run `gno index` after adding or editing files.

### Check System Health

```bash
gno doctor
```

### View Indexed Documents

```bash
# List all documents
gno ls

# As JSON
gno ls --json

# Get specific document content
gno get <docid>
```

## Web UI

Prefer a visual interface? Start the web server:

```bash
gno serve
```

Open http://localhost:3000 in your browser for:

- Dashboard with index stats
- Visual search with highlighted results
- Document browser with collection filtering
- Rendered document viewer with syntax highlighting

## Example Session

```bash
# Setup
gno init ~/notes --name notes
gno index

# Search (CLI)
gno search "meeting notes"
gno vsearch "project timeline concerns"
gno query "what did we decide about the API"

# Or use the web UI
gno serve

# Get details
gno ls --json | head
gno get abc123

# AI answer
gno ask "summarize the authentication discussion" --answer
```

## Next Steps

- [CLI Reference](CLI.md) - All commands and options
- [Configuration](CONFIGURATION.md) - Customize collections and models
- [Use Cases](USE-CASES.md) - Real-world workflows
- [Troubleshooting](TROUBLESHOOTING.md) - Common issues
