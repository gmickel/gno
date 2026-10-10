import { afterAll, expect, test } from "bun:test";
// node:fs/promises: no Bun equivalent for temp-directory creation, listing or removal.
import { mkdtemp, readdir, rm } from "node:fs/promises";
// node:os/node:path: no Bun path/os utilities.
import { tmpdir } from "node:os";
import { join } from "node:path";

const preloadPath = join(import.meta.dir, "temp-dir.ts");
const workDir = await mkdtemp(join(tmpdir(), "gno-temp-dir-preload-"));
const fixturePath = join(workDir, "leaky.test.ts");
// A test that leaves a folder and a file behind, the way many suites did.
await Bun.write(
  fixturePath,
  `import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("leaks", () => {
  const dir = mkdtempSync(join(tmpdir(), "leak-"));
  writeFileSync(join(dir, "data"), "x".repeat(1024));
  writeFileSync(join(tmpdir(), "loose-file"), "x");
  console.log("TMPDIR_SEEN=" + tmpdir());
});
`
);

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function runFixture(extraEnv: Record<string, string> = {}) {
  const outer = await mkdtemp(join(workDir, "outer-"));
  const env: Record<string, string | undefined> = { ...process.env };
  Reflect.deleteProperty(env, "GNO_TEST_KEEP_TMP");
  Object.assign(env, { TMPDIR: outer, TEMP: outer, TMP: outer }, extraEnv);
  const proc = Bun.spawn(
    [process.execPath, "test", "--preload", preloadPath, fixturePath],
    { cwd: workDir, env, stderr: "pipe", stdout: "pipe" }
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, output: `${stdout}${stderr}`, outer };
}

// macOS puts the run dir under /tmp to keep socket paths short, so only the
// sweep is observable there, not the nesting under TMPDIR.
const nestsUnderTmpdir = process.platform !== "darwin";

test("a run's temp files live in its own dir and are removed when it ends", async () => {
  const { exitCode, output, outer } = await runFixture();
  expect(exitCode).toBe(0);
  const seen = /TMPDIR_SEEN=(.+)/.exec(output)?.[1]?.trim() ?? "";
  expect(seen).toContain("gno-test-");
  if (nestsUnderTmpdir) {
    expect(seen.startsWith(outer)).toBe(true);
    expect(await readdir(outer)).toEqual([]);
  }
  expect(await Bun.file(join(seen, "loose-file")).exists()).toBe(false);
});

test("GNO_TEST_KEEP_TMP keeps the run dir for inspection", async () => {
  const { exitCode, output } = await runFixture({ GNO_TEST_KEEP_TMP: "1" });
  expect(exitCode).toBe(0);
  const seen = /TMPDIR_SEEN=(.+)/.exec(output)?.[1]?.trim() ?? "";
  expect(output).toContain(`GNO_TEST_KEEP_TMP: kept ${seen}`);
  expect(await Bun.file(join(seen, "loose-file")).exists()).toBe(true);
  await rm(seen, { recursive: true, force: true });
});
