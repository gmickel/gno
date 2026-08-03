/**
 * CommonMark destination token helpers for reference-safe rewrites.
 *
 * @module src/core/link-destination-parse
 */

/** ASCII punctuation escapable with `\` in CommonMark destinations. */
const COMMONMARK_ESCAPABLE = new Set([
  "!",
  '"',
  "#",
  "$",
  "%",
  "&",
  "'",
  "(",
  ")",
  "*",
  "+",
  ",",
  "-",
  ".",
  "/",
  ":",
  ";",
  "<",
  "=",
  ">",
  "?",
  "@",
  "[",
  "\\",
  "]",
  "^",
  "_",
  "`",
  "{",
  "|",
  "}",
  "~",
  // Destination paths also use backslash-escaped spaces in CommonMark practice.
  " ",
]);

export interface LinkEncodingStyle {
  spaces: "percent" | "backslash" | "raw";
  parens: "percent" | "backslash" | "raw";
  /** True when the destination was wrapped in angle brackets. */
  angleBrackets: boolean;
}

export function detectEncodingStyle(destination: string): LinkEncodingStyle {
  const interior =
    destination.startsWith("<") && destination.endsWith(">")
      ? destination.slice(1, -1)
      : destination;
  const hasBackslashSpace = /\\[ ]/.test(interior);
  const hasBackslashParen = /\\[()]/.test(interior);
  return {
    spaces: interior.includes("%20")
      ? "percent"
      : hasBackslashSpace
        ? "backslash"
        : "raw",
    parens:
      interior.includes("%28") || interior.includes("%29")
        ? "percent"
        : hasBackslashParen
          ? "backslash"
          : "raw",
    angleBrackets:
      destination.startsWith("<") &&
      destination.endsWith(">") &&
      destination.length >= 2,
  };
}

/**
 * Unescape only safe CommonMark punctuation escapes for resolution.
 * Leaves unknown backslash sequences intact.
 */
export function unescapeCommonMarkDestination(raw: string): string {
  let result = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (ch === "\\" && next !== undefined && COMMONMARK_ESCAPABLE.has(next)) {
      result += next;
      i += 1;
      continue;
    }
    result += ch ?? "";
  }
  return result;
}

/**
 * Strip a single outer CommonMark angle-bracket wrapper when present.
 */
export function stripAngleBracketDestination(raw: string): {
  path: string;
  angleBrackets: boolean;
} {
  if (raw.startsWith("<") && raw.endsWith(">") && raw.length >= 2) {
    return { path: raw.slice(1, -1), angleBrackets: true };
  }
  return { path: raw, angleBrackets: false };
}

/**
 * Re-apply the observed escape/encoding style to a replacement path token.
 * Does not wrap angle brackets — callers leave `<>` outside the edit span.
 */
export function applyDestinationEncodingStyle(
  pathValue: string,
  style: LinkEncodingStyle
): string {
  let result = pathValue;
  if (style.spaces === "percent") {
    result = result.replaceAll(" ", "%20");
  } else if (style.spaces === "backslash") {
    result = result.replaceAll(" ", "\\ ");
  }
  if (style.parens === "percent") {
    result = result.replaceAll("(", "%28").replaceAll(")", "%29");
  } else if (style.parens === "backslash") {
    result = result.replaceAll("(", "\\(").replaceAll(")", "\\)");
  }
  return result;
}

export function splitDestinationPath(raw: string): {
  path: string;
  query?: string;
  anchor?: string;
} {
  let remaining = raw;
  let anchor: string | undefined;
  let query: string | undefined;

  const hashIndex = remaining.indexOf("#");
  if (hashIndex >= 0) {
    anchor = remaining.slice(hashIndex + 1);
    remaining = remaining.slice(0, hashIndex);
  }
  const queryIndex = remaining.indexOf("?");
  if (queryIndex >= 0) {
    query = remaining.slice(queryIndex + 1);
    remaining = remaining.slice(0, queryIndex);
  }
  return {
    path: remaining,
    query: query && query.length > 0 ? query : undefined,
    anchor: anchor && anchor.length > 0 ? anchor : undefined,
  };
}

/**
 * Parse a CommonMark link destination inside parentheses, allowing balanced
 * parentheses, angle-bracket destinations, and an optional title after whitespace.
 */
export function parseParenthesizedDestination(
  markdown: string,
  openParenOffset: number
): {
  destinationRaw: string;
  destinationStart: number;
  destinationEnd: number;
  closeParenOffset: number;
  titlePresent: boolean;
  angleBrackets: boolean;
} | null {
  if (markdown[openParenOffset] !== "(") return null;
  let i = openParenOffset + 1;
  while (i < markdown.length && /[ \t]/.test(markdown[i] ?? "")) i += 1;

  const destStart = i;
  let depth = 0;
  let destEnd = -1;
  let angleBrackets = false;

  if (markdown[i] === "<") {
    const closeAngle = markdown.indexOf(">", i + 1);
    if (closeAngle < 0) return null;
    angleBrackets = true;
    destEnd = closeAngle + 1;
    i = destEnd;
    while (i < markdown.length && /[ \t]/.test(markdown[i] ?? "")) i += 1;
    if (markdown[i] === ")") {
      const destinationRaw = markdown.slice(destStart, destEnd);
      return {
        destinationRaw,
        destinationStart: destStart,
        destinationEnd: destEnd,
        closeParenOffset: i,
        titlePresent: false,
        angleBrackets,
      };
    }
    // Title may follow; fall through with destEnd already set.
  } else {
    while (i < markdown.length) {
      const ch = markdown[i];
      if (ch === undefined) break;
      if (ch === "\\" && i + 1 < markdown.length) {
        i += 2;
        continue;
      }
      if (ch === "(") {
        depth += 1;
        i += 1;
        continue;
      }
      if (ch === ")") {
        if (depth === 0) {
          destEnd = i;
          break;
        }
        depth -= 1;
        i += 1;
        continue;
      }
      if (
        depth === 0 &&
        (ch === " " || ch === "\t" || ch === "\n" || ch === "\r")
      ) {
        destEnd = i;
        break;
      }
      i += 1;
    }
  }

  if (destEnd < 0) return null;

  let close = destEnd;
  let titlePresent = false;
  if (destEnd < markdown.length && /[ \t\r\n]/.test(markdown[destEnd] ?? "")) {
    titlePresent = true;
    let j = destEnd;
    while (j < markdown.length && /[ \t\r\n]/.test(markdown[j] ?? "")) j += 1;
    const opener = markdown[j];
    if (opener === '"' || opener === "'") {
      j += 1;
      while (j < markdown.length && markdown[j] !== opener) {
        if (markdown[j] === "\\" && j + 1 < markdown.length) j += 2;
        else j += 1;
      }
      if (markdown[j] !== opener) return null;
      j += 1;
    } else if (opener === "(") {
      j += 1;
      while (j < markdown.length && markdown[j] !== ")") {
        if (markdown[j] === "\\" && j + 1 < markdown.length) j += 2;
        else j += 1;
      }
      if (markdown[j] !== ")") return null;
      j += 1;
    }
    while (j < markdown.length && /[ \t]/.test(markdown[j] ?? "")) j += 1;
    if (markdown[j] !== ")") return null;
    close = j;
  }

  const destinationRaw = markdown.slice(destStart, destEnd);
  if (!destinationRaw) return null;
  return {
    destinationRaw,
    destinationStart: destStart,
    destinationEnd: destEnd,
    closeParenOffset: close,
    titlePresent,
    angleBrackets,
  };
}
