# GNO Usage Examples

Real-world examples for common tasks.

## Getting Started

### Index a folder of docs

```bash
# Initialize
gno init

# Add your docs folder
gno collection add ~/Documents/work --name work

# Build index
gno index
```

### Index multiple folders

```bash
gno init
gno collection add ~/notes --name notes --pattern "**/*.md"
gno collection add ~/work/contracts --name contracts --pattern "**/*.{pdf,docx}"
gno index
```

## Searching

### Find by keywords

```bash
# Simple search
gno search "quarterly report"

# More results
gno search "budget" -n 20

# Filter to collection
gno search "NDA" -c contracts
```

### Find by meaning (semantic)

```bash
# Semantic search finds related concepts
gno vsearch "how to cancel subscription"

# Even if docs say "terminate agreement"
gno vsearch "end contract early"
```

### Best quality search

```bash
# Hybrid combines keywords + semantics + reranking
gno query "deployment process"

# See how results were found
gno query "deployment" --explain
```

## Getting Answers

### Q&A with citations

```bash
# Just retrieve relevant chunks
gno ask "what are the payment terms"

# Get an AI-generated answer
gno ask "what are the payment terms" --answer
```

### Scoped answers

```bash
# Search only contracts
gno ask "termination clause" -c contracts --answer

# Limit answer length
gno ask "summarize project goals" --answer --max-answer-tokens 200
```

## Reading Documents

### Get full document

```bash
# By URI
gno get gno://work/readme.md

# By document ID
gno get "#a1b2c3d4"

# With line numbers
gno get gno://notes/meeting.md --line-numbers
```

### Get specific lines

```bash
# Start at line 50
gno get gno://work/report.md --from 50

# Get 20 lines starting at 100
gno get gno://work/report.md --from 100 -l 20
```

### List documents

```bash
# All documents
gno ls

# In a collection
gno ls work

# As JSON
gno ls --json
```

## JSON Output (Scripting)

### Search results to JSON

```bash
# Get URIs of matches
gno search "api endpoint" --json | jq '.[] | .uri'

# Get snippets
gno search "config" --json | jq '.[] | {uri, snippet}'
```

### Check index health

```bash
# Get stats
gno status --json | jq '{docs: .totalDocuments, chunks: .totalChunks}'

# Run diagnostics
gno doctor --json
```

### Batch processing

```bash
# Export all document IDs
gno ls --json | jq -r '.[].docid' > doc-ids.txt

# Search and process results
gno search "error" --json | jq -r '.[] | .uri' | while read uri; do
  echo "Processing: $uri"
  gno get "$uri" > "output/$(basename $uri)"
done
```

## Maintenance

### Update index after changes

```bash
# Sync files from disk
gno update

# Full re-index
gno index
```

### Git integration

```bash
# Pull and re-index
gno index --git-pull

# Useful for docs repos
gno update --git-pull
```

### Model management

```bash
# List models and status
gno models list

# Switch to quality preset
gno models use quality

# Download models
gno models pull
```

## Tips

### Search Modes

| Command | Time | Use When |
|---------|------|----------|
| `gno search` | instant | Exact keyword matching |
| `gno vsearch` | ~0.5s | Finding similar concepts |
| `gno query --fast` | ~0.7s | Quick lookups |
| `gno query` | ~2-3s | Default, balanced |
| `gno query --thorough` | ~5-8s | Best recall, complex queries |

**Agent retry strategy**: Use default mode first. If no results:
1. Rephrase the query (free, often helps)
2. Try `--thorough` for better recall

### Output formats

```bash
# Human readable (default)
gno search "query"

# JSON (scripting)
gno search "query" --json

# File list (for piping)
gno search "query" --files

# CSV (spreadsheets)
gno search "query" --csv

# Markdown (docs)
gno search "query" --md
```

### Large result sets

```bash
# Increase limit
gno search "common term" -n 50

# Filter by score
gno search "common term" --min-score 0.7

# Get full content
gno search "term" --full
```
