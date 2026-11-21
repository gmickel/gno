import {
  decodeHtmlEntitiesOnce,
  htmlFragmentToText,
} from "../shared/html-text";

export type BrowserExportKind = "bookmark" | "history" | "reading-list";

export interface BrowserExportRecord {
  kind: BrowserExportKind;
  url: string;
  title?: string;
  folder?: string;
  tags?: string[];
  dates?: Record<string, string>;
  externalId?: string;
  sourceLocator: string;
}

export interface BrowserExportParseResult {
  records: BrowserExportRecord[];
  failures: string[];
}

const HTML_TOKEN_PATTERN =
  /<H3\b[^>]*>([\s\S]*?)<\/H3\s*>|<A\b([^>]*)>([\s\S]*?)<\/A\s*>|<DL\b[^>]*>|<\/DL\s*>/gi;
const ATTRIBUTE_PATTERN = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
const MAX_JSON_DEPTH = 32;
const WEBKIT_TO_UNIX_EPOCH_MS = 11_644_473_600_000;
const SENSITIVE_JSON_KEYS = new Set([
  "cookies",
  "passwords",
  "logins",
  "sessions",
  "creditcards",
]);
const SUPPORTED_JSON_KEYS = new Set([
  "roots",
  "children",
  "items",
  "bookmarks",
  "history",
  "readingList",
  "reading_list",
]);
const SUPPORTED_JSON_KEY_LIST = [...SUPPORTED_JSON_KEYS];
const BOOKMARK_EXPORT_DOCUMENT_PATTERN =
  /<!DOCTYPE\s+(?:NETSCAPE-Bookmark-file-1\b[^>]*|html\s*)>/i;
const NETSCAPE_STRUCTURE_TAG_PATTERN = /<(\/)?(DL|A|H3)(?:\b[^>]*>|\s*>)/gi;

const plainText = (value: string): string =>
  htmlFragmentToText(value).replace(/\s+/g, " ").trim();

const attributes = (value: string): Map<string, string> => {
  const result = new Map<string, string>();
  for (const match of value.matchAll(ATTRIBUTE_PATTERN)) {
    const key = match[1]?.toLowerCase();
    const item = match[2] ?? match[3] ?? match[4];
    if (key && item !== undefined)
      result.set(key, decodeHtmlEntitiesOnce(item));
  }
  return result;
};

const hasSensitiveJsonKey = (value: Record<string, unknown>): boolean =>
  Object.keys(value).some((key) => SENSITIVE_JSON_KEYS.has(key.toLowerCase()));

const hasCompleteNetscapeStructure = (source: string): boolean => {
  if (!BOOKMARK_EXPORT_DOCUMENT_PATTERN.test(source)) return false;
  let openingDl = 0;
  let closingDl = 0;
  let openingAnchors = 0;
  let closingAnchors = 0;
  let openingHeadings = 0;
  let closingHeadings = 0;
  NETSCAPE_STRUCTURE_TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  while ((match = NETSCAPE_STRUCTURE_TAG_PATTERN.exec(source)) !== null) {
    const raw = match[0];
    const closing = match[1] === "/";
    const tag = match[2]?.toLowerCase();
    // Preserve exact original closing-tag whitespace-only rule (`</TAG\s*>`).
    if (closing) {
      if (!/^<\/(?:dl|a|h3)\s*>$/i.test(raw)) continue;
      if (tag === "dl") closingDl += 1;
      else if (tag === "a") closingAnchors += 1;
      else if (tag === "h3") closingHeadings += 1;
    } else if (tag === "dl") {
      openingDl += 1;
    } else if (tag === "a") {
      openingAnchors += 1;
    } else if (tag === "h3") {
      openingHeadings += 1;
    }
  }
  return (
    openingDl > 0 &&
    openingDl === closingDl &&
    openingAnchors === closingAnchors &&
    openingHeadings === closingHeadings
  );
};

