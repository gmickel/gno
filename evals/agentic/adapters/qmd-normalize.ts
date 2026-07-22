import type { QmdMcpCallResult } from "../lifecycle/qmd-mcp";
import type { QmdToolName } from "../qmd-lock";
import type {
  AgentTask,
  CorpusSnapshot,
  CorpusSnapshotFile,
  NormalizedToolEvidence,
  NormalizedToolResult,
} from "../types";

import { AgenticHarnessError } from "../adapter";
import { normalizeNewlines, sha256Bytes } from "../canonical";

export interface QmdEvidenceScope {
  snapshot: CorpusSnapshot;
  task: Readonly<AgentTask>;
  diagnostics: string[];
}

const qmdUri = (uri: string): string =>
  uri.startsWith("gno://") ? `qmd://${uri.slice("gno://".length)}` : uri;

const canonicalUri = (uri: string): string => {
  if (uri.startsWith("qmd://")) {
    const path = uri.slice("qmd://".length);
    try {
      return `gno://${decodeURIComponent(path)}`;
    } catch {
      return `gno://${path}`;
    }
  }
  if (uri.startsWith("gno://")) return uri;
  return `gno://${uri.replace(/^\/+/, "")}`;
};

const validateRawEnvelope = (value: unknown): QmdMcpCallResult => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgenticHarnessError(
      "qmd_malformed_output",
      "qmd MCP returned a malformed result envelope"
    );
  }
  const result = value as Partial<QmdMcpCallResult>;
  const structuredContent = result.structuredContent;
  if (
    !Array.isArray(result.content) ||
    (result.isError !== undefined && typeof result.isError !== "boolean") ||
    (structuredContent !== undefined &&
      (!structuredContent ||
        typeof structuredContent !== "object" ||
        Array.isArray(structuredContent)))
  ) {
    throw new AgenticHarnessError(
      "qmd_malformed_output",
      "qmd MCP returned a malformed result envelope"
    );
  }
  return result as QmdMcpCallResult;
};

const textContent = (result: QmdMcpCallResult): string =>
  result.content
    .map((item) => {
      if (!item || typeof item !== "object") {
        throw new AgenticHarnessError(
          "qmd_malformed_output",
          "qmd MCP returned a non-object content block"
        );
      }
      const block = item as {
        type?: unknown;
        text?: unknown;
        resource?: { text?: unknown };
      };
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (
        block.type === "resource" &&
        typeof block.resource?.text === "string"
      ) {
        return block.resource.text;
      }
      throw new AgenticHarnessError(
        "qmd_malformed_output",
        "qmd MCP returned an unsupported content block"
      );
    })
    .join("\n\n");

const sourceForUri = (
  scope: QmdEvidenceScope,
  uri: string
): { file: CorpusSnapshotFile; uri: string; lines: string[] } => {
  const normalizedUri = canonicalUri(uri);
  const file = scope.snapshot.files.find(
    (candidate) =>
      candidate.taskId === scope.task.taskId &&
      scope.task.corpus.collections.includes(candidate.collection) &&
      `gno://${candidate.collection}/${candidate.relPath}` === normalizedUri
  );
  if (!file) {
    throw new AgenticHarnessError(
      "qmd_scope_violation",
      "qmd returned content outside the active task snapshot"
    );
  }
  const normalized = normalizeNewlines(file.content);
  return {
    file,
    uri: normalizedUri,
    lines: normalized.endsWith("\n")
      ? normalized.slice(0, -1).split("\n")
      : normalized.split("\n"),
  };
};

