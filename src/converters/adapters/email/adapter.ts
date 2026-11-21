import type {
  RecordAdapter,
  RecordAdapterEvent,
  RecordAdapterInput,
  RecordAdapterRecord,
} from "../../types";

import { RECORD_METADATA_LIMITS } from "../../types";
import {
  MailParseError,
  type ParsedAttachment,
  type ParsedEmail,
  parseEmail,
} from "./mime";

const ADAPTER_ID = "native/email-export";
const ADAPTER_VERSION = "1.0.0";
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const CONTROL_CHAR_PATTERN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  "g"
);

interface RawMessage {
  raw?: string;
  index: number;
  oversized: boolean;
}

interface BinaryLine {
  rawLength: number;
  value?: string;
  oversized: boolean;
}

const hashText = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

const bytesToBinary = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "latin1"
  );

const rawMessageLimit = (input: RecordAdapterInput): number => {
  const attachmentLimit = Math.max(
    1_024,
    Math.min(MAX_ATTACHMENT_BYTES, input.limits.maxRecordChars * 2)
  );
  const desired = Math.max(
    input.limits.maxRecordChars * 4,
    input.limits.maxMetadataChars * 4,
    attachmentLimit * 2
  );
  return Math.max(4_096, Math.min(input.limits.maxSourceBytes, desired));
};

async function* binaryLines(
  input: RecordAdapterInput,
  maxLineChars: number
): AsyncGenerator<BinaryLine> {
  let pendingParts: string[] = [];
  let pendingChars = 0;
  let rawLength = 0;
  let oversized = false;
  for await (const chunk of input.open()) {
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl === -1) break;
      const segmentLen = nl - start;
      rawLength += segmentLen + 1;
      if (!oversized) {
        if (pendingChars + segmentLen > maxLineChars) {
          oversized = true;
          pendingParts = [];
          pendingChars = 0;
        } else if (segmentLen > 0) {
          pendingParts.push(bytesToBinary(chunk.subarray(start, nl)));
          pendingChars += segmentLen;
        }
      }
      if (oversized) {
        yield { rawLength, oversized: true };
      } else {
        const joined =
          pendingParts.length === 0
            ? ""
            : pendingParts.length === 1
              ? pendingParts[0]!
              : pendingParts.join("");
        yield {
          rawLength,
          value: joined.endsWith("\r") ? joined.slice(0, -1) : joined,
          oversized: false,
        };
      }
      pendingParts = [];
      pendingChars = 0;
      rawLength = 0;
      oversized = false;
      start = nl + 1;
    }
    if (start < chunk.length) {
      const segmentLen = chunk.length - start;
      rawLength += segmentLen;
      if (!oversized) {
        if (pendingChars + segmentLen > maxLineChars) {
          oversized = true;
          pendingParts = [];
          pendingChars = 0;
        } else {
          pendingParts.push(bytesToBinary(chunk.subarray(start)));
          pendingChars += segmentLen;
        }
      }
    }
  }
  if (rawLength > 0 || oversized) {
    yield oversized
      ? { rawLength, oversized: true }
      : {
          rawLength,
          value: pendingParts.join("").replace(/\r$/, ""),
          oversized: false,
        };
  }
}

const readEml = async (
  input: RecordAdapterInput,
  maxChars: number
): Promise<RawMessage> => {
  const pieces: string[] = [];
  let chars = 0;
  for await (const chunk of input.open()) {
    chars += chunk.length;
    if (chars > maxChars) return { index: 1, oversized: true };
    pieces.push(bytesToBinary(chunk));
  }
  return { raw: pieces.join(""), index: 1, oversized: false };
};

