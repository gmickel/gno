# fn-110 File and Export-First Source Adapters

## Goal & Context
<!-- scope: business -->

Expand ingestion through user-controlled files and exports before requesting account-wide OAuth access. Support high-value portable sources—JSONL, EML/MBOX, ICS, browser exports, and transcript exports—through deterministic converters with provenance and bounded resource use.

## Architecture & Data Models
<!-- scope: technical -->

Extend the existing MIME detector/converter registry with isolated adapters that emit canonical Markdown plus structured conversion metadata. Preserve one stable logical record per source item where useful, with source locator, external ID, timestamps, participants/author, thread/event/session identifiers, attachments/references, and converter fingerprint.

Format scope:

- JSONL: configurable safe field mapping with per-line provenance and malformed-line isolation.
- EML/MBOX: message/thread metadata, sanitized text/HTML body, attachment inventory under size/type policy.
- ICS: event identity, start/end/timezone, organizer/attendees, recurrence source plus bounded occurrence handling.
- Browser exports: bookmarks/history/reading-list files selected explicitly, not live browser databases.
- Transcripts: common JSON/VTT/SRT/text exports with speaker/time anchors.

Large containers stream records; one bad item does not invalidate the entire import. Re-import uses stable IDs/source hashes for idempotent update/deactivation semantics.

## API Contracts
<!-- scope: technical -->

- Existing collection/index/import paths detect supported formats and expose converter IDs/versions/warnings.
- Optional adapter config is declarative, schema-validated, and cannot execute code.
- JSON/receipts identify imported/skipped/failed records, source locators, provenance, attachments, and retryability.
- Search/get results preserve record-level titles/dates/authors/categories and exact source/export lineage.

## Edge Cases & Constraints
<!-- scope: technical -->

- Stream large MBOX/JSONL; cap record, attachment, recurrence, and total expansion sizes.
- Sanitize email/browser HTML and reject executable/dangerous attachment schemes.
- Handle encodings, MIME nesting, duplicate Message-IDs, missing IDs, folded headers, timezones/DST, recurring events, speaker drift, malformed records, and partially written exports.
- Never read live browser profiles, cookies, mail accounts, or calendar accounts.
- Do not unpack arbitrary archives or follow external attachment URLs automatically.
- Preserve privacy in logs and conversion errors.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** JSONL, EML/MBOX, ICS, browser-export, and transcript fixtures convert through the shared registry into deterministic searchable records with provenance.
- **R2:** Re-import is idempotent by stable identity/hash and handles updates/removals according to documented collection semantics.
- **R3:** One malformed record is isolated with a clean warning/error while valid sibling records continue.
- **R4:** Streaming and size/recurrence/attachment caps prevent memory blowups, zip/archive abuse, and unbounded expansion.
- **R5:** Search/get/Ask/Capsule surfaces retain useful record dates, people, source locators, and exact transcript/message/event anchors.
- **R6:** Sanitization, encoding, MIME, timezone/DST, duplicate/missing ID, and privacy regression suites pass cross-platform.
- **R7:** CLI/config/docs/skill/hosted-site support matrices accurately distinguish file/export adapters from live connectors.

## Boundaries
<!-- scope: business -->

No Gmail/Outlook/Calendar/browser OAuth, live profile/database scraping, cookie/session access, arbitrary archive extraction, remote attachment fetching, or background account synchronization.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

Exports cover valuable knowledge sources with explicit user custody and a much smaller security/maintenance burden than connector sprawl.

### Implementation Tradeoffs
<!-- scope: technical -->

Registry-based converters reuse GNO's strongest ingestion path. Record streaming and partial-failure receipts add complexity but are necessary for mailbox/export scale and reliable provenance.

## Implementation Plan

1. `fn-110-file-and-export-first-source-adapters.1` — Add the streaming multi-record ingestion adapter contract (**M**)
2. `fn-110-file-and-export-first-source-adapters.2` — Implement JSONL and transcript export adapters (**M**); depends on `fn-110-file-and-export-first-source-adapters.1`
3. `fn-110-file-and-export-first-source-adapters.3` — Implement safe EML and streaming MBOX adapters (**M**); depends on `fn-110-file-and-export-first-source-adapters.1`
4. `fn-110-file-and-export-first-source-adapters.4` — Implement bounded iCalendar adapter (**M**); depends on `fn-110-file-and-export-first-source-adapters.1`
5. `fn-110-file-and-export-first-source-adapters.5` — Implement explicit browser export adapters (**M**); depends on `fn-110-file-and-export-first-source-adapters.1`
6. `fn-110-file-and-export-first-source-adapters.6` — Complete record metadata parity security packaging and support docs (**M**); depends on `fn-110-file-and-export-first-source-adapters.2`, `fn-110-file-and-export-first-source-adapters.3`, `fn-110-file-and-export-first-source-adapters.4`, `fn-110-file-and-export-first-source-adapters.5`

