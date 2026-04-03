# GNO vs Obsidian Search

If you are comparing GNO to Obsidian, the real question is no longer just "search quality." It is whether you want a note app with a huge plugin ecosystem, or a local knowledge workspace built around retrieval, graph navigation, safe editing, and agent access.

**Key insight**: GNO and Obsidian can work together today, but GNO is now credible as a markdown-first local workspace for people who care more about retrieval, AI access, and multi-surface workflows than plugin sprawl. Obsidian still leads on plugins, Canvas, and broad note-app customization. GNO leads on hybrid retrieval, external access, safe multi-format handling, and local agent workflows.

## At a Glance

- Choose **Obsidian** if your workflow depends on its plugin ecosystem, Canvas, Dataview, or Excalidraw.
- Choose **GNO** if you want better search, safer multi-format indexing, CLI/API access, graph exploration, and direct integration with coding agents.
- Use **both** if Obsidian remains your editor of choice but you want a much stronger local search/agent layer on top of the same vault.

## Quick Summary

| Aspect              | GNO                                     | Obsidian Search         |
| ------------------- | --------------------------------------- | ----------------------- |
| **Purpose**         | Search & AI access                      | Note-taking app         |
| **Unique strength** | MCP/Skills, CLI, graph+similarity edges | Visual editing, plugins |
| **Works with**      | Any folder                              | Obsidian vaults only    |

## Feature Comparison

| Feature                | GNO                                                                   | Obsidian Search      |
| ---------------------- | --------------------------------------------------------------------- | -------------------- |
| **Semantic Search**    | ✓ Vector + rerank                                                     | Plugin-dependent     |
| **File Formats**       | MD, PDF, DOCX, etc.                                                   | Markdown only        |
| **AI Integration**     | MCP, Skills, RAG                                                      | Plugin-dependent     |
| **Remote Inference**   | ✓ Native HTTP config                                                  | ✓ Plugins + CORS cfg |
| **External Access**    | CLI, MCP server                                                       | Obsidian app only    |
| **Works With**         | Any folder structure                                                  | Obsidian vaults      |
| **Graph View**         | ✓ With similarity edges                                               | ✓ Links only         |
| **Backlinks**          | ✓ CLI + Web UI                                                        | ✓                    |
| **Similar Notes**      | ✓ Vector similarity                                                   | Plugin-dependent     |
| **Graph + Similarity** | ✓ Visual similarity clusters                                          | ✗                    |
| **Note Editing**       | ✓ Markdown/plaintext, with safe read-only handling for converted docs | ✓                    |
| **Plugins**            | MCP ecosystem                                                         | Obsidian plugins     |
| **REST API**           | ✓ `gno serve`                                                         | ✗                    |
| **Web UI**             | ✓ `gno serve`                                                         | ✓ (Obsidian app)     |

## Complementary Workflow

GNO works well **with** Obsidian today, and can increasingly replace it for teams that mainly want markdown editing plus agent-friendly retrieval:

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

GNO wins when you need your notes outside the Obsidian app itself.

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

Obsidian wins when the value is in the note app surface itself, not just retrieval.

**Visual exploration**: Graph view with interactive features, Canvas.

**Note editing**: Rich note-taking with full plugin ecosystem and mature plugin workflows.

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

If you prefer the app flow, open `gno serve`, go to **Collections**, and use the import preview before indexing. GNO now detects likely Obsidian vaults and tells you up front that it will import vault files and wiki links, not the wider Obsidian plugin ecosystem.

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

GNO already extends Obsidian's capabilities, and its direction is a safer markdown-first workspace with first-class agent integration. Obsidian still remains the better fit if your workflow depends on its plugin ecosystem, Canvas, or Excalidraw.

Both now support graph views, backlinks, and outgoing links—but GNO adds CLI access (`gno links`, `gno backlinks`, `gno similar`, `gno graph`) and REST API endpoints for programmatic use.
