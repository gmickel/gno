/**
 * Parent lifeline for a resident started by another process (fn-207).
 *
 * A launcher that owns `gno serve` (the desktop shell) sets
 * `GNO_PARENT_LIFELINE=stdin` and keeps a pipe on the child's stdin open.
 * When the launcher exits or is killed, even with SIGKILL, the kernel closes
 * that pipe; stdin reaches EOF and the resident shuts down as on SIGTERM.
 * Event-driven on every platform, with no polling timer. Without the opt-in a
 * resident keeps running when its parent goes away (e.g. `nohup gno serve`).
 *
 * @module src/serve/parent-lifeline
 */

export const PARENT_LIFELINE_ENV = "GNO_PARENT_LIFELINE";

/**
 * When the launcher opted in, call `onLost` once stdin reaches EOF. Returns a
 * stop function that cancels the watch (normal shutdown). The opt-in is
 * removed from the environment so this process's own children never inherit
 * it.
 */
export function watchParentLifeline(onLost: () => void): () => void {
  const mode = process.env[PARENT_LIFELINE_ENV];
  delete process.env[PARENT_LIFELINE_ENV];
  if (mode !== "stdin") return () => undefined;

  let stopped = false;
  const reader = Bun.stdin.stream().getReader();
  void (async () => {
    try {
      // The launcher never writes; any bytes are drained and ignored.
      while (!(await reader.read()).done) {
        // keep reading until EOF
      }
    } catch {
      // A read error means the pipe is gone, the same as EOF.
    }
    if (!stopped) onLost();
  })();
  return () => {
    stopped = true;
    void reader.cancel().catch(() => undefined);
  };
}
