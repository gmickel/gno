---
title: File and Export Adapters
description: Index portable mail, calendar, browser, transcript, and JSONL exports without live-account access.
keywords: JSONL, EML, MBOX, ICS, WebVTT, SRT, browser bookmarks, export ingestion
---

# File and Export Adapters

GNO indexes user-controlled export files as separate logical records. Each
message, event, cue, bookmark, or JSONL row becomes independently searchable
while retaining its export path, exact source locator, dates, people, thread or
session identity, attachment inventory, and record anchors.

## Support matrix

| Source                      | Automatic file types         | Logical record                         | Notes                                                                                       |
| --------------------------- | ---------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------- |
| JSON Lines                  | `.jsonl`, `.ndjson`          | One valid object per line              | Optional declarative field mapping; malformed lines are isolated                            |
| Mail                        | `.eml`, `.mbox`              | One message                            | Bounded MIME nesting/body/attachments; attachments are inventoried, not indexed or opened   |
| Calendar                    | `.ics`                       | One VEVENT or recurrence exception     | Timezone-aware dates; recurrence anchors use a bounded local horizon                        |
| Transcripts                 | `.vtt`, `.srt`               | One cue/segment                        | Speaker and timestamp anchors retained                                                      |
| Browser exports             | `.browser-export`            | One bookmark/history/reading-list item | The file must contain a recognized export shape; live profile databases are rejected        |
| Explicit transcript exports | configured `.json` or `.txt` | One segment/record                     | Requires `recordAdapters.transcript.format` because generic JSON/text remains ordinary data |

PDF, Office, Markdown, plain-text, and source-code ingestion continues through
the existing one-document converter lane.

## Configuration

Automatic formats need no adapter configuration. Collection `include` remains
an extension allowlist; include the desired extensions when it is nonempty.
With the default empty `include`, an explicitly configured JSON transcript
adapter automatically adds `.json` to the normal supported-extension scan.

Use a closed JSONL mapping when export fields do not use GNO's conventional
`id`, `title`, `text`/`content`/`body`, and `author` names:

```yaml
collections:
  - name: exports
    path: /Users/me/exports
    pattern: "**/*"
    include: [.jsonl, .eml, .mbox, .ics, .vtt, .srt, .browser-export]
    recordAdapters:
      jsonl:
        fieldMapping:
          id: /external_id
          title: /subject
          body: /payload/text
          author: /owner/name
          participants: /participants
          threadId: /thread_id
          dateFields:
            created: /created_at
```

Selectors are JSON Pointers or ordered arrays of JSON Pointers. They cannot
execute code, traverse prototypes, read files, or make network requests.

Generic JSON and text are never guessed as transcripts. Opt in per collection:

```yaml
recordAdapters:
  transcript:
    format: json # json, text, vtt, or srt
```

## Identity, updates, and removals

GNO derives an opaque record key from adapter identity plus the record's stable
export identity. Reimport with the same key and source hash is unchanged; a
changed source hash updates the existing virtual document. A complete snapshot
deactivates records that disappeared. A partial snapshot—malformed row,
truncated file, invalid framing, or any cap failure—never deactivates unseen
records, so a damaged export cannot authorize deletion.

For JSONL, configure `fieldMapping.id` or provide a conventional `id` field
when updates must preserve identity. If neither exists, GNO derives identity
from the row's canonical content. Editing that row therefore appears as one
removed record plus one added record, not an in-place update.

Search and get results report the real container path in `source.relPath` and a
`record` object with the bounded locator and metadata. The unique `gno://` URI
addresses GNO's internal virtual document; use that URI or its docid for
`gno get`. Ask and Context Capsules retain the same metadata alongside exact
canonical-mirror line spans. The `record.adapter` identity contains the adapter
ID, version, and configuration fingerprint used to produce that record.

Virtual documents live under the reserved `.gno/records/` URI namespace. GNO
always excludes a physical directory with that name from collection walking,
even when a broad include pattern would otherwise match it.

## Limits and recovery

The shared defaults cap each container at 100 MiB, each logical record at
2,000,000 canonical characters, record metadata at 100,000 characters, the
snapshot at 50,000,000 characters or 100,000 records, and retained failures at
1,000. Adapter iteration has a 60-second deadline. Mail parsing additionally
bounds headers, MIME depth/parts, decoded body, and attachment expansion.
Calendar recurrence emits at most 64 local anchors.

On a partial import, fix or regenerate the export and rerun `gno update` or
`gno index`. Valid siblings are still indexed. Repeatedly malformed files can
be moved outside the collection or excluded by path. Error receipts contain
bounded codes and locators, never raw malformed records or absolute paths.
Terminal output always reports the file, warning count, and partial snapshot;
`--verbose` adds the stable code, source locator, retryability, and redacted
message. Programmatic sync results expose `recordImport` with adapter identity,
snapshot authority, source bytes read, per-action counts, bounded failures, and
deterministic `egressLineage`. Every logical record inherits the owning
collection's lineage; parsing or transformation cannot relax its effective
policy.

## Security and privacy boundary

These adapters only read the matched local export file. They do not authenticate
to Gmail, Outlook, calendars, or browsers; inspect live browser profiles,
cookies, passwords, or session databases; fetch message or bookmark URLs;
download remote attachments; execute embedded content; or unpack archives.
HTML is reduced to inert text and Markdown metacharacters from exported content
are escaped before indexing.

## Agent session archives

[`gno sessions`](../SESSIONS.md) does not index harness session stores
directly. It writes a sanitized JSONL archive (one file per thread, one line
per turn) and indexes that archive through this JSONL adapter. Each archive
collection carries this mapping, which `gno sessions init` writes for you:

```yaml
recordAdapters:
  jsonl:
    fieldMapping:
      id: /id
      title: /title
      body: /body
      author: /author
      categories: /categories
      sessionId: /sessionId
      threadId: /threadId
      dateFields:
        recorded: /recordedAt
```

The mapping gives every turn a stable record identity, the `human` or
`assistant` author, harness/project/role tags, session and thread identity,
and the recorded time. Copy the same block when you register an archive
folder in another config for mixed retrieval.

Downloaded conversation exports from consumer chat apps are not agent session
stores. Index them with the generic JSONL mapping above or an explicit
transcript adapter; `gno sessions` does not parse them.

## Custom typed fields

Record adapters can supply `RecordMetadata.custom` through the same bounded
validator as Markdown `gno.metadata`. Adapter fingerprint changes participate
in normal re-ingestion. Unsupported values produce metadata diagnostics and
exclude that record from typed-filtered retrieval without disabling ordinary
search. See [Typed metadata filters](../TYPED-METADATA.md).
