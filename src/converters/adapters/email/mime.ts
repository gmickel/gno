import type {
  RecordAttachmentInventoryItem,
  RecordMetadata,
} from "../../types";

import { RECORD_METADATA_LIMITS } from "../../types";
import { sanitizeHtmlToText } from "./html";
import { parseParameterizedHeader } from "./parameters";

const MAX_MIME_DEPTH = 12;
const MAX_MIME_PARTS = 256;
const MAX_HEADER_CHARS = 256 * 1024;
const MAX_HEADER_LINES = 2_048;
const CONTROL_CHAR_PATTERN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  "g"
);
const MESSAGE_ID_PATTERN = /<([^<>\s]+)>/g;

export type MailParseErrorKind = "limit" | "malformed";

export class MailParseError extends Error {
  constructor(
    message: string,
    readonly kind: MailParseErrorKind = "malformed"
  ) {
    super(message);
    this.name = "MailParseError";
  }
}

export interface ParsedAttachment extends RecordAttachmentInventoryItem {
  sha256: string;
}

export interface ParsedEmail {
  subject?: string;
  author?: string;
  participants: string[];
  sentAt?: string;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  body: string;
  attachments: ParsedAttachment[];
  metadata: RecordMetadata;
}

export interface ParseEmailLimits {
  maxBodyChars: number;
  maxMetadataChars: number;
  maxAttachmentBytes: number;
}

interface MimeState {
  plainBodies: string[];
  htmlBodies: string[];
  attachments: ParsedAttachment[];
  partCount: number;
  limits: ParseEmailLimits;
}

const CHARSET_LABELS: Record<string, string> = {
  ascii: "windows-1252",
  "iso-8859-1": "windows-1252",
  latin1: "windows-1252",
  "us-ascii": "windows-1252",
  utf8: "utf-8",
};
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: false });
const DECODER_CACHE = new Map<string, TextDecoder>([["utf-8", UTF8_DECODER]]);

const binaryToBytes = (value: string): Uint8Array =>
  Buffer.from(value, "latin1");

const decodeBytes = (bytes: Uint8Array, charset = "utf-8"): string => {
  const normalized = charset.trim().toLowerCase().replaceAll("_", "-");
  const label = CHARSET_LABELS[normalized] ?? normalized;
  let decoder = DECODER_CACHE.get(label);
  if (!decoder) {
    try {
      decoder = new TextDecoder(label, { fatal: false });
    } catch {
      return UTF8_DECODER.decode(bytes);
    }
    if (DECODER_CACHE.size < 64) {
      DECODER_CACHE.set(label, decoder);
    }
  }
  return decoder.decode(bytes);
};

const hexNibble = (code: number): number => {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
};

const decodeQuotedPrintable = (value: string): Uint8Array => {
  const unfolded = value.includes("=") ? value.replace(/=\r?\n/g, "") : value;
  const out = new Uint8Array(unfolded.length);
  let outLen = 0;
  for (let index = 0; index < unfolded.length; index += 1) {
    const code = unfolded.charCodeAt(index);
    if (code === 61 && index + 2 < unfolded.length) {
      const hi = hexNibble(unfolded.charCodeAt(index + 1));
      const lo = hexNibble(unfolded.charCodeAt(index + 2));
      if (hi >= 0 && lo >= 0) {
        out[outLen] = (hi << 4) | lo;
        outLen += 1;
        index += 2;
        continue;
      }
    }
    out[outLen] = code & 0xff;
    outLen += 1;
  }
  return out.subarray(0, outLen);
};

const decodeCompactBase64 = (compact: string): Uint8Array => {
  if (
    compact.length === 0 ||
    compact.length % 4 === 1 ||
    !/^[a-z\d+/]*={0,2}$/i.test(compact)
  ) {
    throw new MailParseError("Malformed base64 MIME body.");
  }
  try {
    return Uint8Array.fromBase64(compact);
  } catch {
    throw new MailParseError("Malformed base64 MIME body.");
  }
};

const decodeBase64 = (value: string): Uint8Array =>
  decodeCompactBase64(value.replace(/\s/g, ""));

const decodeTransfer = (
  value: string,
  encoding: string | undefined,
  maxBytes: number
): Uint8Array => {
  const normalized = encoding?.trim().toLowerCase();
  let bytes: Uint8Array;
  if (normalized === "base64") {
    const compact = value.replace(/\s/g, "");
    if (compact.length > maxBytes * 2) {
      throw new MailParseError(
        "MIME body exceeds its decoded byte limit.",
        "limit"
      );
    }
    bytes = decodeCompactBase64(compact);
  } else if (normalized === "quoted-printable") {
    if (value.length > maxBytes * 3) {
      throw new MailParseError(
        "MIME body exceeds its decoded byte limit.",
        "limit"
      );
    }
    bytes = decodeQuotedPrintable(value);
  } else {
    bytes = binaryToBytes(value);
  }
  if (bytes.byteLength > maxBytes) {
    throw new MailParseError(
      "MIME body exceeds its decoded byte limit.",
      "limit"
    );
  }
  return bytes;
};

