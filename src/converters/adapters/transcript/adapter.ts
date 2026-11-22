import type {
  RecordAdapter,
  RecordAdapterEvent,
  RecordAdapterInput,
  RecordAdapterRecord,
} from "../../types";
import type {
  TranscriptAdapterOptions,
  TranscriptFormat,
  TranscriptParseEvent,
  TranscriptSegment,
} from "./model";

import {
  adapterLineByteLimit,
  canonicalJson,
  hashRecordValue,
  safeInlineText,
  sourceNamespace,
} from "../shared/record-utils";
import {
  readBoundedUtf8Lines,
  type Utf8LineResult,
} from "../shared/utf8-lines";
import { parseJsonTranscript } from "./json";
import { parseTranscriptAdapterOptions } from "./model";
import { parseTextTranscript } from "./text";
import { parseTimedTranscript } from "./timed";

const ADAPTER_ID = "adapter/transcript";
const ADAPTER_VERSION = "1.0.0";
const MAX_JSON_TRANSCRIPT_CHARS = 16 * 1024 * 1024;

const resolvedFormat = (
  input: Pick<RecordAdapterInput, "ext" | "mime">,
  requested: TranscriptFormat
): Exclude<TranscriptFormat, "auto"> | undefined => {
  if (requested !== "auto") return requested;
  if (input.mime === "text/vtt" || input.ext === ".vtt") return "vtt";
  if (
    input.mime === "application/x-subrip" ||
    input.mime === "text/srt" ||
    input.ext === ".srt"
  ) {
    return "srt";
  }
  return undefined;
};

const failureEvent = (
  event: Extract<TranscriptParseEvent, { ok: false }>
): RecordAdapterEvent => ({
  type: "failure",
  failure: {
    code: event.tooLarge ? "RECORD_TOO_LARGE" : "MALFORMED_RECORD",
    message: "Transcript record could not be converted.",
    retryable: event.retryable,
    sourceLocator: event.sourceLocator,
  },
});

const fileTitle = (relativePath: string): string => {
  const name = relativePath.replaceAll("\\", "/").split("/").at(-1);
  return (name?.replace(/\.[^.]+$/u, "") || "Transcript").normalize("NFC");
};

const localIdentity = (
  segment: TranscriptSegment,
  occurrences: Map<string, number>
): string => {
  if (segment.externalId) {
    return `external:${hashRecordValue(
      "gno-transcript-external-id-v1",
      segment.externalId
    )}`;
  }
  if (segment.start) {
    const key = canonicalJson({
      end: segment.end,
      speaker: segment.speaker,
      start: segment.start,
    });
    const count = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, count);
    return `time:${hashRecordValue("gno-transcript-time-id-v1", key)}:${count}`;
  }
  if (segment.anchorKind === "record") {
    return `record:${hashRecordValue(
      "gno-transcript-record-id-v1",
      segment.anchorValue
    )}`;
  }
  return `content:${hashRecordValue(
    "gno-transcript-content-id-v1",
    canonicalJson({
      speaker: segment.speaker,
      text: segment.text,
    })
  )}`;
};

const segmentRecord = (
  segment: TranscriptSegment,
  namespace: string,
  defaultSessionTitle: string,
  occurrences: Map<string, number>
): RecordAdapterRecord => {
  const sessionTitle = segment.sessionTitle ?? defaultSessionTitle;
  const label = segment.speaker
    ? `${sessionTitle} — ${segment.speaker}`
    : sessionTitle;
  const details: string[] = [];
  if (segment.speaker)
    details.push(`**Speaker:** ${safeInlineText(segment.speaker)}`);
  if (segment.start) {
    details.push(
      `**Time:** ${segment.start}${segment.end ? ` → ${segment.end}` : ""}`
    );
  }
  const markdown = [
    `# ${safeInlineText(label)}`,
    ...details,
    segment.text,
  ].join("\n\n");
  const participants = [
    ...(segment.participants ?? []),
    ...(segment.speaker ? [segment.speaker] : []),
  ];
  const uniqueParticipants = [
    ...new Set(participants.map((value) => value.normalize("NFC").trim())),
  ].filter(Boolean);
  const anchors: RecordAdapterRecord["anchors"] = [
    {
      kind: segment.anchorKind,
      value: segment.anchorValue,
      endValue: segment.endAnchorValue,
    },
  ];
  if (segment.start) {
    anchors.push({
      kind: "timestamp",
      value: segment.start,
      endValue: segment.end,
    });
  }
  return {
    stableId: `transcript:${namespace}:${localIdentity(segment, occurrences)}`,
    sourceLocator: segment.sourceLocator,
    sourceHash: hashRecordValue(
      "gno-transcript-segment-source-v1",
      canonicalJson(segment)
    ),
    title: label,
    markdown,
    metadata: {
      author: segment.speaker,
      participants:
        uniqueParticipants.length > 0 ? uniqueParticipants : undefined,
      categories: ["transcript"],
      dateFields: segment.dateFields,
      sessionId: segment.sessionId,
    },
    anchors,
  };
};

