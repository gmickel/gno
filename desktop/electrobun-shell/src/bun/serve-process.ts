/**
 * Lifecycle of the `gno serve` child the desktop shell owns.
 *
 * The child gets a stdin pipe plus `GNO_PARENT_LIFELINE=stdin`: if the shell
 * dies, even by SIGKILL or a crash, the pipe closes and serve shuts down on
 * its own instead of holding the owner lock and port for the next launch.
 * On a normal quit the shell sends SIGTERM, waits for the exit, and escalates
 * to SIGKILL only when serve overruns its shutdown budget.
 *
 * Kept free of Electrobun imports so it can be tested directly.
 */

/** serve drains for 5 s and settles native work within ~10 s (resident shutdown clock). */
export const SERVE_STOP_GRACE_MS = 15_000;

export function startServeProcess(options: {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdio?: "inherit" | "ignore";
}): Bun.Subprocess<"pipe", "inherit" | "ignore", "inherit" | "ignore"> {
  const stdio = options.stdio ?? "inherit";
  return Bun.spawn({
    cmd: options.cmd,
    cwd: options.cwd,
    // Held open for the shell's lifetime and never written: it is the lifeline.
    stdin: "pipe",
    stdout: stdio,
    stderr: stdio,
    env: {
      ...(options.env ?? process.env),
      GNO_PARENT_LIFELINE: "stdin",
    },
  });
}

/**
 * SIGTERM, wait up to `graceMs`, then SIGKILL. Resolves once the process has
 * exited; reports how it ended.
 */
export async function stopServeProcess(
  child: Pick<Bun.Subprocess, "kill" | "exited" | "exitCode" | "signalCode">,
  graceMs = SERVE_STOP_GRACE_MS
): Promise<"already-exited" | "terminated" | "killed"> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return "already-exited";
  }
  child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exitedInTime = await Promise.race([
    child.exited.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), graceMs);
    }),
  ]);
  clearTimeout(timer);
  if (exitedInTime) return "terminated";
  child.kill("SIGKILL");
  await child.exited;
  return "killed";
}
