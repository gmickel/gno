/** Byte-preserving YAML editor for the LibreChat MCP server entry. */

import type { ParsedServerEntry } from "./config-editors.js";

import { CliError } from "../../errors.js";
import {
  scanYamlTarget,
  type YamlMapSpan,
  type YamlPairSpan,
} from "./yaml-layout-scanner.js";

const yamlNewline = (content: string): "\r\n" | "\n" =>
  content.includes("\r\n") ? "\r\n" : "\n";

const parseYamlObject = (
  content: string,
  configPath: string
): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(content);
  } catch {
    throw new CliError("RUNTIME", `Malformed YAML in ${configPath}.`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("RUNTIME", `YAML root in ${configPath} must be a map.`);
  }
  return parsed as Record<string, unknown>;
};

const semanticEntry = (
  content: string,
  configPath: string,
  serversKey: string
): ParsedServerEntry => {
  const root = parseYamlObject(content, configPath);
  const servers = root[serversKey];
  if (servers === undefined) return { exists: false };
  if (
    servers === null ||
    typeof servers !== "object" ||
    Array.isArray(servers)
  ) {
    throw new CliError(
      "RUNTIME",
      `${serversKey} in ${configPath} must be a map.`
    );
  }
  if (!Object.hasOwn(servers, "gno")) return { exists: false };
  return { exists: true, entry: (servers as Record<string, unknown>).gno };
};

const serializeEntry = (entry: unknown): string => {
  const serialized = JSON.stringify(entry);
  if (serialized === undefined) {
    throw new CliError("RUNTIME", "Cannot serialize the GNO MCP YAML entry.");
  }
  return serialized;
};

const validateEdit = (
  content: string,
  configPath: string,
  serversKey: string,
  expected: unknown
): string => {
  const layout = scanYamlTarget(content, configPath, serversKey);
  const actual = semanticEntry(content, configPath, serversKey);
  if (expected === undefined) {
    if (layout.gnoPair || actual.exists) {
      throw new CliError(
        "RUNTIME",
        `Cannot safely remove ${serversKey}.gno from ${configPath}.`
      );
    }
  } else if (
    !layout.gnoPair ||
    !actual.exists ||
    JSON.stringify(actual.entry) !== JSON.stringify(expected)
  ) {
    throw new CliError(
      "RUNTIME",
      `Cannot safely update ${serversKey}.gno in ${configPath}.`
    );
  }
  return content;
};

const flowInsert = (
  content: string,
  map: YamlMapSpan,
  entry: unknown
): string => {
  const inner = content.slice(map.start + 1, map.end - 1);
  // Keep the original inner prefix byte-for-byte so removing this first item
  // restores the pre-install map, including its exact leading whitespace.
  const separator = inner.trim() ? "," : "";
  return `${content.slice(0, map.start + 1)}gno: ${serializeEntry(entry)}${separator}${content.slice(map.start + 1)}`;
};

const flowRemove = (
  content: string,
  map: YamlMapSpan,
  pair: YamlPairSpan
): string => {
  if (map.items.length === 1) {
    return `${content.slice(0, pair.start)}${content.slice(pair.end)}`;
  }
  if (pair.commaAfter !== undefined) {
    const end = pair.commaAfter + 1;
    return `${content.slice(0, pair.start)}${content.slice(end)}`;
  }
  if (pair.commaBefore !== undefined) {
    return `${content.slice(0, pair.commaBefore)}${content.slice(pair.end)}`;
  }
  throw new CliError("RUNTIME", "Cannot safely remove flow YAML entry.");
};

const blockPairText = (
  indent: string,
  entry: unknown,
  newline: string
): string => `${indent}gno: ${serializeEntry(entry)}${newline}`;

