---
layout: feature
title: Privacy First
headline: Your Data, Index, and Models Stay With You
description: GNO is built for privacy-first local search. Indexing and default inference run on your machine, with explicit boundaries for model downloads, configured HTTP inference, and publishing.
keywords: privacy first, local search, offline search, no cloud, private documents, local knowledge workspace
icon: privacy-first
slug: privacy-first
permalink: /features/privacy-first/
og_image: /assets/images/og/og-privacy-first.png
benefits:
  - Local-first default processing
  - No telemetry or tracking
  - SQLite database on your disk
  - Offline operation after required models are cached
commands:
  - "gno doctor"
  - "gno status"
---

## True Local-First Design

By default, GNO processes indexing and inference on your machine.

### No Network Required

With required models already cached, GNO works offline:

- Index documents without internet
- Search without internet
- Generate AI answers without internet

Model downloads contact their artifact hosts. Configured HTTP model roles send
queries, chunks, or answer context to that server. gno.sh receives only the
artifact you explicitly export and upload.

### Your Data, Your Disk

The local index and model cache stay on your disk:

```
~/.local/share/gno/
├── default.db      # SQLite database
├── models/         # Local LLM models
└── cache/          # Temporary cache
```

### No Telemetry

GNO collects zero data:

- No analytics
- No crash reports
- No usage tracking
- No "anonymous" statistics

### Verify It Yourself

GNO is open source. Inspect the code:

```bash
# Check system status
gno doctor

# See what's stored
gno status
```

## Why Privacy Matters

Your documents contain:

- Personal notes and journals
- Confidential work documents
- Proprietary code and designs
- Private communications

GNO treats your data with the respect it deserves.
