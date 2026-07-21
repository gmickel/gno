---
satisfies: [R1, R2, R3, R4, R5, R6]
---
# fn-110-file-and-export-first-source-adapters.4 Implement bounded iCalendar adapter

## Description
Deliver implement bounded icalendar adapter as one implementation-sized increment.

**Size:** M
**Files:** `src/converters/adapters/ical/adapter.ts`, `src/converters/adapters/ical/recurrence.ts`, `test/converters/ical.test.ts`, `test/fixtures/exports/calendar`

### Approach
- Map VEVENT identity to UID plus RECURRENCE-ID semantics; preserve TZID/floating/UTC time, organizer/attendees, source recurrence, EXDATE/RDATE, and event text.
- Bound recurrence expansion by configured horizon/count and preserve the recurrence source even when occurrences are not materialized.
- Treat complete export snapshots as authoritative only after fully successful parse; malformed components do not delete prior records.

### Investigation targets
**Required** (read before coding):
- `src/ingestion/frontmatter.ts`
- `src/store/types.ts`

**Optional** (reference as needed):
- `src/pipeline/temporal.ts`
- `src/converters/canonicalize.ts`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/ingestion/record-adapter.ts`
- `src/core/temporal.ts`

### Key context
- RFC 5545 DATE-TIME uses UTC Z or local+TZID; numeric UTC offsets are invalid and must not be silently normalized.

## Acceptance
- [ ] ICS fixtures preserve UID/recurrence identity, timezone/floating/UTC semantics, participants, dates, source locator, and bounded occurrence anchors.
- [ ] DST, recurrence exceptions, malformed events, missing IDs, and expansion caps are deterministic and isolated.
- [ ] Full/partial re-import follows the shared tombstone policy without unbounded materialization.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
