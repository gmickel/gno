import type {
  RecordAdapter,
  RecordAdapterEvent,
  RecordAdapterInput,
  RecordAnchor,
} from "../../types";

import { summarizeRecurrence } from "./recurrence";

const DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/;
const NUMERIC_OFFSET_PATTERN = /[+-]\d{4}$/;

interface LogicalLine {
  text: string;
  startLine: number;
  endLine: number;
}

interface IcalProperty {
  name: string;
  params: Map<string, string>;
  value: string;
}

const failure = (
  sourceLocator: string,
  retryable = false
): RecordAdapterEvent => ({
  type: "failure",
  failure: {
    code: "MALFORMED_RECORD",
    message: "Malformed iCalendar event.",
    retryable,
    sourceLocator,
  },
});

async function* physicalLines(
  input: RecordAdapterInput
): AsyncGenerator<{ text: string; line: number }> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let line = 0;
  const maxRecordChars = input.limits.maxRecordChars;
  for await (const chunk of input.open()) {
    const decoded = decoder.decode(chunk, { stream: true });
    pending = pending.length > 0 ? pending + decoded : decoded;
    let cursor = 0;
    while (true) {
      const newline = pending.indexOf("\n", cursor);
      if (newline < 0) break;
      line += 1;
      const rawLength = newline - cursor;
      if (rawLength > maxRecordChars) {
        throw new Error("iCalendar physical line exceeded its limit.");
      }
      const lineEnd =
        rawLength > 0 && pending.charCodeAt(newline - 1) === 13
          ? newline - 1
          : newline;
      const lineStart =
        line === 1 && lineEnd > cursor && pending.charCodeAt(cursor) === 0xfeff
          ? cursor + 1
          : cursor;
      cursor = newline + 1;
      yield {
        text: pending.slice(lineStart, lineEnd),
        line,
      };
    }
    pending = cursor > 0 ? pending.slice(cursor) : pending;
    if (pending.length > maxRecordChars) {
      throw new Error("iCalendar physical line exceeded its limit.");
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) {
    if (pending.length > maxRecordChars) {
      throw new Error("iCalendar physical line exceeded its limit.");
    }
    line += 1;
    yield {
      text: pending.endsWith("\r") ? pending.slice(0, -1) : pending,
      line,
    };
  }
}

async function* logicalLines(
  input: RecordAdapterInput
): AsyncGenerator<LogicalLine> {
  let pending: LogicalLine | undefined;
  for await (const physical of physicalLines(input)) {
    if (/^[ \t]/.test(physical.text) && pending) {
      pending.text += physical.text.slice(1);
      if (pending.text.length > input.limits.maxRecordChars) {
        throw new Error("iCalendar unfolded line exceeded its limit.");
      }
      pending.endLine = physical.line;
      continue;
    }
    if (pending) yield pending;
    pending = {
      text: physical.text,
      startLine: physical.line,
      endLine: physical.line,
    };
  }
  if (pending) yield pending;
}

const parseProperty = (line: string): IcalProperty | undefined => {
  const colon = line.indexOf(":");
  if (colon <= 0) return undefined;
  const [rawName, ...rawParams] = line.slice(0, colon).split(";");
  const name = rawName?.trim().toUpperCase();
  if (!name) return undefined;
  const params = new Map<string, string>();
  for (const rawParam of rawParams) {
    const equals = rawParam.indexOf("=");
    if (equals <= 0) continue;
    const key = rawParam.slice(0, equals).trim().toUpperCase();
    const value = rawParam
      .slice(equals + 1)
      .trim()
      .replace(/^"|"$/g, "");
    params.set(key, value);
  }
  return { name, params, value: line.slice(colon + 1).trim() };
};

const unescapeText = (value: string): string =>
  value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]#!])/g, "\\$1");

const validCalendarDate = (
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0
): boolean => {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
};

const normalizeDate = (property: IcalProperty): string | undefined => {
  if (NUMERIC_OFFSET_PATTERN.test(property.value)) return undefined;
  const dateOnly = DATE_PATTERN.exec(property.value);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    if (!validCalendarDate(Number(year), Number(month), Number(day))) {
      return undefined;
    }
    return `${year}-${month}-${day}`;
  }
  const dateTime = DATE_TIME_PATTERN.exec(property.value);
  if (!dateTime) return undefined;
  const [, year, month, day, hour, minute, second, utc] = dateTime;
  if (
    !validCalendarDate(
      Number(year),
      Number(month),
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    )
  ) {
    return undefined;
  }
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  if (utc) return `${iso}Z`;
  const timezone = property.params.get("TZID");
  return timezone ? `TZID=${timezone}:${iso}` : iso;
};