const blockPairEnd = (
  content: string,
  pair: YamlPairSpan,
  indent: number
): number => {
  const lineBreak = content.indexOf("\n", pair.start);
  const lineEnd = lineBreak === -1 ? content.length : lineBreak + 1;
  const firstLineValue = content.slice(pair.valueStart, lineEnd).trim();
  if (
    firstLineValue &&
    !firstLineValue.startsWith("#") &&
    !/^[>|]/u.test(firstLineValue)
  ) {
    return lineEnd;
  }

  let lastOwnedEnd = lineEnd;
  let cursor = lineEnd;
  while (cursor < pair.end) {
    const nextBreak = content.indexOf("\n", cursor);
    const fullEnd =
      nextBreak === -1 ? pair.end : Math.min(pair.end, nextBreak + 1);
    const line = content
      .slice(cursor, nextBreak === -1 ? pair.end : nextBreak)
      .replace(/\r$/u, "");
    const trimmed = line.trim();
    const childIndent = /^ */u.exec(line)?.[0].length ?? 0;
    if (trimmed && childIndent > indent) {
      lastOwnedEnd = fullEnd;
    }
    cursor = fullEnd;
  }
  return lastOwnedEnd;
};

export function getYamlServerEntry(
  content: string,
  configPath: string,
  serversKey: string
): ParsedServerEntry {
  const layout = scanYamlTarget(content, configPath, serversKey);
  const entry = semanticEntry(content, configPath, serversKey);
  if (entry.exists !== Boolean(layout.gnoPair)) {
    throw new CliError("RUNTIME", `Ambiguous YAML in ${configPath}.`);
  }
  return entry;
}

export function setYamlServerEntry(
  content: string,
  configPath: string,
  serversKey: string,
  entry: unknown
): string {
  parseYamlObject(content, configPath);
  const target = scanYamlTarget(content, configPath, serversKey);
  const newline = yamlNewline(content);
  let updated: string;
  if (!target.servers || !target.serversPair) {
    if (target.root.kind === "flow") {
      throw new CliError(
        "RUNTIME",
        `Cannot safely add ${serversKey} to a flow-style YAML root in ${configPath}.`
      );
    }
    // With no root pair, prepend before comment-only content. That keeps the
    // generated block independently removable even when the original file had
    // no final newline.
    const insertion = target.root.items[0]?.start ?? 0;
    const prefix =
      insertion > 0 && content[insertion - 1] !== "\n" ? newline : "";
    updated = `${content.slice(0, insertion)}${prefix}${serversKey}:${newline}  gno: ${serializeEntry(entry)}${newline}${content.slice(insertion)}`;
  } else if (target.servers.kind === "flow") {
    if (target.gnoPair) {
      updated = `${content.slice(0, target.gnoPair.start)}gno: ${serializeEntry(entry)}${content.slice(target.gnoPair.end)}`;
    } else {
      updated = flowInsert(content, target.servers, entry);
    }
  } else {
    const pairText = blockPairText(target.servers.indent, entry, newline);
    if (target.gnoPair) {
      const end = blockPairEnd(
        content,
        target.gnoPair,
        target.servers.indent.length
      );
      updated = `${content.slice(0, target.gnoPair.start)}${pairText}${content.slice(end)}`;
    } else {
      // Insert before an existing child so a no-final-newline file needs no
      // synthetic delimiter and uninstall can restore it byte-for-byte.
      const insertion = target.servers.items[0]?.start ?? target.servers.end;
      const prefix =
        insertion > 0 && content[insertion - 1] !== "\n" ? newline : "";
      updated = `${content.slice(0, insertion)}${prefix}${pairText}${content.slice(insertion)}`;
    }
  }
  return validateEdit(updated, configPath, serversKey, entry);
}

export function removeYamlServerEntry(
  content: string,
  configPath: string,
  serversKey: string
): { content: string; removed: boolean } {
  parseYamlObject(content, configPath);
  const target = scanYamlTarget(content, configPath, serversKey);
  if (!target.servers || !target.serversPair || !target.gnoPair) {
    return { content, removed: false };
  }
  let updated: string;
  if (target.servers.kind === "flow") {
    updated = flowRemove(content, target.servers, target.gnoPair);
  } else if (target.servers.items.length === 1) {
    const end = blockPairEnd(
      content,
      target.gnoPair,
      target.servers.indent.length
    );
    updated = `${content.slice(0, target.serversPair.start)}${content.slice(end)}`;
  } else {
    const end = blockPairEnd(
      content,
      target.gnoPair,
      target.servers.indent.length
    );
    updated = `${content.slice(0, target.gnoPair.start)}${content.slice(end)}`;
  }
  return {
    content: validateEdit(updated, configPath, serversKey, undefined),
    removed: true,
  };
}
