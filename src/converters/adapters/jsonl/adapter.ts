import type {
  RecordAdapter,
  RecordAdapterEvent,
  RecordAdapterInput,
  RecordAdapterRecord,
  RecordMetadata,
} from "../../types";

import {
  adapterLineByteLimit,
  canonicalJson,
  hashRecordValue,
  safeInlineText,
  safeMarkdownText,
  scalarList,
  scalarText,
  sourceNamespace,
} from "../shared/record-utils";
import { readBoundedUtf8Lines } from "../shared/utf8-lines";
import {
  type JsonlFieldMapping,
  parseJsonlFieldMapping,
  resolveJsonlField,
} from "./config";

const ADAPTER_ID = "adapter/jsonl";
const ADAPTER_VERSION = "1.0.0";
const DEFAULT_ID_SELECTORS = ["/id", "/externalId", "/external_id"];
const DEFAULT_BODY_SELECTORS = ["/text", "/content", "/body"];
const DEFAULT_TITLE_SELECTORS = ["/title", "/name"];
const DEFAULT_AUTHOR_SELECTORS = ["/author", "/creator"];

const failure = (
  code: "MALFORMED_RECORD" | "MISSING_ID" | "RECORD_TOO_LARGE",
  lineNumber: number,
  retryable = false
): RecordAdapterEvent => ({
  type: "failure",
  failure: {
    code,
    message: "JSONL record could not be converted.",
    retryable,
    sourceLocator: `line:${lineNumber}`,
  },
});

const requireScalar = (
  value: unknown
): { ok: true; value?: string } | { ok: false } => {
  if (value === undefined || value === null) return { ok: true };
  const scalar = scalarText(value);
  return scalar ? { ok: true, value: scalar } : { ok: false };
};

const markdownBody = (value: unknown): string => {
  const scalar = scalarText(value);
  if (scalar !== undefined) return safeMarkdownText(scalar);
  return safeMarkdownText(canonicalJson(value));
};

const buildMetadata = (
  source: Record<string, unknown>,
  mapping: JsonlFieldMapping
): { ok: true; metadata: RecordMetadata } | { ok: false } => {
  const author = requireScalar(resolveJsonlField(source, mapping.author));
  const sessionId = requireScalar(resolveJsonlField(source, mapping.sessionId));
  const threadId = requireScalar(resolveJsonlField(source, mapping.threadId));
  if (!(author.ok && sessionId.ok && threadId.ok)) return { ok: false };

  const participantsValue = resolveJsonlField(source, mapping.participants);
  const categoriesValue = resolveJsonlField(source, mapping.categories);
  const participants = scalarList(participantsValue);
  const categories = scalarList(categoriesValue);
  if (
    (participantsValue !== undefined && !participants) ||
    (categoriesValue !== undefined && !categories)
  ) {
    return { ok: false };
  }

  const dateFields: Record<string, string> = {};
  for (const [name, selector] of Object.entries(mapping.dateFields ?? {})) {
    const raw = resolveJsonlField(source, selector);
    const value = requireScalar(raw);
    if (!value.ok) return { ok: false };
    if (value.value) dateFields[name] = value.value;
  }

  return {
    ok: true,
    metadata: {
      author: author.value,
      participants,
      categories,
      dateFields: Object.keys(dateFields).length > 0 ? dateFields : undefined,
      sessionId: sessionId.value,
      threadId: threadId.value,
    },
  };
};

