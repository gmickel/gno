---
title: Quickstart
description: Get from local folders to hybrid search, browse, graph, and AI answers with GNO in under five minutes.
keywords: gno quickstart, local rag quickstart, semantic search quickstart, note search quickstart
---

# Quickstart

Get from local folders to hybrid search, workspace browsing, and AI answers in under 5 minutes.

> **Prerequisites**: See [Installation](INSTALLATION.md) for setup. Run `gno doctor` to verify.

## 1. Initialize with Your Notes

```bash
# Initialize GNO with your notes folder
gno init ~/notes --name notes

# Or initialize with a specific pattern
gno init ~/Documents --name docs --pattern "**/*.md"
```

This creates your config and sets up the first collection.

Prefer a guided UI first? Start `gno serve`, open `http://localhost:3000`, then use the first-run checklist to add a folder, choose a preset, and start indexing without touching more CLI commands.

## 2. Index Your Documents

```bash
# Full index: ingest files + generate embeddings
gno index
```

This runs both BM25 (keyword) and vector indexing. GNO indexes Markdown, PDF, DOCX, XLSX, PPTX, and plain text.

Password-protected PDFs and XLSX files are reported as per-file errors and do
not stop the rest of indexing.

> **Note**: On first run, GNO may download local models (embedding ~500MB; optional rerank/gen models can add ~700MB-1.2GB). Subsequent runs use cache. To avoid startup downloads, set `GNO_NO_AUTO_DOWNLOAD=1` and run `gno models pull` explicitly.

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

### Explore Links

Documents can link to each other using wiki links (`[[Note]]`), markdown links (`[text](path.md)`), and Logseq-compatible variants like `[text]([[Note]])` and `&#123;&#123;embed [[Note]]&#125;&#125;`. GNO tracks these relationships:

```bash
# Show links FROM a document
gno links my-note.md

# Show documents linking TO this document (backlinks)
gno backlinks my-note.md

# Find semantically similar documents
gno similar my-note.md
```

### Query Typed Relationships

Add typed relationships with `relations:` frontmatter:

```yaml
relations:
  works_at: [gno://notes/companies/acme.md]
  attended: [gno://notes/meetings/weekly-sync.md]
```

Then traverse or debug the relationship layer:

```bash
gno graph query gno://notes/people/alice.md --edge-type works_at --max-depth 2
gno links gno://notes/people/alice.md --edge-type works_at
gno query diagnose "Alice Acme" --target gno://notes/people/alice.md --json
```

### Re-Index After Changes

```bash
# Full re-index (sync + embeddings)
gno index

# Re-index one collection only
gno index projects

# Or just sync files without re-embedding (faster)
gno update
```

**Incremental by default**: GNO tracks file content via SHA-256 hashes. When you run `gno index` or `gno update`:

- **New files** → indexed
- **Modified files** → re-indexed
- **Unchanged files** → skipped (instant)

This makes re-indexing fast even for large collections. Just run `gno index` after adding or editing files.

### Capture New Notes

Use `gno capture` for quick second-brain entries with provenance metadata:

```bash
gno capture "thought to remember"
gno capture --file ./clip.md --source-url https://example.com --source-kind web --json
gno capture --preset person --title "Jane Doe" --folder people/
gno capture --preset meeting --title "Weekly sync" --folder meetings/
```

Generated captures land under `inbox/YYYY-MM-DD/capture-<body-hash>.md` in UTC.
The JSON receipt reports the file write, sync status, and embed status
separately; capture does not imply embedding unless the receipt says embedding
completed.

Use `idea-original`, `person`, `company-project`, or `meeting` when the note is a
typed second-brain page. Those presets keep current synthesis above
`## Timeline` and dated evidence or raw notes below it. If you configure
`contentTypes` in `index.yml`, matching `type` frontmatter or folder prefixes are
indexed as `contentType` and show up in JSON search/query results.

In the Web UI, press **N** for Quick Capture. Basic capture is still title plus
content; choose a preset when you want a scaffold, and open **Source** to add
provenance fields. The success view reports the same write, FTS sync, and embed
states as the CLI/API receipt.

If you want continuous indexing instead of manual re-runs:

```bash
gno daemon            # foreground (Ctrl+C to stop)
gno daemon --detach   # background (macOS/Linux); use --status / --stop to manage
```

`--detach` self-backgrounds, prints the child PID, and exits 0. Manage the
detached process with `gno daemon --status` and `gno daemon --stop`.

Need the full behavior, lifecycle controls, and troubleshooting guide? See
[Daemon Mode](DAEMON.md).

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

- First-run onboarding and health center
- Dashboard with index stats
- Visual search with highlighted results
- Document browser with collection filtering
- Rendered document viewer with syntax highlighting

Prefer a headless process instead? Run `gno daemon` to keep the index fresh
without opening the Web UI.

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
