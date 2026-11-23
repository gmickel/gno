# Two-stage quantized vec0 with exact float32 rescore (superseded)

## Goal & Context
<!-- scope: business -->

Superseded on 2026-11-23 by `fn-235` (Bit coarse vec0 mirror with exact rescore and cost-based routing). The benchmark spike showed that the collection-partitioned float32 mirror this spec built on is within about 25% of the exact SQL scan, so the two specs were merged into one `bit`-mirror spec. No work is tracked here.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** No work. All requirements moved to `fn-235`. [inferred]

## Boundaries
<!-- scope: business -->

- Everything. See `fn-235`. [inferred]

## Decision Context
<!-- scope: both -->

Kept as a pointer so references to `fn-236` resolve. The spike results that drove the merge are recorded in `fn-235` under "Spike measurements this design rests on".
