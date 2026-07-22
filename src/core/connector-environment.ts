/** Audited environment contract for local MCP connector execution. */

// node:path has no Bun equivalent for portable absolute-path validation.
import { isAbsolute, normalize } from "node:path";

export const CONNECTOR_WORKSPACE_ENV_KEYS = [
  "GNO_DATA_DIR",
  "GNO_CACHE_DIR",
] as const;

export type ConnectorWorkspaceEnvKey =
  (typeof CONNECTOR_WORKSPACE_ENV_KEYS)[number];
export type ConnectorWorkspaceEnvironment = Partial<
  Record<ConnectorWorkspaceEnvKey, string>
>;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) {
      return true;
    }
  }
  return false;
}

/**
 * Accept no execution environment semantics except absolute data/cache roots.
 * An absent environment is valid for legacy, manually configured entries.
 */
export function normalizeConnectorWorkspaceEnvironment(
  input: unknown
): ConnectorWorkspaceEnvironment | null {
  if (input === undefined) {
    return {};
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }

  const record = input as Record<string, unknown>;
  const allowed = new Set<string>(CONNECTOR_WORKSPACE_ENV_KEYS);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    return null;
  }

  const normalized: ConnectorWorkspaceEnvironment = {};
  for (const key of CONNECTOR_WORKSPACE_ENV_KEYS) {
    const value = record[key];
    if (value === undefined) {
      continue;
    }
    if (
      typeof value !== "string" ||
      !value ||
      !isAbsolute(value) ||
      hasControlCharacter(value)
    ) {
      return null;
    }
    normalized[key] = normalize(value);
  }
  return normalized;
}
