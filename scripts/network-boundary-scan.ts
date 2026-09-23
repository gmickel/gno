/** Structural inventory scanner for shipped network/process callsites. */

import {
  createSourceFile,
  forEachChild,
  isArrayBindingPattern,
  isAsExpression,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNamespaceImport,
  isNewExpression,
  isNonNullExpression,
  isObjectBindingPattern,
  isParameter,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isStringLiteral,
  isTaggedTemplateExpression,
  isVariableDeclaration,
  type Expression,
  type Node,
  type SourceFile,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
} from "typescript";

export const NETWORK_PRIMITIVES = [
  "bun_connect",
  "bun_dns_lookup",
  "bun_serve",
  "child_process",
  "event_source",
  "fetch",
  "http_inference",
  "web_socket",
] as const;
export type NetworkPrimitive = (typeof NETWORK_PRIMITIVES)[number];

export interface DetectedNetworkCallsite {
  key: string;
  path: string;
  primitive: NetworkPrimitive;
  occurrence: number;
}

const CHILD_PROCESS_EXPORTS = new Set([
  "exec",
  "execFile",
  "execFileSync",
  "fork",
  "spawn",
  "spawnSync",
]);
const GLOBAL_ROOTS = new Set(["globalThis", "self", "window"]);
type NetworkNamespace = "bun" | "bun_dns" | "child_process" | "global";

const scriptKindFor = (path: string): ScriptKind => {
  if (path.endsWith(".tsx")) return ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ScriptKind.JSX;
  if (path.endsWith(".js")) return ScriptKind.JS;
  return ScriptKind.TS;
};

const staticMemberName = (expression: Expression): string | null => {
  if (isPropertyAccessExpression(expression)) return expression.name.text;
  if (isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    return argument && isStringLiteral(argument) ? argument.text : null;
  }
  return null;
};

const directPrimitive = (name: string): NetworkPrimitive | null => {
  if (name === "fetch" || name === "requestHttpInference") {
    return name === "fetch" ? "fetch" : "http_inference";
  }
  if (name === "EventSource") return "event_source";
  if (name === "WebSocket") return "web_socket";
  return null;
};

const rootMemberPrimitive = (
  root: NetworkNamespace,
  member: string
): NetworkPrimitive | null => {
  if (root === "global") return directPrimitive(member);
  if (root === "bun_dns") {
    return member === "lookup" ? "bun_dns_lookup" : null;
  }
  if (root === "child_process") {
    return CHILD_PROCESS_EXPORTS.has(member) ? "child_process" : null;
  }
  if (root !== "bun") return null;
  if (member === "serve") return "bun_serve";
  if (member === "connect") return "bun_connect";
  if (member === "spawn" || member === "spawnSync" || member === "$") {
    return "child_process";
  }
  return null;
};

const expressionNamespace = (
  expression: Expression,
  namespaces: ReadonlyMap<string, NetworkNamespace>
): NetworkNamespace | null => {
  if (
    isParenthesizedExpression(expression) ||
    isAsExpression(expression) ||
    isNonNullExpression(expression)
  ) {
    return expressionNamespace(expression.expression, namespaces);
  }
  if (isIdentifier(expression)) {
    if (expression.text === "Bun") return "bun";
    if (GLOBAL_ROOTS.has(expression.text)) return "global";
    return namespaces.get(expression.text) ?? null;
  }
  const member = staticMemberName(expression);
  if (member !== "dns") return null;
  const parent =
    isPropertyAccessExpression(expression) ||
    isElementAccessExpression(expression)
      ? expression.expression
      : null;
  return parent && expressionNamespace(parent, namespaces) === "bun"
    ? "bun_dns"
    : null;
};

const expressionPrimitive = (
  expression: Expression,
  aliases: ReadonlyMap<string, NetworkPrimitive>,
  namespaces: ReadonlyMap<string, NetworkNamespace>
): NetworkPrimitive | null => {
  if (
    isParenthesizedExpression(expression) ||
    isAsExpression(expression) ||
    isNonNullExpression(expression)
  ) {
    return expressionPrimitive(expression.expression, aliases, namespaces);
  }
  if (
    isBinaryExpression(expression) &&
    expression.operatorToken.kind === SyntaxKind.QuestionQuestionToken
  ) {
    return (
      expressionPrimitive(expression.left, aliases, namespaces) ??
      expressionPrimitive(expression.right, aliases, namespaces)
    );
  }
  if (isIdentifier(expression)) {
    return aliases.get(expression.text) ?? directPrimitive(expression.text);
  }
  const member = staticMemberName(expression);
  if (!member) return null;
  const parent =
    isPropertyAccessExpression(expression) ||
    isElementAccessExpression(expression)
      ? expression.expression
      : null;
  const root = parent ? expressionNamespace(parent, namespaces) : null;
  return root ? rootMemberPrimitive(root, member) : null;
};

