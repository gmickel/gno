---
layout: feature
title: Privacy First
headline: Your Data Stays Yours
description: GNO is designed from the ground up for privacy. All processing happens locally - indexing, embeddings, search, and AI answers. Nothing leaves your machine, ever.
keywords: privacy first, local search, offline search, no cloud, private documents
icon: privacy-first
slug: privacy-first
permalink: /features/privacy-first/
benefits:
  - Zero cloud dependencies
  - No telemetry or tracking
  - SQLite database on your disk
  - Works completely offline
commands:
  - "gno doctor"
  - "gno status"
---

## True Local-First Design

Unlike cloud-based solutions, GNO processes everything on your machine:

### No Network Required

Once installed, GNO works completely offline:
- Index documents without internet
- Search without internet
- Generate AI answers without internet

### Your Data, Your Disk

All data stays in your control:

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