const recordFromLine = (
  source: Record<string, unknown>,
  lineNumber: number,
  container: string,
  mapping: JsonlFieldMapping,
  authorMapping: JsonlFieldMapping,
  allowConventionalId: boolean
): RecordAdapterEvent => {
  const canonicalSource = canonicalJson(source);
  const configuredId = resolveJsonlField(
    source,
    mapping.id ?? (allowConventionalId ? DEFAULT_ID_SELECTORS : undefined)
  );
  const id = requireScalar(configuredId);
  if (!id.ok) return failure("MALFORMED_RECORD", lineNumber);
  if (mapping.id && !id.value) return failure("MISSING_ID", lineNumber);

  const configuredBody = resolveJsonlField(
    source,
    mapping.body ?? DEFAULT_BODY_SELECTORS
  );
  if (mapping.body && configuredBody === undefined) {
    return failure("MALFORMED_RECORD", lineNumber);
  }
  const body = configuredBody ?? source;
  const titleValue = requireScalar(
    resolveJsonlField(source, mapping.title ?? DEFAULT_TITLE_SELECTORS)
  );
  if (!titleValue.ok) return failure("MALFORMED_RECORD", lineNumber);
  const metadata = buildMetadata(source, authorMapping);
  if (!metadata.ok) return failure("MALFORMED_RECORD", lineNumber);

  const identity = id.value
    ? `id:${hashRecordValue("gno-jsonl-external-id-v1", id.value)}`
    : `content:${hashRecordValue("gno-jsonl-content-id-v1", canonicalSource)}`;
  const title = titleValue.value ?? `JSONL record ${lineNumber}`;
  const record: RecordAdapterRecord = {
    stableId: `jsonl:${container}:${identity}`,
    sourceLocator: `line:${lineNumber}`,
    sourceHash: hashRecordValue("gno-jsonl-source-v1", canonicalSource),
    title,
    markdown: `# ${safeInlineText(title)}\n\n${markdownBody(body)}`,
    metadata: metadata.metadata,
    anchors: [{ kind: "line", value: String(lineNumber) }],
  };
  return { type: "record", record };
};

export const createJsonlAdapter = (
  fieldMapping?: JsonlFieldMapping
): RecordAdapter => {
  const mapping = parseJsonlFieldMapping(fieldMapping);
  const authorMapping = mapping.author
    ? mapping
    : { ...mapping, author: DEFAULT_AUTHOR_SELECTORS };
  const allowConventionalId = fieldMapping === undefined;
  return {
    id: ADAPTER_ID,
    version: ADAPTER_VERSION,
    configurationFingerprint: hashRecordValue(
      "gno-jsonl-config-v1",
      canonicalJson(mapping)
    ),
    canHandle: (mime, ext) =>
      mime === "application/x-ndjson" ||
      mime === "application/jsonl" ||
      ext === ".jsonl" ||
      ext === ".ndjson",
    records: async function* (
      input: RecordAdapterInput
    ): AsyncGenerator<RecordAdapterEvent> {
      const container = sourceNamespace(input);
      let hadFailure = false;
      try {
        const lines = readBoundedUtf8Lines(
          input.open(),
          adapterLineByteLimit(input)
        );
        for await (const line of lines) {
          if (!line.ok) {
            hadFailure = true;
            yield failure(
              line.reason === "line_too_large"
                ? "RECORD_TOO_LARGE"
                : "MALFORMED_RECORD",
              line.lineNumber,
              !line.terminated
            );
            continue;
          }
          if (line.text.trim() === "") continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line.text);
          } catch {
            hadFailure = true;
            yield failure(
              "MALFORMED_RECORD",
              line.lineNumber,
              !line.terminated
            );
            continue;
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            hadFailure = true;
            yield failure("MALFORMED_RECORD", line.lineNumber);
            continue;
          }
          const event = recordFromLine(
            parsed as Record<string, unknown>,
            line.lineNumber,
            container,
            mapping,
            authorMapping,
            allowConventionalId
          );
          hadFailure ||= event.type === "failure";
          yield event;
        }
      } catch {
        hadFailure = true;
        yield {
          type: "failure",
          failure: {
            code: "ADAPTER_FAILURE",
            message: "JSONL source could not be read completely.",
            retryable: true,
          },
        };
      }
      yield {
        type: "snapshot",
        state: hadFailure ? "partial" : "complete",
      };
    },
  };
};

export const jsonlAdapter = createJsonlAdapter();
