import { expect, test } from "bun:test";
// node:path has no Bun path utilities
import { join } from "node:path";

import { IMPORT_CHILD_ENV } from "../../src/sessions/import-child-env";

// A compiled executable re-runs itself with this flag; the CLI entry must
// serve the import request instead of parsing a command line.
test("the CLI entry routes the import-child flag to the child protocol", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "../../src/index.ts")],
    env: { ...process.env, [IMPORT_CHILD_ENV]: "1" },
    stdin: new Blob(["not json"]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout.trim())).toMatchObject({ ok: false, code: null });
});
