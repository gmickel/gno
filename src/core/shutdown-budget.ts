/** Internal resident shutdown clock. Every participant shares these deadlines. */
export const SHUTDOWN_DRAIN_MS = 5_000;
export const SHUTDOWN_ABORT_MS = 5_000;
export const SHUTDOWN_EXIT_MS = 1_000;
// The detached parent must not be killed before it can reap its native child.
export const RESIDENT_STOP_GRACE_MS = 12_000;

/** Observe settlement without abandoning rejection handling or retaining a timer. */
export async function settlesBy(
  work: Promise<unknown>,
  deadline: number,
  interrupt?: AbortSignal
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interrupted: (() => void) | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<false>((resolve) => {
        interrupted = () => resolve(false);
        interrupt?.addEventListener("abort", interrupted, { once: true });
        if (interrupt?.aborted) resolve(false);
        timer = setTimeout(
          () => resolve(false),
          Math.max(0, deadline - performance.now())
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (interrupted) interrupt?.removeEventListener("abort", interrupted);
  }
}

export function shutdownDuration(
  value: number | undefined,
  fallback: number
): number {
  const duration = value ?? fallback;
  if (!Number.isSafeInteger(duration) || duration < 0)
    throw new RangeError(
      "Shutdown duration must be a nonnegative finite integer"
    );
  return duration;
}
