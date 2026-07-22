import {
  getNodeValue,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError,
} from "jsonc-parser";

import { AgenticAgentError, AgenticHarnessError } from "./adapter";

const assertNoDuplicateKeys = (node: Node, path: string): void => {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0];
      const valueNode = property.children?.[1];
      const key = keyNode?.value;
      if (typeof key !== "string" || !valueNode) {
        throw new Error(`Malformed object property at ${path}`);
      }
      if (seen.has(key))
        throw new Error(`Duplicate JSON key at ${path}.${key}`);
      seen.add(key);
      assertNoDuplicateKeys(valueNode, `${path}.${key}`);
    }
    return;
  }
  if (node.type === "array") {
    for (const [index, child] of (node.children ?? []).entries()) {
      assertNoDuplicateKeys(child, `${path}[${index}]`);
    }
  }
};

const parseStrictJsonValue = (raw: string): unknown => {
  const errors: ParseError[] = [];
  const root = parseTree(raw, errors, {
    allowTrailingComma: false,
    disallowComments: true,
    allowEmptyContent: false,
  });
  if (errors.length > 0 || !root) {
    const first = errors[0];
    throw new Error(
      first ? printParseErrorCode(first.error) : "JSON value is empty"
    );
  }
  assertNoDuplicateKeys(root, "$");
  return getNodeValue(root) as unknown;
};

export const parseStrictAgentJson = (raw: string): unknown => {
  try {
    return parseStrictJsonValue(raw);
  } catch (cause) {
    throw new AgenticAgentError(
      "malformed_agent_json",
      `Agent output is not one JSON value under strict parsing: ${(cause as Error).message}`,
      { cause }
    );
  }
};

export const parseStrictHarnessJson = (raw: string, label: string): unknown => {
  try {
    return parseStrictJsonValue(raw);
  } catch (cause) {
    throw new AgenticHarnessError(
      "invalid_strict_json",
      `${label} is not strict JSON: ${(cause as Error).message}`,
      { cause }
    );
  }
};
