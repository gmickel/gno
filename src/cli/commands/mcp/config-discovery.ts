/** Resolve one unambiguous MCP client config filename. */

// node:fs/promises has no Bun equivalent for lstat, including dangling links.
import { lstat } from "node:fs/promises";

import type { McpConfigPaths } from "./paths.js";

import { CliError } from "../../errors.js";

export async function configPathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function resolveMcpConfigLocation(
  paths: McpConfigPaths
): Promise<string> {
  const candidates = [
    paths.configPath,
    ...(paths.alternativeConfigPaths ?? []),
  ];
  const present: string[] = [];
  for (const candidate of candidates) {
    if (await configPathEntryExists(candidate)) {
      present.push(candidate);
    }
  }
  if (present.length > 1) {
    throw new CliError(
      "RUNTIME",
      `Ambiguous MCP config files: ${present.join(", ")}. Keep exactly one.`
    );
  }
  return present[0] ?? paths.configPath;
}
