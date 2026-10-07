# Status stalls briefly while a resident recovers after a crash

## Problem

Right after a resident restarts from a crash (SIGKILL) during embedding, a status probe took 281 ms, above the soak I4 limit of 150 ms set in fn-208 from runs without restarts. The restart does crash recovery, the startup catch-up (fn-205) and the resumed embedding at once.

Evidence: `bun run soak --tier torture --classes signals --seed 3 --contain` on fn-210 (d3df44cc): I4 `torture/signals/SIGKILL/mid-embed`: 1 probe, p99 281 ms. All other signals cases and the other soak classes stayed within the limit.

## Acceptance Criteria

- **R1:** Profile a resident in the first seconds after a crash restart (`GNO_SOAK_CPU_PROF`) and name the synchronous work that holds the event loop.
- **R2:** Bound it (time slicing as in fn-208, or deferring work until the listener is up) so status stays within the I4 limit in the signals class, including after crash restarts.

## Boundaries

- Do not loosen the I4 limit to pass; if the startup window needs its own limit, measure and record it as fn-208 did.
