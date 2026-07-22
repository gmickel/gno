/** Byte-preserving YAML editor for the LibreChat MCP server entry. */

import {
  isMap,
  isScalar,
  type Node as YamlNode,
  parseDocument,
  stringify,
  type YAMLMap,
} from "yaml";

import type { ParsedServerEntry } from "./config-editors.js";

import { CliError } from "../../errors.js";

type ParsedYamlMap = YAMLMap.Parsed;
type ParsedYamlPair = ParsedYamlMap["items"][number];

interface ParsedYamlTarget {
  root: ParsedYamlMap | null;
  servers?: ParsedYamlMap;
  serversPair?: ParsedYamlPair;
  gnoPair?: ParsedYamlPair;
}

function parseYamlConfig(content: string, configPath: string) {
  const document = parseDocument(content, {
    keepSourceTokens: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new CliError("RUNTIME", `Malformed YAML in ${configPath}.`);
  }
  if (document.contents !== null && !isMap(document.contents)) {
    throw new CliError("RUNTIME", `YAML root in ${configPath} must be a map.`);
  }
  return document;
}

function yamlPairByKey(
  map: ParsedYamlMap,
  key: string
): ParsedYamlPair | undefined {
  return map.items.find(
    (pair) => isScalar(pair.key) && pair.key.value === key
  ) as ParsedYamlPair | undefined;
}

function parseYamlTarget(
  content: string,
  configPath: string,
  serversKey: string
): ParsedYamlTarget {
  const document = parseYamlConfig(content, configPath);
  if (document.contents === null) {
    return { root: null };
  }
  const root = document.contents as ParsedYamlMap;
  const serversPair = yamlPairByKey(root, serversKey);
  if (!serversPair) {
    return { root };
  }
  if (!isMap(serversPair.value)) {
    throw new CliError(
      "RUNTIME",
      `${serversKey} in ${configPath} must be a map.`
    );
  }
  const servers = serversPair.value as ParsedYamlMap;
  return {
    root,
    servers,
    serversPair,
    gnoPair: yamlPairByKey(servers, "gno"),
  };
}

function yamlNewline(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function lineStart(content: string, offset: number): number {
  return content.lastIndexOf("\n", offset - 1) + 1;
}

function lineIndent(content: string, offset: number): string {
  const start = lineStart(content, offset);
  const indent = content.slice(start, offset);
  if (!/^ *$/u.test(indent)) {
    throw new CliError("RUNTIME", "Unsupported YAML indentation.");
  }
  return indent;
}

function requireYamlRange(
  node: YamlNode | null,
  configPath: string
): [number, number, number] {
  if (!node?.range) {
    throw new CliError(
      "RUNTIME",
      `Cannot safely edit YAML layout in ${configPath}.`
    );
  }
  return node.range;
}

function yamlBlockIndentWidth(
  content: string,
  servers: ParsedYamlMap,
  childIndent: string
): number {
  for (const pair of servers.items) {
    if (
      !isMap(pair.value) ||
      pair.value.flow ||
      pair.value.items.length === 0
    ) {
      continue;
    }
    const nestedKey = pair.value.items[0]?.key;
    if (!nestedKey || !isScalar(nestedKey) || !nestedKey.range) {
      continue;
    }
    const nestedIndent = lineIndent(content, nestedKey.range[0]);
    if (nestedIndent.length > childIndent.length) {
      return nestedIndent.length - childIndent.length;
    }
  }
  return Math.max(childIndent.length, 2);
}

function serializeYamlBlockEntry(
  entry: unknown,
  childIndent: string,
  indentWidth: number,
  newline: string
): string {
  const serialized = stringify(
    { gno: entry },
    { indent: indentWidth, lineWidth: 0 }
  ).trimEnd();
  return `${serialized
    .split("\n")
    .map((line) => `${childIndent}${line}`)
    .join(newline)}${newline}`;
}

function serializeYamlFlowEntry(entry: unknown): string {
  const serialized = JSON.stringify(entry);
  if (serialized === undefined) {
    throw new CliError("RUNTIME", "Cannot serialize the GNO MCP YAML entry.");
  }
  return `gno: ${serialized}`;
}

function validateYamlEdit(
  content: string,
  configPath: string,
  serversKey: string
): string {
  getYamlServerEntry(content, configPath, serversKey);
  return content;
}

function setYamlFlowServerEntry(
  content: string,
  configPath: string,
  serversKey: string,
  servers: ParsedYamlMap,
  gnoPair: ParsedYamlPair | undefined,
  entry: unknown
): string {
  const range = requireYamlRange(servers, configPath);
  const innerStart = range[0] + 1;
  const innerEnd = range[1] - 1;
  const serialized = serializeYamlFlowEntry(entry);
  let updated: string;
  if (gnoPair) {
    const keyRange = requireYamlRange(gnoPair.key, configPath);
    const valueRange = requireYamlRange(gnoPair.value, configPath);
    updated = `${content.slice(0, keyRange[0])}${serialized}${content.slice(valueRange[1])}`;
  } else {
    const suffix = content.slice(innerStart, innerEnd).trim() ? ", " : "";
    updated = `${content.slice(0, innerStart)}${serialized}${suffix}${content.slice(innerStart)}`;
  }
  return validateYamlEdit(updated, configPath, serversKey);
}

function removeYamlFlowServerEntry(
  content: string,
  configPath: string,
  serversKey: string,
  servers: ParsedYamlMap,
  gnoPair: ParsedYamlPair
): string {
  const mapRange = requireYamlRange(servers, configPath);
  const keyRange = requireYamlRange(gnoPair.key, configPath);
  const valueRange = requireYamlRange(gnoPair.value, configPath);
  if (servers.items.length === 1) {
    return validateYamlEdit(
      `${content.slice(0, mapRange[0] + 1)}${content.slice(mapRange[1] - 1)}`,
      configPath,
      serversKey
    );
  }

  const itemIndex = servers.items.indexOf(gnoPair);
  let start = keyRange[0];
  let end = valueRange[1];
  if (itemIndex === 0) {
    const comma = content.indexOf(",", end);
    const nextKey = servers.items[1]?.key;
    const nextKeyRange = nextKey ? requireYamlRange(nextKey, configPath) : null;
    if (comma === -1 || !nextKeyRange || comma >= nextKeyRange[0]) {
      throw new CliError(
        "RUNTIME",
        `Cannot safely remove ${serversKey}.gno from ${configPath}.`
      );
    }
    end = comma + 1;
    if (content[end] === " ") {
      end += 1;
    }
  } else {
    const previousValue = servers.items[itemIndex - 1]?.value;
    const previousRange = previousValue
      ? requireYamlRange(previousValue, configPath)
      : null;
    const comma = previousRange ? content.lastIndexOf(",", keyRange[0]) : -1;
    if (!previousRange || comma < previousRange[1]) {
      throw new CliError(
        "RUNTIME",
        `Cannot safely remove ${serversKey}.gno from ${configPath}.`
      );
    }
    start = comma;
  }
  return validateYamlEdit(
    `${content.slice(0, start)}${content.slice(end)}`,
    configPath,
    serversKey
  );
}

export function getYamlServerEntry(
  content: string,
  configPath: string,
  serversKey: string
): ParsedServerEntry {
  const target = parseYamlTarget(content, configPath, serversKey);
  if (!target.servers || !target.gnoPair) {
    return { exists: false };
  }
  const node = target.gnoPair.value;
  return {
    exists: true,
    entry:
      node && typeof (node as { toJSON?: unknown }).toJSON === "function"
        ? (node as { toJSON: () => unknown }).toJSON()
        : node,
  };
}

export function setYamlServerEntry(
  content: string,
  configPath: string,
  serversKey: string,
  entry: unknown
): string {
  const target = parseYamlTarget(content, configPath, serversKey);
  const newline = yamlNewline(content);
  if (!target.servers) {
    if (target.root?.flow) {
      throw new CliError(
        "RUNTIME",
        `Cannot safely add ${serversKey} to a flow-style YAML root in ${configPath}.`
      );
    }
    const block = serializeYamlBlockEntry(entry, "  ", 2, newline);
    const firstKey = target.root?.items[0]?.key;
    const insertionOffset = firstKey
      ? lineStart(content, requireYamlRange(firstKey, configPath)[0])
      : content.length;
    return validateYamlEdit(
      `${content.slice(0, insertionOffset)}${serversKey}:${newline}${block}${content.slice(insertionOffset)}`,
      configPath,
      serversKey
    );
  }
  if (target.servers.flow) {
    return setYamlFlowServerEntry(
      content,
      configPath,
      serversKey,
      target.servers,
      target.gnoPair,
      entry
    );
  }

  const firstKey = target.servers.items[0]?.key;
  const keyForIndent = target.gnoPair?.key ?? firstKey;
  if (!keyForIndent || !isScalar(keyForIndent) || !keyForIndent.range) {
    throw new CliError(
      "RUNTIME",
      `Cannot safely determine ${serversKey} indentation in ${configPath}.`
    );
  }
  const childIndent = lineIndent(content, keyForIndent.range[0]);
  const indentWidth = yamlBlockIndentWidth(
    content,
    target.servers,
    childIndent
  );
  const serialized = serializeYamlBlockEntry(
    entry,
    childIndent,
    indentWidth,
    newline
  );
  if (target.gnoPair) {
    const valueRange = requireYamlRange(target.gnoPair.value, configPath);
    const start = lineStart(content, keyForIndent.range[0]);
    return validateYamlEdit(
      `${content.slice(0, start)}${serialized}${content.slice(valueRange[2])}`,
      configPath,
      serversKey
    );
  }
  const serversRange = requireYamlRange(target.servers, configPath);
  return validateYamlEdit(
    `${content.slice(0, serversRange[2])}${serialized}${content.slice(serversRange[2])}`,
    configPath,
    serversKey
  );
}

export function removeYamlServerEntry(
  content: string,
  configPath: string,
  serversKey: string
): { content: string; removed: boolean } {
  const target = parseYamlTarget(content, configPath, serversKey);
  if (!target.servers || !target.serversPair || !target.gnoPair) {
    return { content, removed: false };
  }
  if (target.servers.flow) {
    return {
      content: removeYamlFlowServerEntry(
        content,
        configPath,
        serversKey,
        target.servers,
        target.gnoPair
      ),
      removed: true,
    };
  }
  const valueRange = requireYamlRange(target.gnoPair.value, configPath);
  if (target.servers.items.length === 1) {
    const keyRange = requireYamlRange(target.serversPair.key, configPath);
    const start = lineStart(content, keyRange[0]);
    return {
      content: validateYamlEdit(
        `${content.slice(0, start)}${content.slice(valueRange[2])}`,
        configPath,
        serversKey
      ),
      removed: true,
    };
  }
  const keyRange = requireYamlRange(target.gnoPair.key, configPath);
  const start = lineStart(content, keyRange[0]);
  return {
    content: validateYamlEdit(
      `${content.slice(0, start)}${content.slice(valueRange[2])}`,
      configPath,
      serversKey
    ),
    removed: true,
  };
}
