export type TagMode = "any" | "all";

export type QueryModeType = "term" | "intent" | "hyde";

export interface QueryModeEntry {
  mode: QueryModeType;
  text: string;
}

export interface RetrievalFiltersState {
  collection: string;
  intent: string;
  candidateLimit: string;
  exclude: string;
  since: string;
  until: string;
  category: string;
  author: string;
  tagMode: TagMode;
  tags: string[];
  queryModes: QueryModeEntry[];
}

const TAG_SEGMENT_REGEX = /^[\p{Ll}\p{Lo}\p{N}][\p{Ll}\p{Lo}\p{N}\-.]*$/u;

export function normalizeTag(tag: string): string {
  return tag.trim().normalize("NFC").toLowerCase();
}

export function isValidTag(tag: string): boolean {
  if (tag.length === 0) {
    return false;
  }
  if (tag.startsWith("/") || tag.endsWith("/")) {
    return false;
  }
  const segments = tag.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || !TAG_SEGMENT_REGEX.test(segment)) {
      return false;
    }
  }
  return true;
}

export function parseTagsCsv(csv: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawTag of csv.split(",")) {
    const tag = normalizeTag(rawTag);
    if (!isValidTag(tag) || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

export function parseQueryModeSpec(spec: string): QueryModeEntry | null {
  const delimiter = spec.indexOf(":");
  if (delimiter <= 0) {
    return null;
  }
  const rawMode = spec.slice(0, delimiter).trim().toLowerCase();
  const mode =
    rawMode === "term" || rawMode === "intent" || rawMode === "hyde"
      ? rawMode
      : null;
  if (!mode) {
    return null;
  }
  const text = spec.slice(delimiter + 1).trim();
  if (text.length === 0) {
    return null;
  }
  return { mode, text };
}

export function serializeQueryModeSpec(entry: QueryModeEntry): string {
  return `${entry.mode}:${entry.text}`;
}

export function parseQueryModes(values: string[]): QueryModeEntry[] {
  const out: QueryModeEntry[] = [];
  const seen = new Set<string>();
  let hasHyde = false;

  for (const value of values) {
    const parsed = parseQueryModeSpec(value);
    if (!parsed) {
      continue;
    }

    const dedupeKey = `${parsed.mode}:${parsed.text}`;
    if (seen.has(dedupeKey)) {
      continue;
    }

    if (parsed.mode === "hyde") {
      if (hasHyde) {
        continue;
      }
      hasHyde = true;
    }

    seen.add(dedupeKey);
    out.push(parsed);
  }

  return out;
}

export function parseFiltersFromSearch(
  search: string,
  defaults: Partial<RetrievalFiltersState> = {}
): RetrievalFiltersState {
  const params = new URLSearchParams(search);

  const tagsAll = params.get("tagsAll");
  const tagsAny = params.get("tagsAny");
  const tagMode: TagMode = tagsAll ? "all" : "any";
  const tags = parseTagsCsv(tagsAll ?? tagsAny ?? "");

  return {
    collection: params.get("collection") ?? defaults.collection ?? "",
    intent: params.get("intent") ?? defaults.intent ?? "",
    candidateLimit:
      params.get("candidateLimit") ?? defaults.candidateLimit ?? "",
    exclude: params.get("exclude") ?? defaults.exclude ?? "",
    since: params.get("since") ?? defaults.since ?? "",
    until: params.get("until") ?? defaults.until ?? "",
    category: params.get("category") ?? defaults.category ?? "",
    author: params.get("author") ?? defaults.author ?? "",
    tagMode,
    tags,
    queryModes:
      parseQueryModes(params.getAll("qm")) ?? defaults.queryModes ?? [],
  };
}

export function applyFiltersToUrl(
  url: URL,
  filters: RetrievalFiltersState
): void {
  const setOrDelete = (key: string, value: string) => {
    if (value.trim().length > 0) {
      url.searchParams.set(key, value.trim());
    } else {
      url.searchParams.delete(key);
    }
  };

  setOrDelete("collection", filters.collection);
  setOrDelete("intent", filters.intent);
  setOrDelete("candidateLimit", filters.candidateLimit);
  setOrDelete("exclude", filters.exclude);
  setOrDelete("since", filters.since);
  setOrDelete("until", filters.until);
  setOrDelete("category", filters.category);
  setOrDelete("author", filters.author);

  url.searchParams.delete("tagsAll");
  url.searchParams.delete("tagsAny");
  if (filters.tags.length > 0) {
    if (filters.tagMode === "all") {
      url.searchParams.set("tagsAll", filters.tags.join(","));
    } else {
      url.searchParams.set("tagsAny", filters.tags.join(","));
    }
  }

  url.searchParams.delete("qm");
  for (const queryMode of filters.queryModes) {
    url.searchParams.append("qm", serializeQueryModeSpec(queryMode));
  }
}
