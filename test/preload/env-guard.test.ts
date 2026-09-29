import { afterAll, expect, test } from "bun:test";
// node:fs/promises: no Bun equivalent for temp-directory creation/removal.
import { mkdtemp, rm } from "node:fs/promises";
// node:os/node:path: no Bun path/os utilities.
import { tmpdir } from "node:os";
import { join } from "node:path";

const guardPath = join(import.meta.dir, "env-guard.ts");
const workDir = await mkdtemp(join(tmpdir(), "gno-env-guard-"));
const fixturePath = join(workDir, "noop.test.ts");
await Bun.write(
  fixturePath,
  'import { test } from "bun:test";\ntest("noop", () => {});\n'
);

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function runWithEnv(overrides: Record<string, string>) {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of ["GNO_DATA_DIR", "GNO_CONFIG_DIR", "GNO_CACHE_DIR"]) {
    Reflect.deleteProperty(env, key);
  }
  const proc = Bun.spawn(
    [process.execPath, "test", "--preload", guardPath, fixturePath],
    {
      cwd: workDir,
      env: { ...env, ...overrides },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const [exitCode, stderr, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

test("inherited literal undefined directory fails the run at preload", async () => {
  const { exitCode, output } = await runWithEnv({ GNO_DATA_DIR: "undefined" });
  expect(exitCode).not.toBe(0);
  expect(output).toContain('GNO_DATA_DIR is set to the string "undefined"');
});

test("valid directory environment passes the preload", async () => {
  const { exitCode } = await runWithEnv({ GNO_DATA_DIR: workDir });
  expect(exitCode).toBe(0);
});
