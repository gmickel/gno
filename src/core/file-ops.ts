/**
 * Shared file operations.
 *
 * @module src/core/file-ops
 */

// node:fs/promises for rename/unlink (no Bun equivalent for structure ops)
import { rename, unlink } from "node:fs/promises";

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
