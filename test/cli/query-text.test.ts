import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveCliQueryText } from "../../src/cli/query-text";
import { safeRm } from "../helpers/cleanup";

describe("resolveCliQueryText", () => {
  test("returns the positional query when no file is set", async () => {
    expect(await resolveCliQueryText("hello", undefined)).toBe("hello");
  });

  test("reads a query file and strips a trailing newline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gno-query-text-"));
    const path = join(dir, "q.txt");
    await writeFile(path, "ramen bowl\n", { flag: "wx", mode: 0o600 });
    try {
      expect(await resolveCliQueryText("", path)).toBe("ramen bowl");
    } finally {
      await safeRm(dir);
    }
  });

  test("rejects positional query plus --query-file", async () => {
    await expect(resolveCliQueryText("a", "/tmp/q")).rejects.toThrow(
      "Pass a query or --query-file, not both"
    );
  });
});
