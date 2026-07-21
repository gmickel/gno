import { expect, test } from "bun:test";

test("foreground serve completes graceful teardown before the CLI exits on SIGINT", async () => {
  const child = Bun.spawn(
    [process.execPath, "scripts/serve-shutdown-smoke.ts", "--signal", "SIGINT"],
    {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  const exitCode = await child.exited;
  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;

  expect(exitCode, stderr).toBe(0);
  expect(stdout).toContain("Serve shutdown passed");
}, 20_000);
