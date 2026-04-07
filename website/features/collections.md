---
layout: feature
title: Collections
headline: Turn Folders Into a Searchable Workspace
description: Group documents by source directory with patterns, includes, excludes, collection-aware browsing, and per-collection model overrides. Collections are the scope boundary for search, retrieval tuning, and workspace navigation.
keywords: document collections, local workspace folders, collection model overrides, per collection embeddings, browse tree, collection management
icon: collections
slug: collections
permalink: /features/collections/
og_image: /assets/images/og/og-collections.png
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

## Learn More

- [Per-Collection Models](/docs/guides/per-collection-models/)
- [Code Embeddings](/docs/guides/code-embeddings/)
- [Configuration](/docs/CONFIGURATION/)