## Quick commands

```bash
bun test test/converters test/ingestion/export-adapters*
bun run docs:verify
bun run test:package
.flow/bin/flowctl validate --spec fn-110-file-and-export-first-source-adapters --json
```

## References

- `src/converters/registry.ts:1-80` and `src/converters/types.ts:47-120` — current converter contract.
- [RFC 5322](https://www.rfc-editor.org/info/rfc5322/) and [RFC 2045](https://www.rfc-editor.org/info/rfc2045/).
- [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545.html).
- [WebVTT](https://www.w3.org/TR/webvtt1/).

## Early proof point

Task `fn-110-file-and-export-first-source-adapters.1` validates the core approach (a streaming multi-record snapshot contract can isolate a malformed item and preserve stable record identity without changing one-file converters).
If it fails, re-evaluate the record-container lifecycle, tombstone rules, and provenance contract before continuing with `fn-110-file-and-export-first-source-adapters.2`+.

## Requirement coverage

| Req | Description | Task(s) | Gap justification |
|-----|-------------|---------|-------------------|
| R1 | JSONL, EML/MBOX, ICS, browser-export, and transcript fixtures convert through the shared registry into deterministic searchable records with provenance. | fn-110-file-and-export-first-source-adapters.2, fn-110-file-and-export-first-source-adapters.3, fn-110-file-and-export-first-source-adapters.4, fn-110-file-and-export-first-source-adapters.5, fn-110-file-and-export-first-source-adapters.6 | — |
| R2 | Re-import is idempotent by stable identity/hash and handles updates/removals according to documented collection semantics. | fn-110-file-and-export-first-source-adapters.1, fn-110-file-and-export-first-source-adapters.2, fn-110-file-and-export-first-source-adapters.3, fn-110-file-and-export-first-source-adapters.4, fn-110-file-and-export-first-source-adapters.5, fn-110-file-and-export-first-source-adapters.6 | — |
| R3 | One malformed record is isolated with a clean warning/error while valid sibling records continue. | fn-110-file-and-export-first-source-adapters.1, fn-110-file-and-export-first-source-adapters.2, fn-110-file-and-export-first-source-adapters.3, fn-110-file-and-export-first-source-adapters.4, fn-110-file-and-export-first-source-adapters.5, fn-110-file-and-export-first-source-adapters.6 | — |
| R4 | Streaming and size/recurrence/attachment caps prevent memory blowups, zip/archive abuse, and unbounded expansion. | fn-110-file-and-export-first-source-adapters.1, fn-110-file-and-export-first-source-adapters.2, fn-110-file-and-export-first-source-adapters.3, fn-110-file-and-export-first-source-adapters.4, fn-110-file-and-export-first-source-adapters.5, fn-110-file-and-export-first-source-adapters.6 | — |
| R5 | Search/get/Ask/Capsule surfaces retain useful record dates, people, source locators, and exact transcript/message/event anchors. | fn-110-file-and-export-first-source-adapters.2, fn-110-file-and-export-first-source-adapters.3, fn-110-file-and-export-first-source-adapters.4, fn-110-file-and-export-first-source-adapters.5, fn-110-file-and-export-first-source-adapters.6 | — |
| R6 | Sanitization, encoding, MIME, timezone/DST, duplicate/missing ID, and privacy regression suites pass cross-platform. | fn-110-file-and-export-first-source-adapters.2, fn-110-file-and-export-first-source-adapters.3, fn-110-file-and-export-first-source-adapters.4, fn-110-file-and-export-first-source-adapters.5, fn-110-file-and-export-first-source-adapters.6 | — |
| R7 | CLI/config/docs/skill/hosted-site support matrices accurately distinguish file/export adapters from live connectors. | fn-110-file-and-export-first-source-adapters.6 | — |
