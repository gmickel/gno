import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isSafeLocalGnoMcpCommand } from "../../src/core/connector-verifier";
import { resolveGnoEntrypoint } from "../../src/core/runtime-entrypoint";
import { safeRm } from "../helpers/cleanup";

describe("current GNO runtime entrypoint", () => {
  test.each([
    ["source checkout", "/work/gno/src/core", "/work/gno/src/index.ts"],
    [
      "packed global install",
      "/prefix/lib/node_modules/@gmickel/gno/src/core",
      "/prefix/lib/node_modules/@gmickel/gno/src/index.ts",
    ],
    [
      "staged desktop runtime",
      "/App/Contents/Resources/app/gno-runtime/src/core",
      "/App/Contents/Resources/app/gno-runtime/src/index.ts",
    ],
  ])("resolves the %s layout", (_label, coreDir, expected) => {
    expect(resolveGnoEntrypoint(coreDir, "darwin")).toBe(expected);
  });

  test("resolves a staged Windows runtime without selecting a shim", () => {
    expect(
      resolveGnoEntrypoint(
        "C:\\Program Files\\GNO\\resources\\app\\gno-runtime\\src\\core",
        "win32"
      )
    ).toBe(
      "C:\\Program Files\\GNO\\resources\\app\\gno-runtime\\src\\index.ts"
    );
  });

  test("does not trust unrelated Unix or Windows GNO shims", async () => {
    const testDir = await mkdtemp(join(tmpdir(), "gno-runtime-entrypoint-"));
    try {
      const binDir = join(testDir, "bin");
      await mkdir(binDir, { recursive: true });
      for (const executable of ["gno", "gno.exe", "gno.cmd"]) {
        const shim = join(binDir, executable);
        await Bun.write(shim, "untrusted shim");
        expect(
          await isSafeLocalGnoMcpCommand({ command: shim, args: ["mcp"] })
        ).toBe(false);
        expect(
          await isSafeLocalGnoMcpCommand({
            command: process.execPath,
            args: [shim, "mcp"],
          })
        ).toBe(false);
      }
    } finally {
      await safeRm(testDir);
    }
  });
});
