# GNO vs Obsidian Search

A comparison of GNO with Obsidian's built-in search.

**Key insight**: GNO and Obsidian can work together. Both offer note editing, but Obsidian excels at visual linking and graph exploration while GNO adds AI-powered search and external CLI/MCP access.

## Quick Summary

| Aspect              | GNO                                     | Obsidian Search         |
| ------------------- | --------------------------------------- | ----------------------- |
| **Purpose**         | Search & AI access                      | Note-taking app         |
| **Unique strength** | MCP/Skills, CLI, graph+similarity edges | Visual editing, plugins |
| **Works with**      | Any folder                              | Obsidian vaults only    |

## Feature Comparison

| Feature                | GNO                          | Obsidian Search   |
| ---------------------- | ---------------------------- | ----------------- |
| **Semantic Search**    | ✓ Vector + rerank            | Plugin-dependent  |
| **File Formats**       | MD, PDF, DOCX, etc.          | Markdown only     |
| **AI Integration**     | MCP, Skills, RAG             | Plugin-dependent  |
| **External Access**    | CLI, MCP server              | Obsidian app only |
| **Works With**         | Any folder structure         | Obsidian vaults   |
| **Graph View**         | ✓ With similarity edges      | ✓ Links only      |
| **Backlinks**          | ✓ CLI + Web UI               | ✓                 |
| **Similar Notes**      | ✓ Vector similarity          | Plugin-dependent  |
| **Graph + Similarity** | ✓ Visual similarity clusters | ✗                 |
| **Note Editing**       | ✓ `gno serve`                | ✓                 |
| **Plugins**            | MCP ecosystem                | Obsidian plugins  |
| **REST API**           | ✓ `gno serve`                | ✗                 |
| **Web UI**             | ✓ `gno serve`                | ✓ (Obsidian app)  |

## Complementary Workflow

GNO works **with** Obsidian, not instead of it:

```bash
# 1. Take notes in Obsidian (your vault at ~/Documents/Obsidian)

# 2. Index your vault with GNO
gno init ~/Documents/Obsidian --name vault
gno index

# 3. Search via CLI
gno query "what were my notes about project planning"

# 4. Get AI answers from your notes
gno ask "summarize my meeting notes from last week" --answer

# 5. Let Claude search your vault
gno mcp install --target claude
# Now Claude can search your Obsidian notes
```

## When to Use GNO (with Obsidian)

**CLI search**: Quick searches without opening Obsidian.

```bash
# Search from terminal
gno query "authentication best practices"
```

**AI agent access**: Let Claude, Cursor, or other AI tools search your notes.

```bash
# Install MCP for your tool
gno mcp install --target cursor

# Now your AI assistant can search your Obsidian vault
```

**RAG answers**: Get AI-generated answers with citations from your notes.

```bash
gno ask "what is our team's deployment process" --answer
```

**Multi-format search**: Search PDFs and docs alongside your markdown notes.

```bash
# Index everything in your vault, including attachments
gno init ~/Documents/Obsidian --name vault
gno index
gno query "contract terms"  # finds in PDFs too
```

**Automation**: Script searches in your workflows.

```bash
# Find related notes programmatically
gno query "project alpha" --format json | jq '.results[].path'
```

## When to Use Obsidian Search

**Visual exploration**: Graph view with interactive features, Canvas.

**Note editing**: Rich note-taking with full plugin ecosystem.

**Obsidian plugins**: Plugin-specific features (Dataview, Canvas, Excalidraw, etc.).

**Quick vault navigation**: Opening notes by name, quick switcher.

## Integration Setup

### Index Your Obsidian Vault

```bash
# Install GNO
bun install -g @gmickel/gno

# Initialize with your vault
gno init ~/Documents/Obsidian --name vault

# Index all notes
gno index
```

### Enable AI Access

```bash
# For Claude Desktop
gno mcp install --target claude

# For Cursor
gno mcp install --target cursor

# For Claude Code
gno mcp install --target claude-code
```

### Search Examples

```bash
# Semantic search
gno query "ideas for improving user onboarding"

# Find specific topics
gno query "meeting notes about Q4 planning"

# Get AI answers
gno ask "what were the action items from the team sync" --answer
```

## Best of Both Worlds

| Task                       | Use      |
| -------------------------- | -------- |
| Take notes                 | Both     |
| Edit notes                 | Both     |
| Visual graph exploration   | Both     |
| Backlinks and outlinks     | Both     |
| Similar notes discovery    | Both     |
| Quick search from terminal | GNO      |
| AI agent access to notes   | GNO      |
| RAG answers                | GNO      |
| Search PDFs in vault       | GNO      |
| Script/automate search     | GNO      |
| Obsidian plugins           | Obsidian |
| Canvas/Excalidraw          | Obsidian |

GNO extends Obsidian's capabilities rather than replacing it. Your Obsidian vault becomes searchable from anywhere (terminal, AI assistants, scripts) while Obsidian remains your note-taking home.

Both now support graph views, backlinks, and outgoing links—but GNO adds CLI access (`gno links`, `gno backlinks`, `gno similar`, `gno graph`) and REST API endpoints for programmatic use.