async function* readMbox(
  input: RecordAdapterInput,
  maxChars: number
): AsyncGenerator<RawMessage> {
  let messageParts: string[] = [];
  let messageChars = 0;
  let messageIndex = 0;
  let malformed = false;
  let oversized = false;
  let sawEnvelope = false;
  let contentLength: number | undefined;
  let bodyBytesRemaining: number | undefined;
  let inHeaders = false;

  const finishMessage = (): RawMessage | undefined => {
    if (messageParts.length === 0 && !(malformed || oversized))
      return undefined;
    messageIndex += 1;
    const incompleteBody =
      bodyBytesRemaining !== undefined && bodyBytesRemaining > 0;
    const result: RawMessage = {
      raw:
        oversized || malformed || incompleteBody
          ? undefined
          : messageParts.join("\n"),
      index: messageIndex,
      oversized,
    };
    messageParts = [];
    messageChars = 0;
    malformed = false;
    oversized = false;
    contentLength = undefined;
    bodyBytesRemaining = undefined;
    inHeaders = false;
    return result;
  };

  for await (const line of binaryLines(input, maxChars)) {
    if (bodyBytesRemaining !== undefined && bodyBytesRemaining > 0) {
      if (line.rawLength > bodyBytesRemaining) {
        malformed = true;
        bodyBytesRemaining = 0;
        messageParts = [];
        continue;
      }
      bodyBytesRemaining -= line.rawLength;
    } else {
      const isEnvelope = !line.oversized && isMboxEnvelope(line.value ?? "");
      if (isEnvelope) {
        const finished = finishMessage();
        if (finished) yield finished;
        sawEnvelope = true;
        inHeaders = true;
        continue;
      }
    }
    if (!sawEnvelope && messageParts.length === 0 && line.value === "") {
      continue;
    }
    if (line.oversized) {
      oversized = true;
      messageParts = [];
      continue;
    }
    const rawLineValue = line.value ?? "";
    const lineValue = inHeaders
      ? rawLineValue
      : rawLineValue.replace(/^>(?=>*From )/, "");
    if (inHeaders) {
      if (lineValue === "") {
        inHeaders = false;
        bodyBytesRemaining = contentLength;
      } else if (/^content-length\s*:/i.test(lineValue)) {
        const rawLength = lineValue.slice(lineValue.indexOf(":") + 1).trim();
        if (!/^\d+$/.test(rawLength)) {
          malformed = true;
        } else {
          contentLength = Number.parseInt(rawLength, 10);
          if (!Number.isSafeInteger(contentLength)) {
            malformed = true;
          } else if (contentLength > maxChars) {
            oversized = true;
          }
        }
      }
    }
    if (oversized) continue;
    messageChars += lineValue.length + 1;
    if (messageChars > maxChars) {
      oversized = true;
      messageParts = [];
    } else {
      messageParts.push(lineValue);
    }
  }
  const finished = finishMessage();
  if (finished) yield finished;
}

