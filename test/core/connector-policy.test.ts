import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isSafeLocalGnoMcpCommand } from "../../src/core/connector-verifier";
import { safeRm } from "../helpers/cleanup";

test("connector policy requires trusted realpath provenance", async () => {
  const testDir = await mkdtemp(join(tmpdir(), "gno-connector-policy-"));
  try {
    const trustedDir = join(testDir, "trusted");
    const spoofDir = join(testDir, "spoof", "gno", "src", "cli");
    const untrustedDir = join(testDir, "untrusted");
    await mkdir(trustedDir, { recursive: true });
    await mkdir(spoofDir, { recursive: true });
    await mkdir(untrustedDir, { recursive: true });
    const trustedGno = join(trustedDir, "gno");
    const trustedCmd = join(trustedDir, "gno.cmd");
    const trustedSource = join(trustedDir, "index.ts");
    const spoofGno = join(untrustedDir, "gno");
    const spoofSource = join(spoofDir, "index.ts");
    await Promise.all([
      Bun.write(trustedGno, "trusted"),
      Bun.write(trustedCmd, "trusted"),
      Bun.write(trustedSource, "trusted"),
      Bun.write(spoofGno, "spoof"),
      Bun.write(spoofSource, "spoof"),
    ]);
    const trusted = {
      trustedGnoEntryPaths: [trustedGno, trustedCmd, trustedSource],
    };

    expect(
      await isSafeLocalGnoMcpCommand(
        { command: trustedGno, args: ["mcp"] },
        trusted
      )
    ).toBe(true);
    expect(
      await isSafeLocalGnoMcpCommand(
        { command: process.execPath, args: [trustedGno, "mcp"] },
        trusted
      )
    ).toBe(true);
    expect(
      await isSafeLocalGnoMcpCommand(
        { command: process.execPath, args: ["run", trustedSource, "mcp"] },
        trusted
      )
    ).toBe(true);
    expect(
      await isSafeLocalGnoMcpCommand(
        { command: process.execPath, args: [trustedCmd, "mcp"] },
        trusted
      )
    ).toBe(true);
    expect(
      await isSafeLocalGnoMcpCommand({
        command: process.execPath,
        args: ["x", "@gmickel/gno", "mcp"],
      })
    ).toBe(false);
    expect(
      await isSafeLocalGnoMcpCommand({
        command: "bunx",
        args: ["@gmickel/gno", "mcp"],
      })
    ).toBe(false);
    expect(
      await isSafeLocalGnoMcpCommand({
        command: "npx",
        args: ["@gmickel/gno", "mcp"],
      })
    ).toBe(false);
    expect(
      await isSafeLocalGnoMcpCommand(
        { command: trustedGno, args: ["mcp", "--enable-write"] },
        trusted
      )
    ).toBe(false);
    expect(
      await isSafeLocalGnoMcpCommand({
        command: "sh",
        args: ["-c", "gno mcp"],
      })
    ).toBe(false);
    expect(
      await isSafeLocalGnoMcpCommand({
        command: spoofGno,
        args: ["mcp"],
      })
    ).toBe(false);
    expect(
      await isSafeLocalGnoMcpCommand({
        command: process.execPath,
        args: [spoofGno, "mcp"],
      })
    ).toBe(false);
    expect(
      await isSafeLocalGnoMcpCommand({
        command: process.execPath,
        args: ["run", spoofSource, "mcp"],
      })
    ).toBe(false);
  } finally {
    await safeRm(testDir);
  }
});
