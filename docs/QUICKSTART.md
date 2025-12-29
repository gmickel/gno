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
# Index all configured collections
gno update
```

GNO indexes Markdown, PDF, DOCX, XLSX, PPTX, and plain text.

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
gno update
```

### Re-Index After Changes

```bash
gno update
```

Only changed files are re-indexed.

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

## Example Session

```bash
# Setup
gno init ~/notes --name notes
gno update

# Search
gno search "meeting notes"
gno vsearch "project timeline concerns"
gno query "what did we decide about the API"

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
