# Resident background embedding strands a pending backlog

## Goal & Context
<!-- scope: business -->

A resident `gno serve` / `gno daemon` should drain the embedding backlog on its own. Split out of fn-180-investigate-detached-serve-hot-loop-raw, whose reproduction confirmed two ways the backlog stays pending indefinitely while a foreground `gno embed` clears it at once. fn-180 bounded the retry loop and made the failure visible in status; it did not change how a background pass walks the backlog.

## Evidence (fn-180 reproduction, isolated temp root, CPU embedding)

- An inference deadline on one background page aborts the whole pass. The deadline is recorded on every enclosing inference scope (`recordInferenceTimeout` in `src/llm/inference-scope.ts` walks `parent`), so the scheduler's owned scope fails and no later page runs. With an always-truncating chunk at the head of the backlog and `models.inferenceTimeout` below that page's CPU time, every pass failed on the same first page and embedded 0 of 46 pending chunks. Each pass still spent about 78 CPU-seconds in the native worker before the deadline took effect.
- A resident does not start a pass for a backlog that already exists when it starts. The scheduler runs only after a watcher sync or an explicit trigger (`notifySyncComplete` / `triggerNow` in `src/serve/embed-scheduler.ts`), so chunks indexed with `--no-embed` or left over from a previous run wait for the next file change.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** In a background pass, a page that exceeds its inference deadline fails only that page: later pages still embed in the same pass, and the failed page stays pending. Errors: the timed-out page counts toward the pass's errors; a caller abort (shutdown) still stops the whole pass.
- **R2:** A resident with a pending backlog at startup runs a background pass without waiting for a file change. Errors: none beyond the existing pass failure handling (backoff, park).
- **R3:** Tests cover a head page that always times out followed by embeddable pages, and a startup with a pre-existing backlog.

## Boundaries

- No change to truncation limits, chunk sizing, batch size, or the inference timeout default.
- No change to vector identity or partitions (fn-184).
- fn-180's retry backoff, parking, lease use, and status issues stay as they are.
