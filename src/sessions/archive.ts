/**
 * Durable session archive: one sanitized JSONL file per thread.
 *
 * Archive files are ordinary JSONL records read back through the existing
 * JSONL record adapter with {@link SESSION_ARCHIVE_FIELD_MAPPING}, so the
 * archive needs no dedicated ingestion or ranking path. Each line is one
 * dialogue turn; the body carries the sanitized text plus a bounded
 * provenance block so `get` shows who spoke, when, and where it came from.
 *
 * @module src/sessions/archive
 */

// node:path: no Bun path utilities.
import { basename, join } from "node:path";

import type { JsonlFieldMapping } from "../converters/adapters/jsonl/config";
import type { RedactionPolicy } from "./sanitize";

import { hashRecordValue } from "../converters/adapters/shared/record-utils";
import { SESSION_REDACTION_VERSION, ThreadSanitizer } from "./sanitize";
import {
  type ParsedThread,
  SESSION_ARCHIVE_FORMAT_VERSION,
  SESSION_HARNESS_LABELS,
  SESSION_LIMITS,
  type SessionHarness,
} from "./types";

/** Record mapping registered on every archive collection. */
export const SESSION_ARCHIVE_FIELD_MAPPING: JsonlFieldMapping = {
  id: "/id",
  body: "/body",
  title: "/title",
  author: "/author",
  categories: "/categories",
  sessionId: "/sessionId",
  threadId: "/threadId",
  dateFields: { recorded: "/recordedAt" },
};

/** Directory inside the archive root that holds import state. */
export const SESSION_STATE_DIRNAME = ".gno-sessions";

const PROVENANCE_FIELD_CHARS = 256;

export interface ArchiveLine {
  id: string;
  title: string;
  body: string;
  author: "human" | "assistant";
  categories: string[];
  sessionId?: string;
  threadId: string;
  recordedAt?: string;
  provenance: {
    sourceId: string;
    harness: SessionHarness;
    unit: string;
    locator: string;
    turnId: string;
    threadKind: string;
    parentThreadId?: string;
    parser: string;
    redaction: number;
    format: number;
  };
}

export interface RenderedThread {
  /** Archive file path relative to the collection root. */
  relPath: string;
  content: string;
  lines: number;
  humanTurns: number;
  assistantTurns: number;
  redactions: number;
  overLimit: boolean;
}

const bound = (value: string): string =>
  value.length > PROVENANCE_FIELD_CHARS
    ? `${value.slice(0, PROVENANCE_FIELD_CHARS - 1)}…`
    : value;

/** Lowercase tag segment accepted by GNO's tag grammar. */
function tagSegment(value: string): string {
  const slug = value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{Ll}\p{Lo}\p{N}.-]+/gu, "-")
    .replace(/^[^\p{Ll}\p{Lo}\p{N}]+/u, "")
    .replace(/-+$/u, "")
    .slice(0, 64);
  return slug || "unknown";
}

/** Opaque identity of a working directory; the raw path is never stored. */
function projectIdentity(cwd: string | undefined): {
  label: string;
  id: string;
} | null {
  if (!cwd) return null;
  const normalized = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
  return {
    label: basename(normalized) || "root",
    id: hashRecordValue("gno-session-project-v1", normalized).slice(0, 12),
  };
}

/**
 * Stable, path-free archive file for one thread of one unit. The unit key
 * namespaces the file, so two units that report the same thread ID never
 * overwrite each other.
 */
export function threadRelPath(
  sourceId: string,
  harness: SessionHarness,
  unitKey: string,
  threadId: string
): string {
  const fileKey = hashRecordValue(
    "gno-session-thread-v2",
    `${harness}\0${sourceId}\0${unitKey}\0${threadId}`
  ).slice(0, 32);
  return `${harness}/${sourceId}/${fileKey}.jsonl`;
}

export function archiveFilePath(
  archiveRoot: string,
  collection: string,
  relPath: string
): string {
  return join(archiveRoot, collection, relPath);
}

const roleLabel = (role: "human" | "assistant"): string =>
  role === "human" ? "Human" : "Assistant";

/**
 * Render a parsed thread into sanitized archive lines. Sanitization runs
 * over every persisted field (text, titles, labels, locators) before
 * anything is written, with a second pass propagating detected values
 * across the whole thread.
 */
