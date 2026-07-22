/** Comment-preserving MCP client config readers and targeted editors. */

import {
  applyEdits,
  type FormattingOptions,
  getNodeValue,
  modify,
  type Node,
  type ParseError,
  parseTree,
  printParseErrorCode,
} from "jsonc-parser";

import type { AnyMcpConfig, StandardMcpEntry } from "./config.js";

import { CliError } from "../../errors.js";

export interface ParsedServerEntry {
  exists: boolean;
  entry?: unknown;
}

export function isPlainRecord(
  value: unknown
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateRootAndServers(
  root: unknown,
  serversKey: string,
  configPath: string,
  format: string
): Record<string, unknown> | undefined {
  if (!isPlainRecord(root)) {
    throw new CliError(
      "RUNTIME",
      `${format} root in ${configPath} must be an object.`
    );
  }
  const servers = root[serversKey];
  if (servers === undefined) {
    return undefined;
  }
  if (!isPlainRecord(servers)) {
    throw new CliError(
      "RUNTIME",
      `${serversKey} in ${configPath} must be an object.`
    );
  }
  return servers;
}

function jsoncFormatting(content: string): FormattingOptions {
  const indentMatch = content.match(/\n([ \t]+)\S/u)?.[1];
  return {
    insertSpaces: !indentMatch?.includes("\t"),
    tabSize: indentMatch?.includes("\t") ? 1 : (indentMatch?.length ?? 2),
    eol: content.includes("\r\n") ? "\r\n" : "\n",
  };
}

interface ParsedJsoncDocument {
  root: AnyMcpConfig;
  rootNode?: Node;
}

function jsoncPropertyNodes(objectNode: Node, propertyName: string): Node[] {
  return (objectNode.children ?? []).filter(
    (property) =>
      property.type === "property" &&
      property.children?.[0]?.value === propertyName
  );
}

function getUniqueJsoncPropertyValue(
  objectNode: Node,
  propertyName: string,
  configPath: string,
  location: string
): Node | undefined {
  const properties = jsoncPropertyNodes(objectNode, propertyName);
  if (properties.length > 1) {
    throw new CliError(
      "RUNTIME",
      `Ambiguous MCP JSONC config ${configPath}: duplicate "${propertyName}" key in ${location}.`
    );
  }
  return properties[0]?.children?.[1];
}

function parseJsoncRoot(
  content: string,
  configPath: string
): ParsedJsoncDocument {
  if (!content.trim()) {
    return { root: {} };
  }
  const errors: ParseError[] = [];
  const rootNode = parseTree(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: true,
  });
  if (errors.length > 0) {
    const first = errors[0];
    throw new CliError(
      "RUNTIME",
      `Malformed JSONC in ${configPath}: ${first ? printParseErrorCode(first.error) : "parse error"}.`
    );
  }
  const root = rootNode ? getNodeValue(rootNode) : undefined;
  if (!rootNode || rootNode.type !== "object" || !isPlainRecord(root)) {
    throw new CliError(
      "RUNTIME",
      `JSONC root in ${configPath} must be an object.`
    );
  }
  return { root: root as AnyMcpConfig, rootNode };
}

export function getJsoncServerEntry(
  content: string,
  configPath: string,
  serversKey: string
): ParsedServerEntry {
  const { root, rootNode } = parseJsoncRoot(content, configPath);
  const serversNode = rootNode
    ? getUniqueJsoncPropertyValue(
        rootNode,
        serversKey,
        configPath,
        "the root object"
      )
    : undefined;
  const servers = validateRootAndServers(root, serversKey, configPath, "JSONC");
  if (serversNode?.type === "object") {
    getUniqueJsoncPropertyValue(
      serversNode,
      "gno",
      configPath,
      `the "${serversKey}" server map`
    );
  }
  return servers && Object.hasOwn(servers, "gno")
    ? { exists: true, entry: servers.gno }
    : { exists: false };
}

