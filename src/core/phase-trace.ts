/**
 * Opt-in startup phase trace for diagnosing stalled CLI runs.
 *
 * With `GNO_PHASE_TRACE=1`, each call writes one line to stderr:
 * `gno-phase <ms since process start> <pid> <label>`. The write is
 * synchronous so a line reaches the pipe before a later blocking call (a
 * SQLite busy wait, a native load) can stall the process; the last line a
 * killed process printed names the phase it stalled in.
 *
 * @module src/core/phase-trace
 */

// node:fs writeSync: Bun has no synchronous stderr write; process.stderr.write
// to a pipe can still be queued when the event loop blocks.
import { writeSync } from "node:fs";

export const PHASE_TRACE_ENV = "GNO_PHASE_TRACE";

const STDERR_FD = 2;

const enabled = process.env[PHASE_TRACE_ENV] === "1";

/** Record that the process reached `label` (no-op unless tracing is on). */
export function tracePhase(label: string): void {
  if (!enabled) return;
  try {
    writeSync(
      STDERR_FD,
      `gno-phase ${Math.round(performance.now())} ${process.pid} ${label}\n`
    );
  } catch {
    // A closed stderr must never fail the traced command.
  }
}
