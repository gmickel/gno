import { expect, test } from "bun:test";
// Bun has no platform-aware filesystem path resolver.
import { resolve } from "node:path";

// Global native/os module mocks belong to this dedicated test process only.
// Keep the fixture outside automatic *.test.ts discovery so it runs once.
test("ModelManager lifecycle suite runs with isolated module mocks", async () => {
  const child = Bun.spawn(
    [process.execPath, "test", `${import.meta.dir}/lifecycle.fixture.ts`],
    {
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timeout = setTimeout(() => child.kill(), 10_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    expect(exitCode).toBe(0);
    // Guard against accidentally invoking an empty fixture or the wrapper itself.
    expect(`${stdout}${stderr}`).toContain("12 pass");
    expect(`${stdout}${stderr}`).toContain("Ran 12 tests across 1 file");
  } finally {
    clearTimeout(timeout);
  }
}, 15_000);
