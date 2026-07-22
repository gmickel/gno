import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises supplies symlink, mode, and directory operations that Bun
// does not expose and that are the behavior under test here.
import {
  chmod,
  lstat,
  mkdir,
  readlink,
  readdir,
  stat,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";

import { writeMcpConfigTextAtomically } from "../../src/cli/commands/mcp/atomic-config-write";
import { writeMcpConfigText } from "../../src/cli/commands/mcp/config";
import { safeRm } from "../helpers/cleanup";

const TEST_DIR = join(import.meta.dir, ".temp-mcp-atomic-config-write");
const IS_WINDOWS = process.platform === "win32";

beforeEach(async () => {
  await safeRm(TEST_DIR);
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await safeRm(TEST_DIR);
});

describe("writeMcpConfigTextAtomically", () => {
  test("atomically creates a new JSON config without leftover temporary files", async () => {
    const configDirectory = join(TEST_DIR, "nested");
    const configPath = join(configDirectory, "mcp.json");
    const content = `${JSON.stringify({ mcpServers: { gno: {} } }, null, 2)}\n`;

    await writeMcpConfigTextAtomically(configPath, content);

    expect(await Bun.file(configPath).text()).toBe(content);
    expect(await readdir(configDirectory)).toEqual(["mcp.json"]);
  });

  test.skipIf(IS_WINDOWS)(
    "preserves an existing regular file mode",
    async () => {
      const configPath = join(TEST_DIR, "mcp.json");
      await Bun.write(configPath, "{}\n");
      await chmod(configPath, 0o600);

      await writeMcpConfigTextAtomically(configPath, '{"updated":true}\n');

      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
      expect(await Bun.file(configPath).text()).toBe('{"updated":true}\n');
    }
  );

  test.skipIf(IS_WINDOWS)(
    "updates a TOML symlink target while preserving the link and target mode",
    async () => {
      const targetDirectory = join(TEST_DIR, "target");
      const linkDirectory = join(TEST_DIR, "link");
      await Promise.all([
        mkdir(targetDirectory, { recursive: true }),
        mkdir(linkDirectory, { recursive: true }),
      ]);
      const targetPath = join(targetDirectory, "config.toml");
      const configPath = join(linkDirectory, "config.toml");
      await Bun.write(targetPath, 'model = "old"\n');
      await chmod(targetPath, 0o640);
      await symlink(targetPath, configPath);

      const content = '[mcp_servers.gno]\ncommand = "bun"\n';
      await writeMcpConfigTextAtomically(configPath, content);

      expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
      expect(await readlink(configPath)).toBe(targetPath);
      expect(await Bun.file(targetPath).text()).toBe(content);
      expect((await stat(targetPath)).mode & 0o777).toBe(0o640);
      expect(await readdir(targetDirectory)).toEqual(["config.toml"]);
    }
  );

  test.skipIf(IS_WINDOWS)("fails closed for a dangling symlink", async () => {
    const missingTarget = join(TEST_DIR, "missing", "config.toml");
    const configPath = join(TEST_DIR, "config.toml");
    await symlink(missingTarget, configPath);

    let caughtError: unknown;
    try {
      await writeMcpConfigTextAtomically(
        configPath,
        '[mcp_servers.gno]\ncommand = "bun"\n'
      );
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toContain(
      "symbolic link target does not exist"
    );

    expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(configPath)).toBe(missingTarget);
    expect(await Bun.file(missingTarget).exists()).toBe(false);
    expect(await readdir(TEST_DIR)).toEqual(["config.toml"]);
  });

  test("fails closed before replacement when the backup cannot be written", async () => {
    const configPath = join(TEST_DIR, "mcp.json");
    await Bun.write(configPath, '{"original":true}\n');
    await mkdir(`${configPath}.bak`);
    let error: unknown;
    try {
      await writeMcpConfigText(configPath, '{"updated":true}\n');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(await Bun.file(configPath).text()).toBe('{"original":true}\n');
  });
});