const exactEvidenceLine = (
  source: ReturnType<typeof sourceForUri>,
  lineNumber: number,
  returnedText: string,
  scope: QmdEvidenceScope
): NormalizedToolEvidence | null => {
  const expected = source.lines[lineNumber - 1];
  if (expected === undefined || expected !== returnedText) {
    scope.diagnostics.push(
      "qmd evidence omitted: returned line is partial, ellipsized, or differs from snapshot"
    );
    return null;
  }
  return {
    uri: source.uri,
    sourceHash: source.file.sourceHash,
    startLine: lineNumber,
    endLine: lineNumber,
    spanHash: sha256Bytes(returnedText),
    sourceHashProvenance: "harness_observed",
    spanHashProvenance: "harness_observed",
    text: returnedText,
    backendSourceHash: null,
    backendSpanHash: null,
    backendHashUnavailableReason:
      "qmd does not return backend hashes; harness verified exact returned lines against snapshot bytes",
  };
};

const searchEvidence = (
  result: QmdMcpCallResult,
  scope: QmdEvidenceScope
): NormalizedToolEvidence[] => {
  const results = result.structuredContent?.results;
  if (!Array.isArray(results)) {
    throw new AgenticHarnessError(
      "qmd_malformed_output",
      "qmd query omitted structuredContent.results"
    );
  }
  return results.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AgenticHarnessError(
        "qmd_malformed_output",
        "qmd query returned a malformed result"
      );
    }
    const row = item as { file?: unknown; line?: unknown; snippet?: unknown };
    if (
      typeof row.file !== "string" ||
      !Number.isSafeInteger(row.line) ||
      (row.line as number) < 1 ||
      typeof row.snippet !== "string"
    ) {
      throw new AgenticHarnessError(
        "qmd_malformed_output",
        "qmd query result lacks file/line/snippet"
      );
    }
    const source = sourceForUri(scope, row.file);
    const returnedLines = normalizeNewlines(row.snippet)
      .split("\n")
      .map((line) => line.replace(/^\d+: ?/, ""));
    const header = /^@@ -(\d+),(\d+) @@/.exec(returnedLines[0] ?? "");
    if (!header) {
      scope.diagnostics.push(
        "qmd evidence omitted: query snippet lacks exact inner range header"
      );
      return [];
    }
    const startLine = Number(header[1]);
    return returnedLines
      .slice(1)
      .map((text, index) =>
        exactEvidenceLine(source, startLine + index, text, scope)
      )
      .filter((item): item is NormalizedToolEvidence => item !== null);
  });
};

const resourceEvidence = (
  result: QmdMcpCallResult,
  scope: QmdEvidenceScope
): NormalizedToolEvidence[] =>
  result.content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const block = item as {
      type?: unknown;
      resource?: { uri?: unknown; text?: unknown };
    };
    if (block.type === "text") return [];
    if (
      block.type !== "resource" ||
      typeof block.resource?.uri !== "string" ||
      typeof block.resource.text !== "string"
    ) {
      throw new AgenticHarnessError(
        "qmd_malformed_output",
        "qmd retrieval returned a malformed resource"
      );
    }
    const source = sourceForUri(scope, block.resource.uri);
    return normalizeNewlines(block.resource.text)
      .split("\n")
      .map((line) => /^(\d+): ?(.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) =>
        exactEvidenceLine(source, Number(match[1]), match[2] ?? "", scope)
      )
      .filter(
        (evidence): evidence is NormalizedToolEvidence => evidence !== null
      );
  });

const unsupportedSearchKeys = new Set([
  "filters",
  "lang",
  "exclude",
  "since",
  "until",
  "categories",
  "author",
  "queryModes",
  "fast",
  "thorough",
  "expand",
  "graph",
  "tagsAll",
  "tagsAny",
]);

const uriVisibleToTask = (
  snapshot: CorpusSnapshot,
  task: Readonly<AgentTask>,
  uri: string
): boolean =>
  snapshot.files.some(
    (file) =>
      file.taskId === task.taskId &&
      `gno://${file.collection}/${file.relPath}` === uri
  );

