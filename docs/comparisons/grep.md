# GNO vs grep/ripgrep

A comparison of GNO with traditional text search tools like `grep` and `ripgrep` (rg).

grep and ripgrep are excellent for exact pattern matching in code. GNO adds semantic understanding for knowledge-base search.

## Quick Summary

| Aspect | GNO | grep/rg |
|--------|-----|---------|
| **Best for** | Knowledge base, documents | Code search, exact patterns |
| **Unique strength** | Find concepts, not just strings | Fast regex, pipeline-friendly |
| **Learning curve** | Minutes | Minutes (regex mastery takes longer) |

## Feature Comparison

| Feature | GNO | grep/rg |
|---------|-----|---------|
| **Search Type** | Semantic + keyword | Keyword/regex only |
| **"Find concept"** | ✓ Vector similarity | ✗ Must know exact terms |
| **PDF/DOCX** | ✓ Native | ✗ Text only |
| **Ranking** | Relevance-scored | Line matches |
| **AI Integration** | MCP, Skills, RAG | Manual piping |
| **Index** | Persistent, incremental | None (scan every time) |
| **Speed (large corpus)** | Fast (indexed) | Slow (full scan) |
| **Regex** | Basic patterns | Full regex power |
| **Pipeline** | JSON output | Native stdin/stdout |

### Planned Features

| Feature | GNO | grep/rg |
|---------|-----|---------|
| **Web UI** | ✓ `gno serve` | ✗ |
| **Tab Completion** | 🔜 Shell integration | ✓ Built-in |

## The Key Difference

**grep finds strings. GNO finds meaning.**

```bash
# grep: must know exact terms
grep -r "authentication" ./docs
grep -r "auth" ./docs
grep -r "login" ./docs
grep -r "sign in" ./docs

# GNO: finds all related concepts
gno query "how does authentication work"
```

GNO's semantic search understands that "authentication", "login", "sign in", and "auth" are related concepts.

## When to Use GNO

**Concept search**: You're looking for ideas, not exact strings.

```bash
# Find discussions about error handling approaches
gno query "how to handle errors gracefully"

# Find anything related to performance optimization
gno query "making the app faster"
```

**Document formats**: You have PDFs, Word docs, spreadsheets.

```bash
# Search across all your documents
gno init ~/Documents --name docs
gno index
gno query "Q4 budget projections"
```

**AI workflows**: You want AI agents to search your knowledge base.

```bash
# Let Claude search your docs
gno mcp install --target claude

# Get AI-generated answers
gno ask "what is our deployment process" --answer
```

**Knowledge base**: You're building a searchable second brain.

```bash
# Index notes, papers, meeting transcripts
gno init ~/notes --name notes
gno query "what did we decide about the API redesign"
```

## When to Use grep/ripgrep

**Exact patterns**: You know the exact string or regex.

```bash
# Find all TODO comments
rg "TODO:" --type rust

# Find function definitions
rg "^func \w+" --type go
```

**Code search**: Searching source code for symbols and patterns.

```bash
# Find all uses of a function
rg "handleError\(" src/

# Find import statements
rg "^import.*from" --type ts
```

**Pipeline scripts**: Chaining tools in shell pipelines.

```bash
# Count occurrences per file
rg -c "error" | sort -t: -k2 -rn

# Extract and process matches
rg -o "v\d+\.\d+\.\d+" | sort -u
```

**One-off queries**: Quick searches where indexing isn't worth it.

```bash
# Quick check in a small directory
rg "config" ./settings/
```

## Complementary Usage

Use both tools together:

```bash
# Use GNO for semantic search across docs
gno query "authentication best practices"

# Use rg for exact code search
rg "AuthProvider" src/

# Use GNO for AI-powered answers
gno ask "how do we authenticate users" --answer
```

## Getting Started with GNO

If you're comfortable with grep/ripgrep, GNO is easy to add:

```bash
# Install
bun install -g @gmickel/gno

# Initialize and index
gno init ~/notes --name notes
gno index

# Search semantically
gno query "your search query"

# Or use hybrid mode (semantic + keyword)
gno query "your search query" --mode hybrid
```

Both tools have their place. grep/ripgrep excels at exact pattern matching in code. GNO excels at finding concepts in documents and knowledge bases.
