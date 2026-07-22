/**
 * Symlink-safe atomic writes for MCP configuration files.
 *
 * @module src/cli/commands/mcp/atomic-config-write
 */

// node:fs/promises supplies structural and metadata operations that Bun does
// not expose: symlink inspection/resolution, atomic rename, mode changes, and
// best-effort temporary-file cleanup.
import {
  chmod,
  lstat,
  mkdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
// node:path supplies path manipulation; Bun has no equivalent.
import { basename, dirname, join } from "node:path";

import { CliError } from "../../errors.js";

interface ResolvedWriteTarget {
  mode?: number;
  path: string;
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function configPathError(configPath: string, detail: string): CliError {
  return new CliError(
    "RUNTIME",
    `Cannot write MCP config ${configPath}: ${detail}`
  );
}

async function resolveWriteTarget(
  configPath: string
): Promise<ResolvedWriteTarget> {
  let pathStats: Awaited<ReturnType<typeof lstat>>;
  try {
    pathStats = await lstat(configPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return { path: configPath };
    }
    throw error;
  }

  if (!pathStats.isSymbolicLink()) {
    if (!pathStats.isFile()) {
      throw configPathError(configPath, "path exists but is not a file");
    }
    return { mode: pathStats.mode & 0o7777, path: configPath };
  }

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(configPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw configPathError(configPath, "symbolic link target does not exist");
    }
    throw error;
  }

  const targetStats = await stat(resolvedPath);
  if (!targetStats.isFile()) {
    throw configPathError(configPath, "symbolic link target is not a file");
  }

  return { mode: targetStats.mode & 0o7777, path: resolvedPath };
}

/**
 * Atomically replace an MCP config file with serialized JSON, YAML, or TOML.
 *
 * Existing file permissions survive replacement. A config-path symlink remains
 * in place: its resolved file is replaced by a temporary sibling. Dangling
 * symlinks fail closed instead of being replaced with regular files.
 */
export async function writeMcpConfigTextAtomically(
  configPath: string,
  content: string
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });

  const target = await resolveWriteTarget(configPath);
  const targetDirectory = dirname(target.path);
  const tempPath = join(
    targetDirectory,
    `.${basename(target.path)}.gno-tmp-${process.pid}-${crypto.randomUUID()}`
  );

  try {
    await Bun.write(tempPath, content, {
      createPath: false,
      ...(target.mode === undefined ? {} : { mode: target.mode & 0o777 }),
    });
    if (target.mode !== undefined) {
      // Bun 1.3 does not consistently apply Bun.write's mode option on macOS.
      await chmod(tempPath, target.mode);
    }
    await rename(tempPath, target.path);
  } catch (error) {
    await unlink(tempPath).catch(() => {
      // The write may have failed before creating the temporary file.
    });
    throw error;
  }
}