const decodeHeaderWords = (value: string): string => {
  const decoded = decodeBytes(binaryToBytes(value)).replace(
    /(\?=)\s+(=\?)/g,
    "$1$2"
  );
  return decoded
    .replace(
      /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
      (_match, charset: string, encoding: string, payload: string) => {
        try {
          const bytes =
            encoding.toLowerCase() === "b"
              ? decodeBase64(payload)
              : decodeQuotedPrintable(payload.replaceAll("_", " "));
          return decodeBytes(bytes, charset);
        } catch {
          return "";
        }
      }
    )
    .replace(/\s+/g, " ")
    .trim();
};

const splitHeaderBody = (raw: string): [string, string] => {
  const match = /\r?\n\r?\n/.exec(raw);
  if (!match || match.index === undefined) {
    return [raw, ""];
  }
  return [raw.slice(0, match.index), raw.slice(match.index + match[0].length)];
};

const parseHeaders = (raw: string): Map<string, string> => {
  if (raw.length > MAX_HEADER_CHARS) {
    throw new MailParseError(
      "Mail headers exceed their character limit.",
      "limit"
    );
  }
  const unfolded = raw.replace(/\r?\n[ \t]+/g, " ");
  const lines = unfolded.split(/\r?\n/);
  if (lines.length > MAX_HEADER_LINES) {
    throw new MailParseError("Mail headers exceed their line limit.", "limit");
  }
  const headers = new Map<string, string>();
  for (const line of lines) {
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!/^[a-z\d-]+$/.test(name)) continue;
    const previous = headers.get(name);
    headers.set(name, previous ? `${previous}, ${value}` : value);
  }
  return headers;
};

const splitMultipart = (body: string, boundary: string): string[] => {
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) {
    throw new MailParseError("Invalid MIME multipart boundary.");
  }
  const marker = `--${boundary}`;
  const closing = `${marker}--`;
  const parts: string[] = [];
  let current: string[] | undefined;
  for (const line of body.split("\n")) {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    const boundaryLine = normalized.replace(/[ \t]+$/, "");
    if (boundaryLine === marker || boundaryLine === closing) {
      if (current) parts.push(current.join("\n"));
      current = boundaryLine === closing ? undefined : [];
      if (boundaryLine === closing) break;
    } else if (current) {
      current.push(line);
    }
  }
  if (parts.length === 0) {
    throw new MailParseError("MIME multipart body has no bounded parts.");
  }
  return parts;
};

const hashBytes = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const safeFilename = (value: string | undefined, index: number): string => {
  const normalized = value
    ?.normalize("NFC")
    .replace(CONTROL_CHAR_PATTERN, "")
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    ?.trim();
  return (normalized || `attachment-${index}`).slice(0, 240);
};

const walkMimePart = (
  raw: string,
  state: MimeState,
  depth: number,
  preParsed?: { headers: Map<string, string>; body: string }
): void => {
  if (depth > MAX_MIME_DEPTH) {
    throw new MailParseError("MIME nesting exceeds its depth limit.", "limit");
  }
  state.partCount += 1;
  if (state.partCount > MAX_MIME_PARTS) {
    throw new MailParseError("MIME message exceeds its part limit.", "limit");
  }
  let headers: Map<string, string>;
  let body: string;
  if (preParsed) {
    headers = preParsed.headers;
    body = preParsed.body;
  } else {
    const [rawHeaders, splitBody] = splitHeaderBody(raw);
    headers = parseHeaders(rawHeaders);
    body = splitBody;
  }
  const contentType = parseParameterizedHeader(
    headers.get("content-type"),
    decodeHeaderWords
  );
  const disposition = parseParameterizedHeader(
    headers.get("content-disposition"),
    decodeHeaderWords
  );
  const mime = contentType.value || "text/plain";
  if (mime.startsWith("multipart/")) {
    const boundary = contentType.params.boundary;
    if (!boundary) {
      throw new MailParseError("MIME multipart boundary is missing.");
    }
    for (const part of splitMultipart(body, boundary)) {
      walkMimePart(part, state, depth + 1);
    }
    return;
  }

  const filename =
    disposition.params.filename ?? contentType.params.name ?? undefined;
  const isAttachment =
    disposition.value === "attachment" ||
    Boolean(filename) ||
    (!mime.startsWith("text/") && mime !== "message/rfc822");
  const bytes = decodeTransfer(
    body,
    headers.get("content-transfer-encoding"),
    isAttachment
      ? state.limits.maxAttachmentBytes
      : state.limits.maxBodyChars * 4
  );
  if (isAttachment || mime === "message/rfc822") {
    state.attachments.push({
      name: safeFilename(filename, state.attachments.length + 1),
      mime,
      bytes: bytes.byteLength,
      disposition: disposition.value === "inline" ? "inline" : "attachment",
      sha256: hashBytes(bytes),
    });
    return;
  }
  const charset = contentType.params.charset ?? "utf-8";
  const decoded = decodeBytes(bytes, charset);
  if (mime === "text/html") {
    state.htmlBodies.push(sanitizeHtmlToText(decoded));
  } else if (mime === "text/plain") {
    state.plainBodies.push(decoded.trim());
  }
};

