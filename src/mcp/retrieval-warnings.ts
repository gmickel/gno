import type { SearchMeta } from "../pipeline/types";

import { METADATA_COVERAGE_GUIDANCE } from "../core/typed-metadata";

/** Text-only MCP clients need the same warnings as structured clients. */
export function appendRetrievalWarnings(
  text: string,
  warnings: SearchMeta["warnings"]
): string {
  if (!warnings?.length) return text;
  const lines = warnings.map(
    ({ code, message }) => `Warning [${code}]: ${message}`
  );
  if (
    warnings.some(
      ({ code }) =>
        code === "METADATA_COVERAGE_INCOMPLETE" ||
        code === "METADATA_COVERAGE_UNKNOWN"
    )
  ) {
    lines.push(METADATA_COVERAGE_GUIDANCE);
  }
  return `${text}\n\n${lines.join("\n")}`;
}