const exportDate = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const epoch = Number(value);
  if (Number.isFinite(epoch) && epoch >= 0) {
    let milliseconds: number;
    if (epoch >= 10_000_000_000_000_000) {
      milliseconds = epoch / 1_000 - WEBKIT_TO_UNIX_EPOCH_MS;
    } else {
      milliseconds = epoch > 10_000_000_000 ? epoch : epoch * 1_000;
    }
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

export function parseNetscapeBookmarks(
  source: string,
  maxRecords: number,
  maxFailures = 1_000
): BrowserExportParseResult {
  const records: BrowserExportRecord[] = [];
  const failures: string[] = [];
  const folders: string[] = [];
  let pendingFolder: string | undefined;
  let anchorNumber = 0;
  let failureCapReached = false;
  const addFailure = (locator: string): boolean => {
    if (failureCapReached) return true;
    if (failures.length < maxFailures) failures.push(locator);
    if (failures.length < maxFailures) return false;
    failures.push("failure-limit");
    failureCapReached = true;
    return failureCapReached;
  };
  if (!hasCompleteNetscapeStructure(source)) {
    addFailure("unsupported-html");
    return { records, failures };
  }
  let dlDepth = 0;
  for (const token of source.matchAll(HTML_TOKEN_PATTERN)) {
    const raw = token[0].toLowerCase();
    if (token[1] !== undefined) {
      pendingFolder = plainText(token[1]);
      continue;
    }
    if (raw.startsWith("<dl")) {
      dlDepth += 1;
      if (pendingFolder) folders.push(pendingFolder);
      pendingFolder = undefined;
      continue;
    }
    if (raw.startsWith("</dl")) {
      if (dlDepth === 0) {
        addFailure("html-structure");
        break;
      }
      dlDepth -= 1;
      folders.pop();
      continue;
    }
    if (token[2] === undefined || token[3] === undefined) continue;
    anchorNumber += 1;
    if (records.length >= maxRecords) {
      addFailure(`bookmark:${anchorNumber}/record-limit`);
      break;
    }
    const attrs = attributes(token[2]);
    const url = attrs.get("href");
    if (!url) {
      if (addFailure(`bookmark:${anchorNumber}`)) break;
      continue;
    }
    const rawAdded = attrs.get("add_date");
    const rawModified = attrs.get("last_modified");
    const added = exportDate(rawAdded);
    const modified = exportDate(rawModified);
    if ((rawAdded && !added) || (rawModified && !modified)) {
      if (addFailure(`bookmark:${anchorNumber}/date`)) break;
    }
    records.push({
      kind: "bookmark",
      url,
      title: plainText(token[3]),
      folder: folders.join("/"),
      tags: attrs
        .get("tags")
        ?.split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      dates:
        added || modified
          ? {
              ...(added ? { added } : {}),
              ...(modified ? { modified } : {}),
            }
          : undefined,
      sourceLocator: `bookmark:${anchorNumber}`,
    });
  }
  if (dlDepth !== 0 && !failureCapReached) addFailure("html-structure");
  return { records, failures };
}

const stringValue = (
  value: Record<string, unknown>,
  keys: string[]
): string | undefined => {
  for (const key of keys) {
    if (typeof value[key] === "string") return value[key] as string;
    if (typeof value[key] === "number") return String(value[key]);
  }
  return undefined;
};

const kindValue = (value: Record<string, unknown>): BrowserExportKind => {
  const raw = stringValue(value, ["kind", "type"])?.toLowerCase();
  if (raw?.includes("history") || raw === "visit") return "history";
  if (raw?.includes("reading") || raw === "read") return "reading-list";
  return "bookmark";
};

const itemRecord = (
  value: Record<string, unknown>,
  locator: string,
  folders: string[]
): BrowserExportRecord | undefined => {
  const url = stringValue(value, ["url", "href", "uri"]);
  if (!url) return undefined;
  const tags = Array.isArray(value.tags)
    ? value.tags.filter((tag): tag is string => typeof tag === "string")
    : typeof value.tags === "string"
      ? value.tags.split(",").map((tag) => tag.trim())
      : undefined;
  const rawAdded = stringValue(value, ["date_added", "dateAdded", "added"]);
  const rawVisited = stringValue(value, [
    "last_visit_time",
    "lastVisitTime",
    "visited_at",
  ]);
  const rawRead = stringValue(value, ["read_at", "readAt"]);
  const added = exportDate(rawAdded);
  const visited = exportDate(rawVisited);
  const read = exportDate(rawRead);
  if ((rawAdded && !added) || (rawVisited && !visited) || (rawRead && !read)) {
    return undefined;
  }
  const dateEntries: Array<[string, string]> = [];
  if (added) dateEntries.push(["added", added]);
  if (visited) dateEntries.push(["visited", visited]);
  if (read) dateEntries.push(["read", read]);
  return {
    kind: kindValue(value),
    url,
    title: stringValue(value, ["name", "title"]),
    folder: stringValue(value, ["folder", "path"]) ?? folders.join("/"),
    tags,
    dates: dateEntries.length > 0 ? Object.fromEntries(dateEntries) : undefined,
    externalId: stringValue(value, ["id", "guid", "uuid"]),
    sourceLocator: locator,
  };
};

export function parseBrowserJson(
  source: string,
  maxRecords: number,
  maxFailures = 1_000
): BrowserExportParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { records: [], failures: ["json"] };
  }
  if (!Array.isArray(parsed) && (!parsed || typeof parsed !== "object")) {
    return { records: [], failures: ["unsupported-json"] };
  }
  if (!Array.isArray(parsed)) {
    const rootKeys = Object.keys(parsed as Record<string, unknown>);
    if (hasSensitiveJsonKey(parsed as Record<string, unknown>)) {
      return { records: [], failures: ["sensitive-json"] };
    }
    if (!rootKeys.some((key) => SUPPORTED_JSON_KEYS.has(key))) {
      return { records: [], failures: ["unsupported-json"] };
    }
  }
  const records: BrowserExportRecord[] = [];
  const failures: string[] = [];
  let capReached = false;
  let failureCapReached = false;
  const addFailure = (locator: string): boolean => {
    if (failureCapReached) return true;
    if (failures.length < maxFailures) failures.push(locator);
    if (failures.length < maxFailures) return false;
    failures.push("failure-limit");
    failureCapReached = true;
    capReached = true;
    return true;
  };
  const stopAtCap = (locator: string): boolean => {
    if (records.length < maxRecords) return false;
    if (!capReached) addFailure(`${locator}/record-limit`);
    capReached = true;
    return true;
  };
  const visit = (
    value: unknown,
    locator: string,
    folders: string[],
    depth: number
  ): void => {
    if (capReached) return;
    if (depth > MAX_JSON_DEPTH) {
      addFailure(locator);
      return;
    }
    if (Array.isArray(value)) {
      for (const [index, child] of value.entries()) {
        if (stopAtCap(`${locator}/${index}`)) break;
        visit(child, `${locator}/${index}`, folders, depth + 1);
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (hasSensitiveJsonKey(object)) {
      addFailure(`${locator}/sensitive`);
      return;
    }
    const record = itemRecord(object, locator, folders);
    if (record) {
      if (stopAtCap(locator)) return;
      records.push(record);
    }
    const folderName =
      !record && typeof object.name === "string" ? object.name : undefined;
    const nextFolders = folderName ? [...folders, folderName] : folders;
    const supportedChildren = SUPPORTED_JSON_KEY_LIST.filter((key) =>
      Object.hasOwn(object, key)
    );
    if (!record && supportedChildren.length === 0) {
      addFailure(locator);
      return;
    }
    for (const key of supportedChildren) {
      const child = object[key];
      const validRoots =
        key === "roots" &&
        child !== null &&
        typeof child === "object" &&
        !Array.isArray(child);
      const validItems = key !== "roots" && Array.isArray(child);
      if (!(validRoots || validItems)) {
        if (addFailure(`${locator}/${key}`)) break;
        continue;
      }
      if (validRoots) {
        for (const [rootName, root] of Object.entries(
          child as Record<string, unknown>
        )) {
          if (capReached) break;
          visit(root, `${locator}/roots/${rootName}`, nextFolders, depth + 1);
        }
      } else {
        visit(child, `${locator}/${key}`, nextFolders, depth + 1);
      }
      if (capReached) break;
    }
  };
  visit(parsed, "json", [], 0);
  return { records, failures };
}