const recordBindingAliases = (
  name: Node,
  initializer: Expression | undefined,
  aliases: Map<string, NetworkPrimitive>,
  namespaces: Map<string, NetworkNamespace>
): void => {
  if (!initializer) return;
  if (isIdentifier(name)) {
    const namespace = expressionNamespace(initializer, namespaces);
    if (namespace) namespaces.set(name.text, namespace);
    const primitive = expressionPrimitive(initializer, aliases, namespaces);
    if (primitive) aliases.set(name.text, primitive);
    return;
  }
  if (!isObjectBindingPattern(name)) return;
  const root = expressionNamespace(initializer, namespaces);
  for (const element of name.elements) {
    if (!isBindingElement(element) || !isIdentifier(element.name)) continue;
    const property = element.propertyName ?? element.name;
    const member =
      isIdentifier(property) || isStringLiteral(property)
        ? property.text
        : null;
    if (!(root && member)) continue;
    const primitive = rootMemberPrimitive(root, member);
    if (primitive) aliases.set(element.name.text, primitive);
  }
};

const collectAliases = (
  sourceFile: SourceFile
): {
  aliases: Map<string, NetworkPrimitive>;
  namespaces: Map<string, NetworkNamespace>;
} => {
  const aliases = new Map<string, NetworkPrimitive>();
  const namespaces = new Map<string, NetworkNamespace>();
  const visit = (node: Node): void => {
    if (isImportDeclaration(node) && isStringLiteral(node.moduleSpecifier)) {
      if (
        node.moduleSpecifier.text === "node:child_process" ||
        node.moduleSpecifier.text === "child_process"
      ) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const imported = element.propertyName?.text ?? element.name.text;
            if (CHILD_PROCESS_EXPORTS.has(imported)) {
              aliases.set(element.name.text, "child_process");
            }
          }
        } else if (bindings && isNamespaceImport(bindings)) {
          namespaces.set(bindings.name.text, "child_process");
        }
      }
    } else if (isVariableDeclaration(node)) {
      recordBindingAliases(node.name, node.initializer, aliases, namespaces);
    } else if (isParameter(node) && !isArrayBindingPattern(node.name)) {
      recordBindingAliases(node.name, node.initializer, aliases, namespaces);
    } else if (
      isBinaryExpression(node) &&
      node.operatorToken.kind === SyntaxKind.EqualsToken &&
      isIdentifier(node.left)
    ) {
      const namespace = expressionNamespace(node.right, namespaces);
      if (namespace) namespaces.set(node.left.text, namespace);
      const primitive = expressionPrimitive(node.right, aliases, namespaces);
      if (primitive) aliases.set(node.left.text, primitive);
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return { aliases, namespaces };
};

const callPrimitive = (
  node: Node,
  aliases: ReadonlyMap<string, NetworkPrimitive>,
  namespaces: ReadonlyMap<string, NetworkNamespace>
): NetworkPrimitive | null => {
  if (isCallExpression(node) || isNewExpression(node)) {
    return expressionPrimitive(node.expression, aliases, namespaces);
  }
  if (isTaggedTemplateExpression(node)) {
    return expressionPrimitive(node.tag, aliases, namespaces);
  }
  return null;
};

export const scanNetworkBoundarySource = (
  path: string,
  source: string
): DetectedNetworkCallsite[] => {
  const sourceFile = createSourceFile(
    path,
    source,
    ScriptTarget.Latest,
    true,
    scriptKindFor(path)
  );
  const { aliases, namespaces } = collectAliases(sourceFile);
  const counts = new Map<NetworkPrimitive, number>();
  const callsites: DetectedNetworkCallsite[] = [];
  const visit = (node: Node): void => {
    const primitive = callPrimitive(node, aliases, namespaces);
    if (primitive) {
      const occurrence = (counts.get(primitive) ?? 0) + 1;
      counts.set(primitive, occurrence);
      callsites.push({
        key: `${path}::${primitive}#${occurrence}`,
        path,
        primitive,
        occurrence,
      });
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return callsites;
};

export const scanShippedNetworkBoundaries = async (
  root = "."
): Promise<DetectedNetworkCallsite[]> => {
  const callsites: DetectedNetworkCallsite[] = [];
  for await (const relativePath of new Bun.Glob(
    "src/**/*.{ts,tsx,js,jsx}"
  ).scan(root)) {
    if (relativePath.endsWith(".d.ts")) continue;
    callsites.push(
      ...scanNetworkBoundarySource(
        relativePath.replaceAll("\\", "/"),
        await Bun.file(`${root}/${relativePath}`).text()
      )
    );
  }
  return callsites.sort((left, right) => left.key.localeCompare(right.key));
};