export const mapQmdToolCall = (
  toolName: string,
  arguments_: Record<string, unknown>,
  snapshot: CorpusSnapshot,
  task: Readonly<AgentTask>
): { name: QmdToolName; arguments: Record<string, unknown> } => {
  if (toolName === "search") {
    for (const key of unsupportedSearchKeys) {
      if (arguments_[key] !== undefined) {
        throw new AgenticHarnessError(
          "qmd_unsupported_contract",
          `qmd cannot faithfully map search.${key}`
        );
      }
    }
    if (typeof arguments_.query !== "string" || !arguments_.query.trim()) {
      throw new AgenticHarnessError(
        "qmd_invalid_arguments",
        "qmd search requires a nonempty query"
      );
    }
    if (
      typeof arguments_.collection === "string" &&
      !task.corpus.collections.includes(arguments_.collection)
    ) {
      throw new AgenticHarnessError(
        "qmd_scope_violation",
        "qmd search collection is outside the active task"
      );
    }
    const mapped: Record<string, unknown> = {
      query: arguments_.query,
      rerank: arguments_.rerank ?? true,
      collections:
        typeof arguments_.collection === "string"
          ? [arguments_.collection]
          : [...task.corpus.collections],
    };
    for (const key of [
      "limit",
      "minScore",
      "candidateLimit",
      "intent",
    ] as const) {
      if (arguments_[key] !== undefined) mapped[key] = arguments_[key];
    }
    return { name: "query", arguments: mapped };
  }
  if (toolName === "get") {
    if (typeof arguments_.uri !== "string" || !arguments_.uri) {
      throw new AgenticHarnessError(
        "qmd_invalid_arguments",
        "qmd get requires uri"
      );
    }
    const uri = canonicalUri(arguments_.uri);
    if (!uriVisibleToTask(snapshot, task, uri)) {
      throw new AgenticHarnessError(
        "qmd_scope_violation",
        "qmd get URI is outside the active task"
      );
    }
    const mapped: Record<string, unknown> = {
      file: qmdUri(uri),
      lineNumbers: true,
    };
    if (arguments_.fromLine !== undefined)
      mapped.fromLine = arguments_.fromLine;
    if (arguments_.lineCount !== undefined)
      mapped.maxLines = arguments_.lineCount;
    return { name: "get", arguments: mapped };
  }
  if (toolName === "multi_get") {
    if (
      !Array.isArray(arguments_.uris) ||
      arguments_.uris.length === 0 ||
      !arguments_.uris.every((uri) => typeof uri === "string")
    ) {
      throw new AgenticHarnessError(
        "qmd_invalid_arguments",
        "qmd multi_get requires string uris"
      );
    }
    const uris = arguments_.uris.map((uri) => canonicalUri(uri as string));
    if (uris.some((uri) => !uriVisibleToTask(snapshot, task, uri))) {
      throw new AgenticHarnessError(
        "qmd_scope_violation",
        "qmd multi_get URI is outside the active task"
      );
    }
    const mapped: Record<string, unknown> = {
      pattern: uris.map((uri) => qmdUri(uri)).join(","),
      lineNumbers: true,
    };
    if (arguments_.maxBytes !== undefined)
      mapped.maxBytes = arguments_.maxBytes;
    return { name: "multi_get", arguments: mapped };
  }
  throw new AgenticHarnessError(
    "qmd_unsupported_tool",
    `qmd adapter cannot call ${toolName}`
  );
};

export const normalizeQmdToolResult = (
  toolName: string,
  raw: QmdMcpCallResult,
  scope: QmdEvidenceScope,
  sanitize: (value: string) => string
): NormalizedToolResult => {
  const validated = validateRawEnvelope(raw);
  const evidence =
    toolName === "search"
      ? validated.isError && validated.structuredContent?.results === undefined
        ? []
        : searchEvidence(validated, scope)
      : resourceEvidence(validated, scope);
  const content = sanitize(textContent(validated));
  if (validated.isError) {
    return {
      status: "error",
      resultRole: toolName === "search" ? "candidates" : "source",
      content,
      evidence: [],
      errorCode: "qmd_tool_error",
    };
  }
  return {
    status: "ok",
    resultRole: toolName === "search" ? "candidates" : "source",
    content,
    evidence,
    errorCode: null,
  };
};
