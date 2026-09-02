/**
 * Resolve a search/query string from a positional argument or --query-file.
 * `--query-file -` reads stdin so callers can keep the query off argv.
 *
 * @module src/cli/query-text
 */

import { CliError } from "./errors";

const readQueryFile = async (path: string): Promise<string> => {
  if (path.includes("\0")) {
    throw new CliError("VALIDATION", "--query-file path is invalid");
  }
  try {
    const raw =
      path === "-" ? await Bun.stdin.text() : await Bun.file(path).text();
    return raw.replace(/\s+$/u, "");
  } catch (error) {
    throw new CliError(
      "VALIDATION",
      error instanceof Error
        ? `Failed to read --query-file: ${error.message}`
        : "Failed to read --query-file"
    );
  }
};

export const resolveCliQueryText = async (
  positional: string | undefined,
  queryFile: unknown
): Promise<string> => {
  const file = typeof queryFile === "string" ? queryFile : "";
  const pos = positional ?? "";
  if (file !== "" && pos.trim() !== "") {
    throw new CliError("VALIDATION", "Pass a query or --query-file, not both");
  }
  if (file !== "") {
    return await readQueryFile(file);
  }
  return pos;
};
