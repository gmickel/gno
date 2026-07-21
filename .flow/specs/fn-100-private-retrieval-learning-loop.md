# fn-100 Private Retrieval Learning Loop

## Goal & Context
<!-- scope: business -->

Let users turn their own retrieval failures and successful evidence paths into private, reproducible quality improvements without uploading query history. Capture opt-in local outcome receipts, export them as benchmark/qrels fixtures, and replay ranking/model changes before recommending any personalization.

## Architecture & Data Models
<!-- scope: technical -->

Introduce an opt-in trace recorder spanning query/context/get/cite with a stable `traceId`. Persist bounded local records in the active index database or a clearly associated local sidecar:

- redacted query/goal and filters
- pipeline/model/config/index fingerprints
- ranked document/chunk IDs, scores, source hashes, and exact opened/cited/pinned spans
- explicit user judgments: relevant, irrelevant, missing expected document
- capabilities/fallbacks, latency, and completion outcome
- retention/expiry and schema version

Add a replay engine that runs stored cases against a selected current/candidate pipeline, compares rank/evidence changes, and exports deterministic `fn-97`/qrels-compatible fixtures. Recording, inspection, export, deletion, and purge all use shared core services.

## API Contracts
<!-- scope: technical -->

- Config defaults recording off; retention and content-redaction levels are explicit.
- CLI: `gno trace list|show|label|export|replay|delete|purge` with JSON schemas.
- SDK/REST/Web may attach explicit opened/cited/pinned/judgment events to a trace.
- MCP read tools may return `traceId`; mutation/label operations require write authorization and are not silently enabled.
- Replay output separates retrieval deltas from verdicts and never changes production ranking automatically.

## Edge Cases & Constraints
<!-- scope: technical -->

- No telemetry or network upload; export is explicit and user-controlled.
- Default receipts avoid raw full passages and secrets; hashes/IDs alone must remain useful for drift detection.
- Deleted/inactive/changed documents yield stale/missing states rather than corrupt replay.
- Retention limits cap rows/bytes/time and purge transactionally.
- Concurrent clients/events are idempotent by event ID.
- User labels outrank inferred opened/cited signals; absence of a click is not irrelevance.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** Recording is off by default and can be enabled with explicit retention/redaction controls documented across CLI/Web/config.
- **R2:** A trace links query through retrieval, Context Capsule/get operations, exact cited/opened/pinned spans, and explicit judgments with stable fingerprints.
- **R3:** Users can inspect, label, export, delete, and fully purge local receipts; tests prove no hidden network transmission.
- **R4:** Export produces deterministic benchmark/qrels fixtures consumable by `fn-97` without raw-document duplication.
- **R5:** Replay compares baseline/candidate rank, coverage, and evidence outcomes against unchanged fixtures and reports stale/missing sources.
- **R6:** No replay result automatically modifies ranking, boosts, prompts, or user files.
- **R7:** Size/retention caps, concurrent event idempotency, migrations, and privacy docs are tested.

## Boundaries
<!-- scope: business -->

No automatic personalization, federated analytics, cloud telemetry, implicit click-as-relevance labeling, autonomous note rewriting, or training upload pipeline.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

Private failure replay can become GNO's compounding quality moat: each corpus improves its own evaluation evidence while remaining local and user-controlled.

### Implementation Tradeoffs
<!-- scope: technical -->

Receipts and offline replay precede ranking adaptation. This delays personalization but makes every later change measurable, reversible, and privacy-preserving.
