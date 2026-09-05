import { expect, test } from "bun:test";

test("model-specific native port lifetime contracts (isolated mock process)", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      `${import.meta.dir}/model-specific-leases.fixture.ts`,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    const [code, out, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) process.stderr.write(out + error);
    expect(code).toBe(0);
    expect(out + error).toContain("2 pass");
  } finally {
    clearTimeout(timer);
  }
}, 15000);