export function setJsoncServerEntry(
  content: string,
  configPath: string,
  serversKey: string,
  entry: unknown
): string {
  getJsoncServerEntry(content, configPath, serversKey);
  const edits = modify(content, [serversKey, "gno"], entry, {
    formattingOptions: jsoncFormatting(content),
  });
  const updated = applyEdits(content, edits);
  getJsoncServerEntry(updated, configPath, serversKey);
  return updated.endsWith("\n")
    ? updated
    : `${updated}${jsoncFormatting(content).eol}`;
}

export function removeJsoncServerEntry(
  content: string,
  configPath: string,
  serversKey: string
): { content: string; removed: boolean } {
  const parsed = getJsoncServerEntry(content, configPath, serversKey);
  if (!parsed.exists) {
    return { content, removed: false };
  }
  const { root } = parseJsoncRoot(content, configPath);
  const servers = validateRootAndServers(root, serversKey, configPath, "JSONC");
  const path =
    servers && Object.keys(servers).length === 1
      ? [serversKey]
      : [serversKey, "gno"];
  const updated = applyEdits(
    content,
    modify(content, path, undefined, {
      formattingOptions: jsoncFormatting(content),
    })
  );
  getJsoncServerEntry(updated, configPath, serversKey);
  return { content: updated, removed: true };
}

export {
  getYamlServerEntry,
  removeYamlServerEntry,
  setYamlServerEntry,
} from "./yaml-config-editor.js";

const TOML_SECTION_PATTERN = /^\s*\[([^\]]+)]\s*(?:#.*)?$/;
const TOML_GNO_SECTION_PATTERN =
  /^\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:gno|"gno"|'gno')(?:\s*\.\s*(?:env|"env"|'env'))?\s*$/;
const TOML_GNO_DESCENDANT_PATTERN =
  /^\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:gno|"gno"|'gno')\s*\./;

interface TomlLine {
  text: string;
  isTable: boolean;
  isGnoTable: boolean;
  isUnsupportedGnoTable: boolean;
}