export function renderThread(options: {
  thread: ParsedThread;
  sourceId: string;
  unitKey: string;
  unitLocator: string;
  parser: string;
  redaction: RedactionPolicy;
}): RenderedThread {
  const { thread, sourceId, parser } = options;
  const sanitizer = new ThreadSanitizer(options.redaction);
  const project = projectIdentity(thread.cwd);
  // Pass 1 detects secrets in every persisted field; pass 2 (`clean`)
  // propagates values found anywhere in the thread into every field, so a
  // secret revealed in a later turn is also removed from titles, tags and IDs.
  const raw = {
    project: project ? sanitizer.sanitize(project.label) : null,
    sessionId: sanitizer.sanitize(thread.sessionId),
    threadId: sanitizer.sanitize(thread.threadId),
    parentThreadId: thread.parentThreadId
      ? sanitizer.sanitize(thread.parentThreadId)
      : null,
    unit: sanitizer.sanitize(options.unitLocator),
  };
  const rawDrafts = thread.turns.map((turn) => ({
    turn,
    text: sanitizer.sanitize(turn.text),
    turnId: sanitizer.sanitize(turn.turnId),
    locator: sanitizer.sanitize(turn.locator),
  }));
  const clean = (value: string): string => sanitizer.propagate(value);
  const projectLabel = raw.project === null ? null : clean(raw.project);
  const harnessLabel = SESSION_HARNESS_LABELS[thread.harness];
  const sessionId = `${thread.harness}/${sourceId}/${clean(raw.sessionId)}`;
  const threadId = `${thread.harness}/${sourceId}/${clean(raw.threadId)}`;
  const parentThreadId =
    raw.parentThreadId === null
      ? null
      : `${thread.harness}/${sourceId}/${clean(raw.parentThreadId)}`;
  const unit = clean(raw.unit);

  const categories = [
    "session",
    `harness/${tagSegment(thread.harness)}`,
    `session-kind/${thread.kind}`,
  ];
  if (projectLabel && project) {
    categories.push(`project/${tagSegment(projectLabel)}`);
    categories.push(`project-id/${project.id}`);
  }

  const drafts = rawDrafts.map((draft) => ({
    turn: draft.turn,
    text: clean(draft.text),
    turnId: clean(draft.turnId),
    locator: clean(draft.locator),
  }));

  const lines: string[] = [];
  let bytes = 0;
  let human = 0;
  let assistant = 0;
  let overLimit = false;
  for (const draft of drafts) {
    const { turn } = draft;
    const { text } = draft;
    const speaker = roleLabel(turn.role);
    const titleParts = [speaker, harnessLabel, projectLabel ?? "no project"];
    // One bounded line keeps each record small in bounded context delivery.
    const provenance = [
      turn.role === "assistant"
        ? "Assistant (assistant output, not a user decision)"
        : "Human",
      // A known time travels as record metadata (dateFields.recorded).
      ...(turn.timestamp ? [] : ["recorded unknown"]),
      `source ${bound(sourceId)}`,
      `locator ${bound(`${unit}#${draft.locator}`)}`,
      `turn ${bound(draft.turnId)}`,
    ].join(" · ");
    const line: ArchiveLine = {
      id: hashRecordValue(
        "gno-session-turn-v1",
        `${threadId}\0${draft.turnId}`
      ).slice(0, 32),
      title: titleParts.join(" · "),
      body: `${speaker}: ${text}\n\nProvenance: ${provenance}`,
      author: turn.role,
      categories: [...categories, `role/${turn.role}`],
      // A main thread is its own session; the duplicate ID is omitted.
      ...(sessionId === threadId ? {} : { sessionId }),
      threadId,
      ...(turn.timestamp ? { recordedAt: turn.timestamp } : {}),
      provenance: {
        sourceId,
        harness: thread.harness,
        unit,
        locator: draft.locator,
        turnId: draft.turnId,
        threadKind: thread.kind,
        ...(parentThreadId ? { parentThreadId } : {}),
        parser,
        redaction: SESSION_REDACTION_VERSION,
        format: SESSION_ARCHIVE_FORMAT_VERSION,
      },
    };
    const serialized = JSON.stringify(line);
    bytes += serialized.length + 1;
    if (bytes > SESSION_LIMITS.maxArchiveBytesPerThread) {
      overLimit = true;
      break;
    }
    lines.push(serialized);
    if (turn.role === "human") human += 1;
    else assistant += 1;
  }

  return {
    relPath: threadRelPath(
      sourceId,
      thread.harness,
      options.unitKey,
      thread.threadId
    ),
    content: lines.length > 0 ? `${lines.join("\n")}\n` : "",
    lines: lines.length,
    humanTurns: human,
    assistantTurns: assistant,
    redactions: sanitizer.redactions,
    overLimit,
  };
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Apply `fn` to every string leaf of a parsed archive line. */
function mapStrings(value: JsonValue, fn: (text: string) => string): JsonValue {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, fn)])
    );
  }
  return value;
}

/**
 * Re-sanitize an existing archive file with the current redaction rules
 * (used when the original source is no longer available). Every persisted
 * string field is rescanned, not only the text. Returns null when the file
 * does not parse as an archive; the caller must then withhold it.
 */
export function rescanArchiveContent(
  content: string,
  redaction: RedactionPolicy
): { content: string; redactions: number } | null {
  const sanitizer = new ThreadSanitizer(redaction);
  const parsed: JsonValue[] = [];
  for (const raw of content.split("\n")) {
    if (!raw.trim()) continue;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      return null;
    }
    const record = line as Partial<ArchiveLine> | null;
    if (
      !record ||
      typeof record !== "object" ||
      typeof record.body !== "string" ||
      !record.provenance ||
      typeof record.provenance !== "object"
    ) {
      return null;
    }
    parsed.push(
      mapStrings(line as JsonValue, (text) => sanitizer.sanitize(text))
    );
  }
  const output = parsed.map((line) => {
    const propagated = mapStrings(line, (text) =>
      sanitizer.propagate(text)
    ) as {
      provenance: Record<string, JsonValue>;
    };
    return JSON.stringify({
      ...propagated,
      provenance: {
        ...propagated.provenance,
        redaction: SESSION_REDACTION_VERSION,
      },
    });
  });
  return {
    content: output.length > 0 ? `${output.join("\n")}\n` : "",
    redactions: sanitizer.redactions,
  };
}
