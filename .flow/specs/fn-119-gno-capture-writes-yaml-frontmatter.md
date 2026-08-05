# gno capture writes YAML frontmatter into record-container files

## Overview

`gno capture` wraps every payload in YAML frontmatter, including when the destination
extension is handled by a configured record adapter (`.jsonl`, `.vtt`, …). Those
frontmatter lines are then fed to the adapter as if they were records, and rejected.

The written container is therefore malformed from the moment it is created: its first
lines are not valid records, and only the payload below them imports. This has been the
behavior all along — it was simply invisible, because nothing reported a partial import.

**Pre-existing.** Not introduced by `fn-114-reliable-watcher-reconciliation-for`, which
only made it visible.

## How it surfaced

`fn-114` added disclosure of partial record imports: when an adapter accepts some records
and rejects others, the capture receipt now says so via `sync.reason` instead of reporting
a clean `completed`. That disclosure is truthful and working as intended — and it fires on
**every** CLI, MCP and SDK capture into a `.jsonl`, because gno's own frontmatter is
always among the rejected records.

The REST surfaces are unaffected: they write bytes verbatim, with no frontmatter wrapper.

Decision recorded during fn-114 review: ship the disclosure, file this. The warning is
accurate, and suppressing it would have hidden a real defect behind a special case.

## Boundaries / non-goals

- Not a change to the partial-import disclosure itself — that is correct and stays
- Not a change to record adapter behavior or to what counts as a valid record
- Not a change to frontmatter on ordinary document captures, which is wanted

## Acceptance Criteria

- **R1:** A capture whose destination extension is handled by a configured record adapter
  writes the payload without a YAML frontmatter wrapper, so every line is a candidate
  record.
- **R2:** A capture into an ordinary document extension still writes frontmatter exactly
  as it does today, with no change to the fields or their order.
- **R3:** Provenance currently carried in frontmatter (source, captured-at, tags, and any
  other fields) is either preserved through a mechanism the adapter accepts, or explicitly
  documented as unavailable for record containers — decided deliberately, not dropped
  silently.
- **R4:** A clean capture into a record container reports a fully successful import, with
  no partial-import disclosure.
- **R5:** The decision is consistent across CLI, MCP, and SDK, which share the capture
  write path.

## Open questions

- Where should provenance go for a container capture? Options include a sidecar, adapter
  support for a header record, per-record metadata injection, or accepting the loss.
  R3 requires a deliberate answer, not a default.
- Are there other extensions that are record-adapter-handled in some collection configs
  and ordinary in others? The decision must be per-destination-collection, not global by
  extension.
- Does anything downstream rely on a container capture having frontmatter? Check the
  clipper and any import/export round-trip.

## References

- `src/cli/commands/capture.ts` — the frontmatter wrapper on the shared capture write path
- `src/ingestion/capture-destination.ts` — `captureRecordImportReason`, which reports the
  rejected records
- `src/ingestion/sync.ts` — `processRecordContainer`, which rejects them
- Discovered during `fn-114-reliable-watcher-reconciliation-for` review, PR gmickel/gno#183
