---
layout: feature
title: Multi-Format Indexing
headline: Index Everything You Write
description: GNO indexes Markdown, PDF, Word, Excel, PowerPoint, and plain text. One tool for all your documents, with intelligent chunking and language detection.
keywords: document indexing, pdf search, markdown search, office documents, docx xlsx pptx
icon: multi-format
slug: multi-format
permalink: /features/multi-format/
benefits:
  - Markdown with frontmatter extraction
  - PDF text extraction
  - Office documents (DOCX, XLSX, PPTX)
  - Plain text files
  - Automatic language detection
commands:
  - "gno init ~/docs --pattern '**/*'"
  - "gno update"
  - "gno ls --json"
---

## Supported Formats

GNO intelligently processes multiple document formats:

### Markdown (.md)
- Extracts YAML frontmatter metadata
- Preserves heading structure
- Maintains code block context

### PDF (.pdf)
- Full text extraction
- Page-aware chunking
- Handles multi-column layouts

### Microsoft Office
- **Word (.docx)** - Full document text
- **Excel (.xlsx)** - Sheet content and headers
- **PowerPoint (.pptx)** - Slide text and notes

### Plain Text
- Any .txt file
- Code files (configurable)
- Log files

## Intelligent Chunking

GNO splits documents into semantic chunks for better search:

```bash
# Initialize with all formats
gno init ~/documents --pattern "**/*"

# Or specific formats only
gno init ~/notes --pattern "**/*.md"

# Index everything
gno update
```

## Language Detection

Automatic language detection optimizes search for:
- English
- Chinese, Japanese, Korean (CJK)
- Other languages with Unicode support