const participant = (property: IcalProperty): string => {
  const address = property.value.replace(/^mailto:/i, "");
  const name = property.params.get("CN");
  return unescapeText(name ? `${name} <${address}>` : address);
};

const values = (properties: IcalProperty[], name: string): IcalProperty[] =>
  properties.filter((property) => property.name === name);

const first = (
  properties: IcalProperty[],
  name: string
): IcalProperty | undefined => values(properties, name)[0];

const convertEvent = (
  properties: IcalProperty[],
  startLine: number,
  endLine: number
): RecordAdapterEvent | undefined => {
  const uid = first(properties, "UID")?.value.normalize("NFC").trim();
  if (!uid) return undefined;
  const startProperty = first(properties, "DTSTART");
  const endProperty = first(properties, "DTEND");
  const start = startProperty ? normalizeDate(startProperty) : undefined;
  const end = endProperty ? normalizeDate(endProperty) : undefined;
  if ((startProperty && !start) || (endProperty && !end)) return undefined;
  const invalidRecurrenceDate = properties
    .filter((property) =>
      ["RECURRENCE-ID", "RDATE", "EXDATE"].includes(property.name)
    )
    .some((property) =>
      property.value
        .split(",")
        .some((value) => !normalizeDate({ ...property, value }))
    );
  if (invalidRecurrenceDate) return undefined;
  const recurrence = summarizeRecurrence(properties, startProperty?.value);
  const recurrenceIdProperty = first(properties, "RECURRENCE-ID");
  const recurrenceIdentity = recurrenceIdProperty
    ? normalizeDate(recurrenceIdProperty)
    : undefined;
  if (recurrenceIdProperty && !recurrenceIdentity) return undefined;
  const summary = unescapeText(first(properties, "SUMMARY")?.value ?? "Event");
  const description = first(properties, "DESCRIPTION")?.value;
  const location = first(properties, "LOCATION")?.value;
  const organizerProperty = first(properties, "ORGANIZER");
  const createdProperty = first(properties, "CREATED");
  const updatedProperty = first(properties, "LAST-MODIFIED");
  const attendees = values(properties, "ATTENDEE").map(participant);
  const organizer = organizerProperty
    ? participant(organizerProperty)
    : undefined;
  const categories = values(properties, "CATEGORIES")
    .flatMap((property) => property.value.split(","))
    .map(unescapeText)
    .filter(Boolean);
  const lines = [`# ${summary}`];
  if (start) lines.push(`Start: ${start}`);
  if (end) lines.push(`End: ${end}`);
  if (location) lines.push(`Location: ${unescapeText(location)}`);
  if (organizer) lines.push(`Organizer: ${organizer}`);
  if (attendees.length > 0) lines.push(`Attendees: ${attendees.join(", ")}`);
  if (description) lines.push("", unescapeText(description));
  if (recurrence.rrule) {
    lines.push("", `Recurrence: ${unescapeText(recurrence.rrule)}`);
  }
  if (recurrence.truncated) {
    lines.push("Recurrence anchors: truncated to the bounded local horizon");
  }
  const stableId = recurrenceIdentity
    ? `ical:${uid}::recurrence:${recurrenceIdentity}`
    : `ical:${uid}`;
  const anchors: RecordAnchor[] = [
    { kind: "event", value: uid },
    ...recurrence.occurrenceAnchors.map((value) => ({
      kind: "timestamp" as const,
      value,
    })),
  ];
  return {
    type: "record",
    record: {
      stableId,
      sourceLocator: `lines:${startLine}-${endLine}`,
      markdown: lines.join("\n"),
      title: summary,
      metadata: {
        author: organizer,
        participants: [
          ...new Set([organizer, ...attendees].filter(Boolean)),
        ] as string[],
        categories,
        dateFields: Object.fromEntries(
          [
            ["start", start],
            ["end", end],
            ["created", createdProperty && normalizeDate(createdProperty)],
            ["updated", updatedProperty && normalizeDate(updatedProperty)],
          ].filter((entry): entry is [string, string] => Boolean(entry[1]))
        ),
        eventId: uid,
      },
      anchors,
    },
  };
};