const jsonEvents = async function* (
  input: RecordAdapterInput
): AsyncGenerator<TranscriptParseEvent> {
  const parts: string[] = [];
  let characters = 0;
  let lastLine = 0;
  const maxCharacters = Math.min(
    MAX_JSON_TRANSCRIPT_CHARS,
    input.limits.maxTotalChars
  );
  for await (const line of readBoundedUtf8Lines(
    input.open(),
    adapterLineByteLimit(input)
  )) {
    lastLine = line.lineNumber;
    if (!line.ok) {
      yield {
        ok: false,
        sourceLocator: `line:${line.lineNumber}`,
        retryable: !line.terminated,
        tooLarge: line.reason === "line_too_large",
      };
      return;
    }
    characters += line.text.length + 1;
    if (characters > maxCharacters) {
      yield {
        ok: false,
        sourceLocator: `lines:1-${line.lineNumber}`,
        retryable: false,
        tooLarge: true,
      };
      return;
    }
    parts.push(line.text);
  }
  if (parts.length === 0) {
    yield {
      ok: false,
      sourceLocator: lastLine > 0 ? `lines:1-${lastLine}` : "record:root",
      retryable: false,
    };
    return;
  }
  yield* parseJsonTranscript(parts.join("\n"));
};

const parseEvents = (
  input: RecordAdapterInput,
  format: Exclude<TranscriptFormat, "auto">
): AsyncIterable<TranscriptParseEvent> => {
  if (format === "json") return jsonEvents(input);
  const lines: AsyncIterable<Utf8LineResult> = readBoundedUtf8Lines(
    input.open(),
    adapterLineByteLimit(input)
  );
  if (format === "text") return parseTextTranscript(lines);
  return parseTimedTranscript(lines, format);
};

export const createTranscriptAdapter = (
  options: TranscriptAdapterOptions = {}
): RecordAdapter => {
  const { format: requested } = parseTranscriptAdapterOptions(options);
  return {
    id: ADAPTER_ID,
    version: ADAPTER_VERSION,
    configurationFingerprint: hashRecordValue(
      "gno-transcript-config-v1",
      requested
    ),
    canHandle: (mime, ext) => {
      if (requested === "json")
        return mime === "application/json" || ext === ".json";
      if (requested === "text") return mime === "text/plain" || ext === ".txt";
      if (requested === "vtt") return mime === "text/vtt" || ext === ".vtt";
      if (requested === "srt")
        return (
          mime === "application/x-subrip" ||
          mime === "text/srt" ||
          ext === ".srt"
        );
      return Boolean(resolvedFormat({ mime, ext }, requested));
    },
    records: async function* (
      input: RecordAdapterInput
    ): AsyncGenerator<RecordAdapterEvent> {
      const format = resolvedFormat(input, requested);
      if (!format) {
        yield failureEvent({ ok: false, retryable: false });
        yield { type: "snapshot", state: "partial" };
        return;
      }
      const namespace = sourceNamespace(input);
      const defaultSessionTitle = fileTitle(input.relativePath);
      const occurrences = new Map<string, number>();
      let hadFailure = false;
      try {
        for await (const event of parseEvents(input, format)) {
          if (!event.ok) {
            hadFailure = true;
            yield failureEvent(event);
            continue;
          }
          yield {
            type: "record",
            record: segmentRecord(
              event.segment,
              namespace,
              defaultSessionTitle,
              occurrences
            ),
          };
        }
      } catch {
        hadFailure = true;
        yield {
          type: "failure",
          failure: {
            code: "ADAPTER_FAILURE",
            message: "Transcript source could not be read completely.",
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

export const transcriptAdapter = createTranscriptAdapter();