function isEscaped(value: string, position: number): boolean {
  let slashes = 0;
  for (
    let cursor = position - 1;
    cursor >= 0 && value[cursor] === "\\";
    cursor -= 1
  ) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function nextMultilineState(
  line: string,
  current: '"""' | "'''" | null
): '"""' | "'''" | null {
  let position = 0;
  if (current) {
    let closing = line.indexOf(current);
    while (closing !== -1 && current === '"""' && isEscaped(line, closing)) {
      closing = line.indexOf(current, closing + 3);
    }
    if (closing === -1) {
      return current;
    }
    position = closing + 3;
  }

  while (position < line.length) {
    const character = line[position];
    if (character === "#") {
      return null;
    }
    if (character === '"') {
      if (line.startsWith('"""', position)) {
        let closing = line.indexOf('"""', position + 3);
        while (closing !== -1 && isEscaped(line, closing)) {
          closing = line.indexOf('"""', closing + 3);
        }
        if (closing === -1) {
          return '"""';
        }
        position = closing + 3;
        continue;
      }
      position += 1;
      while (position < line.length) {
        if (line[position] === '"' && !isEscaped(line, position)) {
          position += 1;
          break;
        }
        position += 1;
      }
      continue;
    }
    if (character === "'") {
      if (line.startsWith("'''", position)) {
        const closing = line.indexOf("'''", position + 3);
        if (closing === -1) {
          return "'''";
        }
        position = closing + 3;
        continue;
      }
      const closing = line.indexOf("'", position + 1);
      position = closing === -1 ? line.length : closing + 1;
      continue;
    }
    position += 1;
  }
  return null;
}

function scanTomlLines(content: string): TomlLine[] {
  let multiline: '"""' | "'''" | null = null;
  return content.split(/\r?\n/).map((text) => {
    const outside = multiline === null;
    const section = outside ? text.match(TOML_SECTION_PATTERN)?.[1] : undefined;
    const line: TomlLine = {
      text,
      isTable: section !== undefined,
      isGnoTable:
        section !== undefined && TOML_GNO_SECTION_PATTERN.test(section),
      isUnsupportedGnoTable:
        section !== undefined &&
        TOML_GNO_DESCENDANT_PATTERN.test(section) &&
        !TOML_GNO_SECTION_PATTERN.test(section),
    };

    multiline = nextMultilineState(text, multiline);
    return line;
  });
}

function parseTomlRoot(content: string, configPath: string): AnyMcpConfig {
  if (!content.trim()) {
    return {};
  }
  try {
    const root = Bun.TOML.parse(content);
    if (!isPlainRecord(root)) {
      throw new Error("non-record root");
    }
    return root as AnyMcpConfig;
  } catch {
    throw new CliError("RUNTIME", `Malformed TOML in ${configPath}.`);
  }
}

export function getTomlServerEntry(
  content: string,
  configPath: string
): ParsedServerEntry {
  const root = parseTomlRoot(content, configPath);
  const servers = validateRootAndServers(
    root,
    "mcp_servers",
    configPath,
    "TOML"
  );
  return servers && Object.hasOwn(servers, "gno")
    ? { exists: true, entry: servers.gno }
    : { exists: false };
}

function removeTomlGnoSections(
  content: string,
  configPath: string
): { content: string; removed: boolean; newline: string } {
  const lines = scanTomlLines(content);
  if (lines.some(({ isUnsupportedGnoTable }) => isUnsupportedGnoTable)) {
    throw new CliError(
      "RUNTIME",
      `Unsupported nested GNO MCP entry in ${configPath}.`
    );
  }
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const kept: string[] = [];
  let removing = false;
  let removed = false;
  for (const line of lines) {
    if (line.isTable) {
      removing = line.isGnoTable;
      removed ||= removing;
    }
    if (!removing || line.text.trimStart().startsWith("#")) {
      kept.push(line.text);
    }
  }
  while (kept.at(-1) === "") {
    kept.pop();
  }
  return { content: kept.join(newline), removed, newline };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function serializeTomlEntry(entry: StandardMcpEntry, newline: string): string {
  const args = entry.args.map(tomlString).join(", ");
  const lines = [
    "[mcp_servers.gno]",
    `command = ${tomlString(entry.command)}`,
    `args = [${args}]`,
  ];
  if (entry.env && Object.keys(entry.env).length > 0) {
    lines.push("", "[mcp_servers.gno.env]");
    for (const key of ["GNO_DATA_DIR", "GNO_CACHE_DIR"] as const) {
      const value = entry.env[key];
      if (value) {
        lines.push(`${key} = ${tomlString(value)}`);
      }
    }
  }
  return `${lines.join(newline)}${newline}`;
}

export function setTomlServerEntry(
  content: string,
  configPath: string,
  entry: StandardMcpEntry
): string {
  const parsed = getTomlServerEntry(content, configPath);
  const removed = removeTomlGnoSections(content, configPath);
  if (parsed.exists && !removed.removed) {
    throw new CliError(
      "RUNTIME",
      `Unsupported inline GNO MCP entry in ${configPath}.`
    );
  }
  const prefix = removed.content.trimEnd();
  const updated = prefix
    ? `${prefix}${removed.newline}${removed.newline}${serializeTomlEntry(entry, removed.newline)}`
    : serializeTomlEntry(entry, removed.newline);
  parseTomlRoot(updated, configPath);
  return updated;
}

export function removeTomlServerEntry(
  content: string,
  configPath: string
): { content: string; removed: boolean } {
  const parsed = getTomlServerEntry(content, configPath);
  if (!parsed.exists) {
    return { content, removed: false };
  }
  const result = removeTomlGnoSections(content, configPath);
  if (!result.removed) {
    throw new CliError(
      "RUNTIME",
      `Unsupported inline GNO MCP entry in ${configPath}.`
    );
  }
  const updated = result.content ? `${result.content}${result.newline}` : "";
  parseTomlRoot(updated, configPath);
  return { content: updated, removed: true };
}
