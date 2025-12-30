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

Use GNO as a knowledge base for AI assistants like Claude Code, Codex, or any MCP-compatible agent.

### Option 1: Skill Installation (Recommended)

Install GNO as a skill for Claude Code or Codex:

```bash
# Install for Claude Code (project scope)
gno skill install

# Install for user-wide access
gno skill install --scope user

# Install for Codex
gno skill install --target codex

# Install for both
gno skill install --target all --scope user
```

After installation, restart your agent. It will automatically detect the GNO skill and can search your indexed documents.

**What gets installed:**
- `SKILL.md` - Instructions for the agent on how to use GNO
- Tool definitions for search, query, and document retrieval

### Option 2: MCP Server

For Claude Desktop or Cursor, run GNO as an MCP server:

```bash
gno mcp
```

See [MCP Integration](MCP.md) for detailed setup.

### Workflow Patterns

**Research-then-answer:**
> "Search my notes for anything about the authentication system, then help me debug this login issue"

**Documentation lookup:**
> "Find my API docs and show me how the /users endpoint works"

**Cross-reference:**
> "Search for all mentions of 'database migration' across my projects"

**Memory/recall:**
> "What did I write last week about the deployment pipeline?"

### Best Practices

1. **Index relevant collections** - Only index what the agent needs
2. **Use contexts** - Add semantic hints for better relevance
3. **Keep indexes updated** - Run `gno update` regularly or use `--git-pull`
4. **Scope searches** - Use collection names to focus agent queries

## Git Integration

Keep collections in sync with git repositories.

### Auto-Pull Before Indexing

Use `--git-pull` to fetch latest changes:

```bash
gno update --git-pull
```

This runs `git pull` in every collection that's a git repository before indexing.

### Collection-Level Update Commands

Configure collections to run custom commands before indexing:

```yaml
# In config
collections:
  - name: wiki
    path: /Users/you/wiki
    updateCmd: "git pull origin main"

  - name: docs
    path: /Users/you/docs
    updateCmd: "git pull && npm run build-docs"
```

The `updateCmd` runs in the collection's root directory.

### Automation

Combine with cron or scheduled tasks:

```bash
# Daily index update with git pull
0 6 * * * cd ~ && gno update --git-pull --yes
```

## Multi-Language Search

GNO supports 30+ languages with automatic detection.

### Setup Language Hints

For collections in a specific language, set `languageHint`:

```bash
gno collection add ~/docs/german --name de-docs --language de
gno collection add ~/docs/french --name fr-docs --language fr
```

Or in config:

```yaml
collections:
  - name: de-docs
    path: /Users/you/docs/german
    languageHint: de
```

### Query Language Detection

GNO auto-detects query language using [franc](https://github.com/wooorm/franc). Searches in German automatically use German-optimized expansion prompts.

### Multilingual Embedding

The default bge-m3 embedding model supports 100+ languages. Vector search works across languages - a German query can find relevant English documents and vice versa.

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
