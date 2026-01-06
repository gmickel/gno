---
layout: feature
title: Note Linking
headline: Navigate Your Knowledge Graph
description: Wiki links, backlinks, and semantic similarity for connected notes. Build a personal knowledge graph with bidirectional navigation, cross-collection links, and AI-powered related note discovery.
keywords: wiki links, backlinks, zettelkasten, note linking, knowledge graph, bidirectional links, similar documents
icon: link
slug: note-linking
permalink: /features/note-linking/
og_image: /assets/images/og/og-note-linking.png
benefits:
  - "[[Wiki links]] and [Markdown](links)"
  - Backlinks show who references you
  - Cross-collection linking
  - Semantic similar notes via vectors
  - Broken link indicators
  - Wiki link autocomplete in editor
commands:
  - "gno links doc.md"
  - "gno backlinks doc.md"
  - "gno similar doc.md"
---

## What Is Note Linking?

Note linking turns your document collection into a navigable knowledge graph. GNO automatically extracts and tracks links between documents, enabling Zettelkasten-style bidirectional navigation.

```markdown
Check the [[API Design]] document for details.
See also [authentication flow](./auth.md#oauth).
```

## Link Types

### Wiki Links

Double-bracket syntax for quick linking:

| Syntax                  | Example                   | Description            |
| ----------------------- | ------------------------- | ---------------------- |
| `[[Target]]`            | `[[My Note]]`             | Basic wiki link        |
| `[[Target\|Display]]`   | `[[My Note\|click here]]` | Custom display text    |
| `[[Target#Heading]]`    | `[[My Note#Section]]`     | Link to section anchor |
| `[[collection:Target]]` | `[[work:Project Plan]]`   | Cross-collection link  |

### Markdown Links

Standard markdown links to other documents:

```markdown
[API docs](./api/README.md)
[see the spec](../specs/auth.md#oauth)
```

GNO tracks internal document links. External URLs (https://) are not stored.

## Backlinks

See what documents reference the current document:

```bash
gno backlinks path/to/note.md
```

If "Note A" links to "Note B", then "Note A" appears as a backlink of "Note B". This enables:

- **Zettelkasten navigation**: Follow connections in both directions
- **Impact analysis**: See what depends on a document before editing
- **Discovery**: Find related content you didn't know existed

## Outgoing Links

List all links FROM a document:

```bash
gno links path/to/note.md
```

Shows wiki links and markdown links with their targets.

## Similar Documents

Discover semantically related notes using vector similarity:

```bash
gno similar path/to/note.md
```

GNO uses hybrid search on the document's content to find similar documents. Great for:

- **Discovery**: Find related notes you forgot about
- **Research**: Explore topic clusters
- **Organization**: Identify duplicates or overlapping content

## Cross-Collection Links

Link documents across collections using the `[[collection:Target]]` syntax:

```markdown
See [[work:Project Plan]] for the roadmap.
Reference [[notes:Meeting Notes]] from last week.
```

## Web UI

### Document Sidebar

The document view shows three link panels:

**Backlinks Panel**: Documents linking TO the current document.

**Outgoing Links Panel**: Links FROM the current document, with broken link indicators for missing targets.

**Related Notes Panel**: Semantically similar documents with similarity scores.

### Wiki Link Autocomplete

In the editor, type `[[` to trigger autocomplete:

- Fuzzy matching across all documents
- Cross-collection suggestions
- Keyboard navigation (arrows, Enter, Escape)
- Create new notes from the autocomplete

## CLI Commands

### List Outgoing Links

```bash
gno links my-note.md
gno links my-note.md --json
gno links my-note.md --limit 20
```

### List Backlinks

```bash
gno backlinks my-note.md
gno backlinks my-note.md --json
```

### Find Similar Documents

```bash
gno similar my-note.md
gno similar my-note.md --limit 10
```

## MCP Integration

AI agents can explore document relationships:

```json
{
  "tool": "gno_links",
  "arguments": {
    "path": "notes/api-design.md"
  }
}
```

| Tool            | Description                         |
| --------------- | ----------------------------------- |
| `gno_links`     | Get outgoing links from document    |
| `gno_backlinks` | Get documents linking to a document |
| `gno_similar`   | Get semantically similar documents  |

## REST API

Programmatic access via HTTP:

```bash
# Get outgoing links
curl http://localhost:3000/api/doc/:id/links

# Get backlinks
curl http://localhost:3000/api/doc/:id/backlinks

# Get similar documents
curl http://localhost:3000/api/doc/:id/similar
```

## Use Cases

- **Personal Knowledge Management (PKM)**: Build a Zettelkasten-style knowledge base
- **Documentation**: Cross-reference related docs automatically
- **Research**: Navigate connections between papers and notes
- **Project Management**: Link specs to implementation notes
- **Meeting Notes**: Connect discussions to decision documents

## Getting Started

```bash
# Index documents (links are extracted automatically)
gno index

# Explore links
gno links my-note.md
gno backlinks my-note.md
gno similar my-note.md

# Or use the Web UI
gno serve
```
