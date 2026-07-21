# fn-102 Knowledge Delta and Capsule Reverification

## Goal & Context
<!-- scope: business -->

Make GNO's resident service visibly useful after indexing: show what changed, which knowledge depends on it, and whether saved evidence remains current. Add a bounded source change journal, document/relationship diffs, impact traversal, and automatic reverification of saved Context Capsules when their evidence changes.

## Architecture & Data Models
<!-- scope: technical -->

Persist an append-only, bounded `document_changes` journal during successful sync transactions. Entries include collection/doc identity, change kind, old/new source and mirror hashes, observed time, and compact normalized deltas for headings, links, typed edges, dates, and active state. Large content is never duplicated.

A shared diff service reconstructs current-versus-prior structural change from journal metadata and retained mirror snapshots where available. Impact analysis traverses existing typed/backlink edges with strict depth/node caps and explains each dependency path. Saved Capsule registrations store capsule hash, evidence source hashes, question/label, and notification preference; a scheduler re-verifies only when referenced evidence hashes change.

## API Contracts
<!-- scope: technical -->

- CLI: `gno changes --since <time|cursor>`, `gno diff <uri> [--change <id>]`, `gno impact <uri>`, and Capsule watch/list/unwatch/reverify commands.
- REST/MCP/SDK expose read-only changes, diff, impact, and Capsule reverification through shared core services.
- Cursor pagination is stable and opaque; output schemas include truncation and retention-boundary warnings.
- Notifications are local events initially and carry no source content by default.

## Edge Cases & Constraints
<!-- scope: technical -->

- Renames/moves, delete/inactivate/reactivate, conversion changes, clock skew, and same-content mtime changes need distinct semantics.
- Journal writes are transactionally aligned with committed sync state; failed syncs do not emit false changes.
- Retention is bounded by age/count/bytes and preserves a visible earliest cursor.
- Impact traversal is cycle-safe and cannot explode on hubs.
- Reverification triggers on evidence hash/state changes, not unrelated collection churn.
- Notification storms coalesce by Capsule and settled sync generation.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** Successful create/update/rename/inactivate/reactivate operations emit deterministic bounded journal entries with old/new hashes and structural deltas.
- **R2:** `changes`, `diff`, and `impact` return schema-valid, cross-surface-equivalent results with stable pagination and truncation disclosure.
- **R3:** Impact output explains bounded typed/backlink dependency paths and remains cycle/hub safe under regression fixtures.
- **R4:** Saved Capsules reverify only when referenced evidence changes and report unchanged, stale, missing, reranked, and affected-question states.
- **R5:** Failed/no-content-change syncs do not emit false deltas; concurrent watcher/full sync settles to one logical change sequence.
- **R6:** Retention/purge behavior, cursor expiry, local notifications, docs, and privacy boundaries are tested.
- **R7:** No user file is rewritten and no autonomous synthesis occurs.

## Boundaries
<!-- scope: business -->

No autonomous dream cycle, hidden note rewriting, generic event-sourcing platform, remote notifications, full binary diff storage, or unbounded historical archive.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

A warm daemon should answer “what changed?” and “is my evidence still current?”—high-value questions competitors handle poorly and static retrieval cannot answer safely.

### Implementation Tradeoffs
<!-- scope: technical -->

A compact structural journal is less complete than retaining every document version but is bounded, privacy-conscious, and sufficient for impact and evidence freshness. Reverification is evidence-triggered rather than schedule-heavy.
