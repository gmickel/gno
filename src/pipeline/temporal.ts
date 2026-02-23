/**
 * Temporal range parsing helpers for retrieval filters.
 *
 * @module src/pipeline/temporal
 */

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const RECENCY_SORT_RE =
  /\b(latest|newest|most recent|recent|today|yesterday|this week|last week|this month|last month)\b/;

export interface TemporalRange {
  since?: string;
  until?: string;
}

type BoundKind = "since" | "until";

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(23, 59, 59, 999);
  return out;
}

function startOfWeekUtc(d: Date): Date {
  const out = startOfDay(d);
  const day = out.getUTCDay(); // 0 = Sunday
  const mondayOffset = day === 0 ? -6 : 1 - day;
  out.setUTCDate(out.getUTCDate() + mondayOffset);
  return out;
}

function endOfWeekUtc(d: Date): Date {
  const start = startOfWeekUtc(d);
  const out = new Date(start);
  out.setUTCDate(out.getUTCDate() + 6);
  return endOfDay(out);
}

function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function endOfMonthUtc(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999)
  );
}

function normalizeParsedDate(value: string, kind: BoundKind): string | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  if (DATE_ONLY_RE.test(value)) {
    return (
      kind === "since" ? startOfDay(parsed) : endOfDay(parsed)
    ).toISOString();
  }

  return parsed.toISOString();
}

function parseRelative(
  value: string,
  kind: BoundKind,
  now: Date
): string | null {
  const v = value.trim().toLowerCase();

  if (v === "today") {
    return (kind === "since" ? startOfDay(now) : endOfDay(now)).toISOString();
  }
  if (v === "yesterday") {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 1);
    return (kind === "since" ? startOfDay(d) : endOfDay(d)).toISOString();
  }
  if (v === "this week") {
    return (kind === "since" ? startOfWeekUtc(now) : now).toISOString();
  }
  if (v === "last week") {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 7);
    return (
      kind === "since" ? startOfWeekUtc(d) : endOfWeekUtc(d)
    ).toISOString();
  }
  if (v === "this month") {
    return (kind === "since" ? startOfMonthUtc(now) : now).toISOString();
  }
  if (v === "last month") {
    const d = new Date(now);
    d.setUTCMonth(d.getUTCMonth() - 1);
    return (
      kind === "since" ? startOfMonthUtc(d) : endOfMonthUtc(d)
    ).toISOString();
  }
  if (v === "recent") {
    if (kind === "until") {
      return now.toISOString();
    }
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 30);
    return d.toISOString();
  }

  return null;
}

function parseBound(
  input: string | undefined,
  kind: BoundKind,
  now: Date
): string | undefined {
  if (!input) {
    return undefined;
  }
  const relative = parseRelative(input, kind, now);
  if (relative) {
    return relative;
  }
  return normalizeParsedDate(input, kind) ?? undefined;
}

function inferFromQuery(query: string, now: Date): TemporalRange {
  const q = query.toLowerCase();

  if (/\btoday\b/.test(q)) {
    return {
      since: parseRelative("today", "since", now) ?? undefined,
      until: parseRelative("today", "until", now) ?? undefined,
    };
  }
  if (/\byesterday\b/.test(q)) {
    return {
      since: parseRelative("yesterday", "since", now) ?? undefined,
      until: parseRelative("yesterday", "until", now) ?? undefined,
    };
  }
  if (/\bthis week\b/.test(q)) {
    return {
      since: parseRelative("this week", "since", now) ?? undefined,
      until: parseRelative("this week", "until", now) ?? undefined,
    };
  }
  if (/\blast week\b/.test(q)) {
    return {
      since: parseRelative("last week", "since", now) ?? undefined,
      until: parseRelative("last week", "until", now) ?? undefined,
    };
  }
  if (/\bthis month\b/.test(q)) {
    return {
      since: parseRelative("this month", "since", now) ?? undefined,
      until: parseRelative("this month", "until", now) ?? undefined,
    };
  }
  if (/\blast month\b/.test(q)) {
    return {
      since: parseRelative("last month", "since", now) ?? undefined,
      until: parseRelative("last month", "until", now) ?? undefined,
    };
  }
  if (/\brecent\b/.test(q)) {
    return {
      since: parseRelative("recent", "since", now) ?? undefined,
      until: parseRelative("recent", "until", now) ?? undefined,
    };
  }

  return {};
}

/**
 * Resolve temporal bounds from explicit flags or query text.
 */
export function resolveTemporalRange(
  query: string,
  sinceInput?: string,
  untilInput?: string,
  now = new Date()
): TemporalRange {
  const since = parseBound(sinceInput, "since", now);
  const until = parseBound(untilInput, "until", now);

  if (since || until) {
    return { since, until };
  }

  return inferFromQuery(query, now);
}

/**
 * Return true when timestamp falls inside optional range.
 */
export function isWithinTemporalRange(
  timestamp: string | undefined,
  range: TemporalRange
): boolean {
  if (!timestamp) {
    return true;
  }
  const t = new Date(timestamp).getTime();
  if (Number.isNaN(t)) {
    return true;
  }
  if (range.since) {
    const since = new Date(range.since).getTime();
    if (!Number.isNaN(since) && t < since) {
      return false;
    }
  }
  if (range.until) {
    const until = new Date(range.until).getTime();
    if (!Number.isNaN(until) && t > until) {
      return false;
    }
  }
  return true;
}

/**
 * Return true when query intent implies newest-first ordering.
 */
export function shouldSortByRecency(query: string): boolean {
  return RECENCY_SORT_RE.test(query.toLowerCase());
}

/**
 * Prefer canonical doc date; fallback to source modified time.
 * Returns 0 when neither value is valid.
 */
export function resolveRecencyTimestamp(
  docDate?: string | null,
  sourceModifiedAt?: string | null
): number {
  if (docDate) {
    const parsed = new Date(docDate).getTime();
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  if (sourceModifiedAt) {
    const parsed = new Date(sourceModifiedAt).getTime();
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return 0;
}
