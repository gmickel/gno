# Acceptance fixtures v1

Public synthetic data only. `generate.ts` deterministically produces 296 documents and 51 cases. `manifest.json` pins canonical SHA-256 identities of the full corpus (including source metadata and chunks), query/lifecycle cases, and exhaustive eligible evidence. No runtime IDs or temporary paths enter these identities. Consumers call `verifyAcceptanceFixturePins` before preparing runs. Established pins must not be refreshed to hide a failure; scenario additions require a separately identified version.

`setupAcceptanceFixturePair` creates two independent SQLite indexes and two copies of the synthetic sources under one unique temporary directory. Each side has explicit HOME/XDG/GNO subprocess paths; the helper never changes process environment or opens a user index. Dispose the pair after closing any consumers. This setup seeds custom chunk sizes directly, without an ingestion chunker silently changing the 1,000-chunk or oversized-input scenarios. It loads no models and makes no semantic-pass claim.

The oracle exhaustively enumerates active documents in the requested collection/date boundary and eligible chunk languages, including both owners of shared content. It deliberately applies no retrieval top-k cap and does not claim model ranking or relevance scores. Intended bug corrections must still predeclare complete baseline/candidate records in the paired comparator; the oracle is evidence, not a wildcard exemption.

Title duplicates have identical body hashes and distinct filename-derived titles. Tests seed both forward and reverse orders and inspect title-conditioned embedding inputs. Expiry/restoration steps describe operations for running adapters; fixture creation alone does not execute these lifecycle gates.

## Sanitized audit provenance

Derived from synthetic generators in `notes/performance-audit-2026-09-04/evidence/` at audit baseline `be4c0d32835e79d532de3ae700bf78ae358b22ce`:

- `retrieval/probe.ts`: 200 higher-ranked old documents before one eligible recent document. Preserve the empty post-filter top-k failure as a correction scenario.
- `retrieval/chunk-probe.ts`: 1,000 chunks of repeated hydration payload. Preserve the full hydration workload, including slower runs.
- `long-inputs/probe.ts`: EN/DE/Chinese confirmed versus unknown launch-code claims at start, 3,980-character boundary, and tail; sizes 1,000/4,000/4,001/8,000/16,000; long Chinese query. Preserve truncated conflicting tails and deduplication failures rather than dropping those inputs.
- `lifecycle-final/ttl-probe.ts`: repeated embedding after expiry; retain disposed-context failure as unmet coverage until run and corrected.
- `ingestion-final/probe.ts`: identical source restoration and same-body Alpha/Beta titles. Preserve failed restoration and title-conditioned duplicate observations as intended-delta scenarios.

Original audit files, raw measurements (including negative/slower observations), and memory fixture pins remain untouched. No model path, private source, live-service address, or local benchmark output is copied here. Timing values are not copied into synthetic expected results.
