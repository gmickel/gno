/**
 * Shared file operations.
 *
 * @module src/core/file-ops
 */

// node:fs/promises for rename/unlink (no Bun equivalent for structure ops)
import { rename, unlink } from "node:fs/promises";
// node:os platform: no Bun equivalent
import { platform } from "node:os";
// node:path dirname: no Bun equivalent
import { dirname } from "node:path";

export async function atomicWrite(
  path: string,
  content: string
): Promise<void> {
  const tempPath = `${path}.tmp.${crypto.randomUUID()}`;
  await Bun.write(tempPath, content);
  try {
    await rename(tempPath, path);
  } catch (e) {
    await unlink(tempPath).catch(() => {
      /* ignore cleanup errors */
    });
    throw e;
  }
}

async function runCommand(cmd: string[]): Promise<void> {
  const proc = Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode === 0) {
    return;
  }
  const stderr = await new Response(proc.stderr).text();
  throw new Error(stderr.trim() || `Command failed: ${cmd.join(" ")}`);
}

export async function renameFilePath(
  currentPath: string,
  nextPath: string
): Promise<void> {
  await rename(currentPath, nextPath);
}

export async function trashFilePath(path: string): Promise<void> {
  await runCommand(["trash", path]);
}

export async function revealFilePath(path: string): Promise<void> {
  if (platform() === "darwin") {
    await runCommand(["open", "-R", path]);
    return;
  }

  await runCommand(["xdg-open", dirname(path)]);
}