async function* parseCalendar(
  input: RecordAdapterInput
): AsyncGenerator<RecordAdapterEvent> {
  let sawCalendar = false;
  let calendarOpen = false;
  let endedCalendar = false;
  let eventStart = 0;
  let eventChars = 0;
  let eventProperties: IcalProperty[] | undefined;
  const nestedComponents: string[] = [];
  const calendarComponents: string[] = [];
  let hadFailure = false;
  try {
    for await (const line of logicalLines(input)) {
      if (line.text === "BEGIN:VCALENDAR") {
        if (sawCalendar || calendarOpen || endedCalendar || eventProperties) {
          hadFailure = true;
          yield failure(`line:${line.startLine}`);
          continue;
        }
        sawCalendar = true;
        calendarOpen = true;
        continue;
      }
      if (line.text === "END:VCALENDAR") {
        if (
          !calendarOpen ||
          eventProperties ||
          nestedComponents.length > 0 ||
          calendarComponents.length > 0
        ) {
          hadFailure = true;
          yield failure(`line:${line.startLine}`);
          continue;
        }
        calendarOpen = false;
        endedCalendar = true;
        continue;
      }
      if (line.text === "BEGIN:VEVENT") {
        if (
          !calendarOpen ||
          endedCalendar ||
          eventProperties ||
          calendarComponents.length > 0
        ) {
          hadFailure = true;
          yield failure(`line:${line.startLine}`);
          continue;
        }
        eventStart = line.startLine;
        eventChars = 0;
        nestedComponents.length = 0;
        eventProperties = [];
        continue;
      }
      if (line.text === "END:VEVENT") {
        if (!eventProperties || nestedComponents.length > 0) {
          hadFailure = true;
          yield failure(`line:${line.startLine}`);
          continue;
        }
        const converted = convertEvent(
          eventProperties,
          eventStart,
          line.endLine
        );
        if (converted) yield converted;
        else {
          hadFailure = true;
          yield failure(`lines:${eventStart}-${line.endLine}`);
        }
        eventProperties = undefined;
        continue;
      }
      if (!eventProperties) {
        if (!line.text.trim()) continue;
        if (!calendarOpen || endedCalendar) {
          hadFailure = true;
          yield failure(`line:${line.startLine}`);
          continue;
        }
        if (line.text.startsWith("BEGIN:")) {
          const component = line.text.slice("BEGIN:".length).trim();
          if (!component) {
            hadFailure = true;
            yield failure(`line:${line.startLine}`);
          } else {
            calendarComponents.push(component);
          }
          continue;
        }
        if (line.text.startsWith("END:")) {
          const component = line.text.slice("END:".length).trim();
          if (!component || calendarComponents.at(-1) !== component) {
            hadFailure = true;
            yield failure(`line:${line.startLine}`);
          } else {
            calendarComponents.pop();
          }
          continue;
        }
        if (!parseProperty(line.text)) {
          hadFailure = true;
          yield failure(`line:${line.startLine}`);
        }
        continue;
      }
      if (line.text.startsWith("BEGIN:")) {
        const component = line.text.slice("BEGIN:".length).trim();
        if (!component) {
          hadFailure = true;
          yield failure(`line:${line.startLine}`);
        } else {
          nestedComponents.push(component);
        }
        continue;
      }
      if (line.text.startsWith("END:") && nestedComponents.length > 0) {
        const component = line.text.slice("END:".length).trim();
        if (nestedComponents.at(-1) !== component) {
          hadFailure = true;
          yield failure(`line:${line.startLine}`);
        } else {
          nestedComponents.pop();
        }
        continue;
      }
      if (line.text.startsWith("END:")) {
        hadFailure = true;
        yield failure(`line:${line.startLine}`);
        continue;
      }
      if (nestedComponents.length > 0) continue;
      eventChars += line.text.length;
      if (eventChars > input.limits.maxRecordChars) {
        hadFailure = true;
        yield {
          type: "failure",
          failure: {
            code: "RECORD_TOO_LARGE",
            message: "iCalendar event exceeded its record limit.",
            retryable: false,
            sourceLocator: `line:${eventStart}`,
          },
        };
        eventProperties = undefined;
        continue;
      }
      const property = parseProperty(line.text);
      if (property) eventProperties.push(property);
      else {
        hadFailure = true;
        yield failure(`line:${line.startLine}`);
      }
    }
  } catch {
    hadFailure = true;
    yield failure("calendar", true);
  }
  if (eventProperties) {
    hadFailure = true;
    yield failure(`line:${eventStart}`, true);
  }
  if (calendarOpen || calendarComponents.length > 0) {
    hadFailure = true;
    yield failure("calendar", true);
  }
  const complete =
    sawCalendar &&
    endedCalendar &&
    !calendarOpen &&
    calendarComponents.length === 0 &&
    !hadFailure;
  yield { type: "snapshot", state: complete ? "complete" : "partial" };
}

export const icalAdapter: RecordAdapter = {
  id: "adapter/ical-export",
  version: "1.0.0",
  canHandle: (mime, ext) => mime === "text/calendar" || ext === ".ics",
  records: parseCalendar,
};
