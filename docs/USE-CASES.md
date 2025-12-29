# Use Cases

Real-world workflows for common scenarios.

## Personal Notes

Index and search your note-taking system.

### Setup

```bash
# Initialize with notes folder
gno init ~/notes --name notes --pattern "**/*.md"

# Index
gno update
```

### Daily Workflow

```bash
# Find what you wrote about a topic
gno search "project meeting decisions"

# Semantic search for ideas
gno vsearch "how to improve productivity"

# Get AI summary
gno ask "what did I decide about the API design" --answer
```

### Tips

- Use `--exclude` for template or boilerplate folders
- Add contexts for different note types (work, personal)

## Code Documentation

Index project docs alongside code.

### Setup

```bash
gno init ~/projects/myapp/docs --name myapp-docs --pattern "**/*.md"
gno init ~/projects/myapp/src --name myapp-code --pattern "**/*.ts" --exclude node_modules,dist
gno update
```

### Searching

```bash
# Find API documentation
gno search "authentication endpoint"

# Find code examples
gno search "handleError" --lang typescript

# Cross-reference docs and code
gno query "how does the auth flow work"
```

## Research Papers

Index academic papers and references.

### Setup

```bash
gno init ~/papers --name research --pattern "**/*.pdf"
gno update
```

PDF extraction creates searchable text.

### Workflow

```bash
# Find papers on a topic
gno search "machine learning optimization"

# Semantic similarity
gno vsearch "neural network architectures for NLP"

# Get full paper content
gno get <docid>
```

## Meeting Transcripts

Index transcripts from meetings.

### Setup

```bash
gno init ~/meetings --name meetings --pattern "**/*.md"
gno update
```

### Searching Decisions

```bash
# Find action items
gno search "action items" --full

# Find discussions about a topic
gno query "budget discussion Q4"

# Get AI summary
gno ask "what did we decide about the timeline" --answer
```

## Multi-Project Setup

Manage multiple collections.

### Setup

```bash
# Add work projects
gno collection add ~/work/project-a --name project-a
gno collection add ~/work/project-b --name project-b

# Add personal notes
gno collection add ~/notes --name personal

# Index all
gno update
```

### Scoped Searches

Use contexts to scope searches:

```bash
# Add context for work
gno context add "project-a:" "Backend API project"
gno context add "project-b:" "Frontend React app"
gno context add "personal:" "Personal notes and journal"
```

## AI Agent Integration

Use GNO as a knowledge base for AI assistants.

### Setup

See [MCP Integration](MCP.md) for Claude Desktop/Cursor setup.

### Patterns

1. **Research**: Ask the AI to search for context before answering
2. **Documentation**: Let AI reference your docs when coding
3. **Memory**: Use indexed notes as persistent memory

Example prompts:

> "Search my notes for anything about the authentication system, then help me debug this login issue"

> "Find my project requirements and suggest implementation approach"

## Incremental Updates

GNO only re-indexes changed files.

```bash
# After editing files
gno update

# Check what's indexed
gno status
```

## Backup and Sync

GNO stores data in standard locations:

- Config: `~/.config/gno/`
- Database: `~/.local/share/gno/`
- Models: `~/.cache/gno/` (can be re-downloaded)

### Backup

```bash
# Backup config and database
cp -r ~/.config/gno ~/backup/gno-config
cp -r ~/.local/share/gno ~/backup/gno-data
```

### Restore

```bash
# Restore on new machine
cp -r ~/backup/gno-config ~/.config/gno
cp -r ~/backup/gno-data ~/.local/share/gno

# Re-download models
gno models pull --all
```

### Git Sync

You can version-control the config:

```bash
cd ~/.config/gno
git init
git add .
git commit -m "GNO config"
```

The database should not be version-controlled (binary, large).