const isMboxEnvelope = (line: string): boolean =>
  /^From \S+ (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\d{1,2} \d{2}:\d{2}(?::\d{2})?(?: [A-Za-z]{1,5}| [+-]\d{4})? \d{4}\s*$/.test(
    line
  );

const markdownInline = (value: string): string =>
  value
    .replace(CONTROL_CHAR_PATTERN, " ")
    .replace(/([\\`*_[\]<>#])/g, "\\$1")
    .replace(/\s+/g, " ")
    .trim();

const BODY_MARKDOWN_ESCAPE_REGEX = /([\\`*_[\]<>])/g;

const safeBodyMarkdown = (value: string): string => {
  const withoutCr = value.includes("\r") ? value.replaceAll("\r", "") : value;
  return withoutCr.replace(BODY_MARKDOWN_ESCAPE_REGEX, "\\$1");
};

const renderAttachments = (attachments: ParsedAttachment[]): string => {
  if (attachments.length === 0) return "";
  const lines = attachments.map(
    (attachment) =>
      `- ${markdownInline(attachment.name)} — ${markdownInline(
        attachment.mime ?? "application/octet-stream"
      )} — ${attachment.bytes ?? 0} bytes — sha256:${attachment.sha256}`
  );
  return `\n\n## Attachments\n\n${lines.join("\n")}`;
};

const renderEmail = (parsed: ParsedEmail, missingId: boolean): string => {
  const title = markdownInline(parsed.subject ?? "(no subject)");
  const fields = [
    parsed.author ? `From: ${markdownInline(parsed.author)}` : undefined,
    parsed.participants.length > 1
      ? `Participants: ${parsed.participants.map(markdownInline).join("; ")}`
      : undefined,
    parsed.sentAt ? `Date: ${parsed.sentAt}` : undefined,
    parsed.messageId
      ? `Message-ID: ${markdownInline(parsed.messageId)}`
      : "Message-ID: missing",
    parsed.inReplyTo
      ? `In-Reply-To: ${markdownInline(parsed.inReplyTo)}`
      : undefined,
    parsed.references.length > 0
      ? `References: ${parsed.references.map(markdownInline).join("; ")}`
      : undefined,
    missingId ? "Identity: content-derived" : undefined,
  ].filter((value): value is string => Boolean(value));
  const body = parsed.body
    ? safeBodyMarkdown(parsed.body)
    : "(No safe text body.)";
  return `# ${title}\n\n${fields.join("\n")}\n\n${body}${renderAttachments(
    parsed.attachments
  )}`;
};

const recordFor = (
  parsed: ParsedEmail,
  raw: string,
  index: number
): RecordAdapterRecord => {
  const canonicalRaw = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const sourceHash = hashText(`gno-email-source-v1\0${canonicalRaw}`);
  const identity = parsed.messageId
    ? `message:${hashText(parsed.messageId)}:variant:${sourceHash}`
    : `missing:${sourceHash}`;
  return {
    stableId: identity,
    sourceLocator: `message:${index}`,
    sourceHash,
    markdown: renderEmail(parsed, !parsed.messageId),
    title: parsed.subject,
    metadata: parsed.metadata,
    anchors: [
      {
        kind: "message",
        value:
          parsed.messageId?.slice(0, RECORD_METADATA_LIMITS.maxAnchorChars) ??
          `message:${index}`,
      },
    ],
  };
};

const parseLimits = (input: RecordAdapterInput) => ({
  maxBodyChars: input.limits.maxRecordChars,
  maxMetadataChars: input.limits.maxMetadataChars,
  maxAttachmentBytes: Math.max(
    1_024,
    Math.min(MAX_ATTACHMENT_BYTES, input.limits.maxRecordChars * 2)
  ),
});

const failure = (
  index: number,
  code: "MALFORMED_RECORD" | "RECORD_TOO_LARGE"
): RecordAdapterEvent => ({
  type: "failure",
  failure: {
    code,
    message:
      code === "RECORD_TOO_LARGE"
        ? "Mail message exceeded its bounded parse limit."
        : "Mail message could not be parsed safely.",
    retryable: false,
    sourceLocator: `message:${index}`,
  },
});

export const emailRecordAdapter: RecordAdapter = {
  id: ADAPTER_ID,
  version: ADAPTER_VERSION,

  canHandle(mime, ext) {
    const normalizedMime = mime.toLowerCase();
    const normalizedExt = ext.toLowerCase();
    return (
      normalizedExt === ".eml" ||
      normalizedExt === ".mbox" ||
      normalizedMime === "message/rfc822" ||
      normalizedMime === "application/mbox"
    );
  },

  async *records(input) {
    const isMbox =
      input.ext.toLowerCase() === ".mbox" ||
      input.mime.toLowerCase() === "application/mbox";
    const messages: AsyncIterable<RawMessage> = isMbox
      ? readMbox(input, rawMessageLimit(input))
      : {
          async *[Symbol.asyncIterator]() {
            yield await readEml(input, rawMessageLimit(input));
          },
        };
    let partial = false;
    let messageCount = 0;
    for await (const message of messages) {
      messageCount += 1;
      if (message.oversized || message.raw === undefined) {
        partial = true;
        yield failure(
          message.index,
          message.oversized ? "RECORD_TOO_LARGE" : "MALFORMED_RECORD"
        );
        continue;
      }
      try {
        const parsed = parseEmail(message.raw, parseLimits(input));
        yield {
          type: "record",
          record: recordFor(parsed, message.raw, message.index),
        };
      } catch (error) {
        partial = true;
        yield failure(
          message.index,
          error instanceof MailParseError && error.kind === "limit"
            ? "RECORD_TOO_LARGE"
            : "MALFORMED_RECORD"
        );
      }
    }
    if (messageCount === 0) {
      partial = true;
      yield failure(1, "MALFORMED_RECORD");
    }
    yield { type: "snapshot", state: partial ? "partial" : "complete" };
  },
};
