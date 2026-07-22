import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { isValidIndexName } from "../../src/app/index-name";
import { isSafeLocalGnoMcpCommand } from "../../src/core/connector-verifier";
import { safeRm } from "../helpers/cleanup";

test("connector policy requires trusted realpath provenance", async () => {
  const testDir = await mkdtemp(join(tmpdir(), "gno-connector-policy-"));
  try {
    const trustedDir = join(testDir, "trusted");
    const spoofDir = join(testDir, "spoof", "gno", "src", "cli");
    const untrustedDir = join(testDir, "untrusted");
    const fakeConventionalDir = join(testDir, ".bun", "bin");
    await mkdir(trustedDir, { recursive: true });
    await mkdir(spoofDir, { recursive: true });
    await mkdir(untrustedDir, { recursive: true });
    await mkdir(fakeConventionalDir, { recursive: true });
    const trustedGno = join(trustedDir, "gno");
    const trustedCmd = join(trustedDir, "gno.cmd");
    const trustedSource = join(trustedDir, "index.ts");
    const spoofGno = join(untrustedDir, "gno");
    const spoofSource = join(spoofDir, "index.ts");
    const fakeConventionalGno = join(fakeConventionalDir, "gno");
    const canonicalSource = resolve(import.meta.dir, "../../src/index.ts");
    await Promise.all([
      Bun.write(trustedGno, "trusted"),
      Bun.write(trustedCmd, "trusted"),
      Bun.write(trustedSource, "trusted"),
      Bun.write(spoofGno, "spoof"),
      Bun.write(spoofSource, "spoof"),
      Bun.write(fakeConventionalGno, "spoof"),
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
    for (const command of ["gno", "gno.cmd", "./gno", "trusted/gno"]) {
      expect(
        await isSafeLocalGnoMcpCommand({ command, args: ["mcp"] }, trusted)
      ).toBe(false);
    }
    expect(
      await isSafeLocalGnoMcpCommand(
        { command: "bun", args: ["run", trustedSource, "mcp"] },
        trusted
      )
    ).toBe(false);
    expect(
      await isSafeLocalGnoMcpCommand(
        {
          command: trustedGno,
          args: ["--config", "relative/index.yml", "mcp"],
        },
        trusted
      )
    ).toBe(false);
    expect(
      await isSafeLocalGnoMcpCommand(
        {
          command: trustedGno,
          args: ["--config=relative/index.yml", "mcp"],
        },
        trusted
      )
    ).toBe(false);
    expect(
      await isSafeLocalGnoMcpCommand(
        { command: process.execPath, args: [trustedGno, "mcp"] },
        trusted
      )
    ).toBe(true);
    expect(
      await isSafeLocalGnoMcpCommand({
        command: process.execPath,
        args: ["run", canonicalSource, "mcp"],
      })
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
      await isSafeLocalGnoMcpCommand(
        { command: trustedGno, args: ["--index", "work", "mcp"] },
        trusted
      )
    ).toBe(true);
    for (const indexName of [
      "research-2026",
      "team_alpha",
      "research.v2",
      "research index",
      "ümlaut",
      "a".repeat(64),
    ]) {
      expect(isValidIndexName(indexName)).toBe(true);
      expect(
        await isSafeLocalGnoMcpCommand(
          { command: trustedGno, args: ["--index", indexName, "mcp"] },
          trusted
        )
      ).toBe(true);
      expect(
        await isSafeLocalGnoMcpCommand(
          { command: trustedGno, args: [`--index=${indexName}`, "mcp"] },
          trusted
        )
      ).toBe(true);
    }
    expect(
      await isSafeLocalGnoMcpCommand(
        {
          command: trustedGno,
          args: ["--config=/tmp/gno.yml", "--index=work", "mcp", "serve"],
        },
        trusted
      )
    ).toBe(true);
    for (const controlCharacter of ["\0", "\n", "\u001b"]) {
      const unsafeConfigPath = `/tmp/gno${controlCharacter}.yml`;
      for (const args of [
        ["--config", unsafeConfigPath, "mcp"],
        [`--config=${unsafeConfigPath}`, "mcp"],
      ]) {
        expect(
          await isSafeLocalGnoMcpCommand({ command: trustedGno, args }, trusted)
        ).toBe(false);
        expect(
          await isSafeLocalGnoMcpCommand(
            { command: process.execPath, args: [trustedGno, ...args] },
            trusted
          )
        ).toBe(false);
        expect(
          await isSafeLocalGnoMcpCommand(
            {
              command: process.execPath,
              args: ["run", trustedSource, ...args],
            },
            trusted
          )
        ).toBe(false);
      }
    }
    expect(
      await isSafeLocalGnoMcpCommand(
        {
          command: process.execPath,
          args: [trustedGno, "--config", "/tmp/gno.yml", "mcp"],
        },
        trusted
      )
    ).toBe(true);
    expect(
      await isSafeLocalGnoMcpCommand(
        {
          command: process.execPath,
          args: ["run", trustedSource, "--index=work", "mcp"],
        },
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
    for (const args of [
      ["--index", "mcp"],
      ["--index=", "mcp"],
      ["--index", "work", "--index", "other", "mcp"],
      ["--config", "--enable-write", "mcp"],
      ["--verbose", "mcp"],
      ["mcp", "--index", "work"],
      ["--index", "work", "mcp", "serve", "extra"],
    ]) {
      expect(
        await isSafeLocalGnoMcpCommand({ command: trustedGno, args }, trusted)
      ).toBe(false);
    }
    for (const indexName of [
      "../work",
      "work/other",
      "work\\other",
      "/tmp/work",
      "C:\\work",
      ".",
      "..",
      "work..other",
      ".hidden",
      "research index ",
      "research.index.",
      "research:index",
      "research?index",
      "a".repeat(65),
    ]) {
      expect(isValidIndexName(indexName)).toBe(false);
      expect(
        await isSafeLocalGnoMcpCommand(
          { command: trustedGno, args: ["--index", indexName, "mcp"] },
          trusted
        )
      ).toBe(false);
      expect(
        await isSafeLocalGnoMcpCommand(
          { command: trustedGno, args: [`--index=${indexName}`, "mcp"] },
          trusted
        )
      ).toBe(false);
    }
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
        command: fakeConventionalGno,
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
