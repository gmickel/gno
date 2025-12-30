---
layout: feature
title: Collections
headline: Organize Your Knowledge
description: Group documents by source directory with patterns, includes, and excludes. Search specific collections or across everything.
keywords: document collections, organize documents, file patterns, search scope, document groups
icon: collections
slug: collections
permalink: /features/collections/
benefits:
  - Multiple document sources
  - Glob patterns for filtering
  - Include/exclude rules
  - Per-collection search
commands:
  - "gno collection add ~/notes --name notes"
  - "gno collection list"
  - "gno search 'term' -c notes"
---

## What Are Collections?

Collections are named groups of documents from specific directories. They let you:
- Organize different types of content
- Search within specific scopes
- Apply different patterns per source

## Creating Collections

### At Initialization

```bash
gno init ~/notes --name notes --pattern "**/*.md"
```

### Adding More

```bash
gno collection add ~/work/docs --name work
gno collection add ~/research --name papers --pattern "**/*.pdf"
```

## Collection Configuration

Each collection can have:

```yaml
collections:
  - name: notes
    path: /Users/you/notes
    pattern: "**/*.md"
    exclude:
      - .git
      - node_modules
      - "*.tmp"
    languageHint: en

  - name: work
    path: /Users/you/work/docs
    pattern: "**/*"
    include:
      - "*.md"
      - "*.pdf"
```

## Searching Collections

### Search Everything

```bash
gno search "important topic"
```

### Search Specific Collection

```bash
gno search "meeting notes" -c notes
gno query "project deadline" --collection work
```

### List Collections

```bash
gno collection list
gno collection list --json
```

## Use Cases

- **notes**: Personal Obsidian/Logseq vault
- **work**: Company documentation
- **papers**: Research PDFs
- **code**: Project README files