const normalizeMessageId = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const match = /<([^<>\s]+)>/.exec(value);
  const normalized = (match?.[1] ?? value)
    .normalize("NFC")
    .replace(CONTROL_CHAR_PATTERN, "")
    .trim();
  return normalized
    ? normalized.slice(0, RECORD_METADATA_LIMITS.maxIdentifierChars)
    : undefined;
};

const extractMessageIds = (value: string | undefined): string[] => {
  if (!value) return [];
  const ids: string[] = [];
  for (const match of value.matchAll(MESSAGE_ID_PATTERN)) {
    if (match[1]) {
      ids.push(
        match[1]
          .normalize("NFC")
          .slice(0, RECORD_METADATA_LIMITS.maxIdentifierChars)
      );
    }
  }
  return ids;
};

const normalizeDate = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  const namedZones: Record<string, string> = {
    CDT: "-0500",
    CST: "-0600",
    EDT: "-0400",
    EST: "-0500",
    GMT: "+0000",
    MDT: "-0600",
    MST: "-0700",
    PDT: "-0700",
    PST: "-0800",
    UT: "+0000",
    UTC: "+0000",
  };
  const namedMatch = /\b([A-Z]{2,3})\s*$/.exec(trimmed);
  const numericZone = /[+-]\d{4}\s*$/.test(trimmed);
  const replacement = namedMatch ? namedZones[namedMatch[1] ?? ""] : undefined;
  if (!(numericZone || replacement)) return undefined;
  const normalized = replacement
    ? trimmed.slice(0, namedMatch?.index).trimEnd() + ` ${replacement}`
    : trimmed;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
};

const normalizedHeader = (
  headers: Map<string, string>,
  name: string
): string | undefined => {
  const value = headers.get(name);
  if (!value) return undefined;
  const decoded = decodeHeaderWords(value)
    .replace(CONTROL_CHAR_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
  return decoded ? decoded.slice(0, 8_192) : undefined;
};

export const parseEmail = (
  raw: string,
  limits: ParseEmailLimits
): ParsedEmail => {
  const [rawHeaders, bodyRaw] = splitHeaderBody(raw);
  const headers = parseHeaders(rawHeaders);
  const state: MimeState = {
    plainBodies: [],
    htmlBodies: [],
    attachments: [],
    partCount: 0,
    limits,
  };
  walkMimePart(raw, state, 0, { headers, body: bodyRaw });
  const bodyParts = state.plainBodies.some(Boolean)
    ? state.plainBodies
    : state.htmlBodies;
  const body = bodyParts.filter(Boolean).join("\n\n").trim();
  if (
    headers.size === 0 &&
    body.length === 0 &&
    state.attachments.length === 0
  ) {
    throw new MailParseError("Mail message has no parseable content.");
  }
  if (body.length > limits.maxBodyChars) {
    throw new MailParseError(
      "Decoded mail body exceeds its character limit.",
      "limit"
    );
  }

  const author = normalizedHeader(headers, "from");
  const participantHeaders = ["from", "to", "cc", "bcc"]
    .map((name) => normalizedHeader(headers, name))
    .filter((value): value is string => Boolean(value));
  const participants = [...new Set(participantHeaders)];
  const messageId = normalizeMessageId(headers.get("message-id"));
  const inReplyTo = normalizeMessageId(headers.get("in-reply-to"));
  const references = extractMessageIds(headers.get("references"));
  const sentAt = normalizeDate(headers.get("date"));
  const threadId = references[0] ?? inReplyTo ?? messageId;
  const metadata: RecordMetadata = {
    author,
    participants,
    categories: ["email"],
    dateFields: sentAt ? { sentAt } : undefined,
    messageId,
    inReplyTo,
    references,
    threadId,
    attachments: state.attachments,
  };
  if (JSON.stringify(metadata).length > limits.maxMetadataChars) {
    throw new MailParseError(
      "Mail metadata exceeds its character limit.",
      "limit"
    );
  }
  return {
    subject: normalizedHeader(headers, "subject"),
    author,
    participants,
    sentAt,
    messageId,
    inReplyTo,
    references,
    body,
    attachments: state.attachments,
    metadata,
  };
};
