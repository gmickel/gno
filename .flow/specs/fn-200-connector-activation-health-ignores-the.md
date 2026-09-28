# Connector activation health ignores the display cap

## Goal & Context

On a vault with many collections, `gno status` and `gno doctor` always report connector activation as incomplete, and overall health as DEGRADED, even when every connector check that ran passed.

- **Where the cap comes from.** `buildConnectorStatuses` (`src/core/activation-status.ts`) forms one pair per non-empty collection and connector target. It evaluates only the first `MAX_CONNECTOR_PROJECTIONS` (64) pairs, and sets `connectorProjection.truncated` when there are more.
- **Why health can never pass.** `isConnectorActivationComplete` (`src/core/activation-connector-health.ts`) returns false whenever `truncated` is set. With more than 64 pairs, completeness is unreachable whatever the checks say.
- **Where it shows up.** A reported vault has 154 to 175 pairs, so status shows 64 checks and always DEGRADED. The same function feeds `gno doctor` and `gno status`. The Web UI connector check (`src/serve/activation-health.ts`) treats `truncated` as an unverified gap too.
- **Second cap.** Targets are also capped at `MAX_CONNECTOR_TARGETS` (16). Targets past that cap are dropped before `total` is counted, so they are neither shown nor counted.

The 64-item cap exists to bound the size of the displayed list and output, not to bound what health is decided from.

## Acceptance Criteria

- **R1:** Connector activation completeness is decided from every collection/target pair, not from the displayed subset.
  - `isConnectorActivationComplete` returns true when every pair passed or has a non-runtime code (`connector_not_configured`, `target_runtime_unverifiable`), however many pairs there are.
  - It returns false when any pair, displayed or not, failed or is pending.
  - `gno status` and `gno doctor` report the healthy state on a vault with more than 64 pairs whose checks all pass.
  - A regression test covers more than 64 passing pairs (fails on base, passes on head), and one covers a failing pair beyond the displayed 64.
- **R2:** The displayed list stays bounded (64 items in status, doctor, REST and the Web UI). The existing "N of M shown" line and the omitted count still render. When the omitted pairs have been evaluated, the output no longer says no result is claimed for them. It summarizes them instead, for example how many passed, failed or are pending.
- **R3:** The Web UI connector health check and REST `/api/status` use the same all-pairs decision. A truncated but all-passing projection is not shown as needing attention.
- **R4:** Decide the target cap (`MAX_CONNECTOR_TARGETS`, 16) from evidence: either count and evaluate every target the same way, or keep the cap and state it in the output. Record the choice and its reason in this spec.
- **R5:** Evaluating every pair stays cheap: cached receipt lookups only, with no new live connector verification added to `gno status`. Measure `gno status` on a many-collection index before and after, and record both numbers here.

## Boundaries

- No change to what a connector check proves or how it is verified.
- No change to the display cap unless R2's measurement shows a need.
- Schemas under `spec/output-schemas` change only if a field is added (for example a per-status count of omitted pairs). Keep the change additive.
