const NAMED_ENTITIES = new Map<string, string>([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["quot", '"'],
]);
const MAX_ENTITY_CHARS = 16;

const isAsciiWhitespace = (value: string): boolean =>
  value === " " ||
  value === "\t" ||
  value === "\n" ||
  value === "\r" ||
  value === "\f";

const isTagNameCharacter = (value: string): boolean => {
  const code = value.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    value === "-"
  );
};

const isHexDigit = (value: string): boolean => {
  const code = value.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 70) ||
    (code >= 97 && code <= 102)
  );
};

const hasOnlyDigits = (value: string, hexadecimal: boolean): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const digit = value[index] ?? "";
    if (hexadecimal ? !isHexDigit(digit) : digit < "0" || digit > "9")
      return false;
  }
  return value.length > 0;
};

/** Decode recognized entities from the original input exactly once. */
export const decodeHtmlEntitiesOnce = (value: string): string => {
  let amp = value.indexOf("&");
  if (amp === -1) return value;
  const parts: string[] = [];
  let cursor = 0;
  while (amp !== -1) {
    if (amp > cursor) {
      parts.push(value.slice(cursor, amp));
    }
    const entityEnd = Math.min(value.length, amp + MAX_ENTITY_CHARS + 2);
    let absoluteSemicolon = -1;
    for (let i = amp + 1; i < entityEnd; i += 1) {
      if (value.charCodeAt(i) === 59) {
        absoluteSemicolon = i;
        break;
      }
    }
    if (
      absoluteSemicolon < 0 ||
      absoluteSemicolon - amp - 1 <= 0 ||
      absoluteSemicolon - amp - 1 > MAX_ENTITY_CHARS
    ) {
      parts.push("&");
      cursor = amp + 1;
      amp = value.indexOf("&", cursor);
      continue;
    }
    const entity = value.slice(amp + 1, absoluteSemicolon);
    const named = NAMED_ENTITIES.get(entity.toLowerCase());
    let decoded = named;
    if (!decoded && entity.startsWith("#")) {
      const hexadecimal =
        entity.length > 2 && (entity[1] === "x" || entity[1] === "X");
      const digits = entity.slice(hexadecimal ? 2 : 1);
      const base = hexadecimal ? 16 : 10;
      const codePoint = hasOnlyDigits(digits, hexadecimal)
        ? Number.parseInt(digits, base)
        : Number.NaN;
      if (
        Number.isSafeInteger(codePoint) &&
        codePoint > 0 &&
        codePoint <= 0x10ffff &&
        !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        decoded = String.fromCodePoint(codePoint);
      }
    }
    parts.push(
      decoded === undefined ? value.slice(amp, absoluteSemicolon + 1) : decoded
    );
    cursor = absoluteSemicolon + 1;
    amp = value.indexOf("&", cursor);
  }
  if (cursor < value.length) {
    parts.push(value.slice(cursor));
  }
  return parts.join("");
};

interface HtmlTag {
  closing: boolean;
  end: number;
  name: string;
}

const readTag = (source: string, start: number): HtmlTag | undefined => {
  const end = source.indexOf(">", start + 1);
  if (end < 0) return undefined;
  let cursor = start + 1;
  while (cursor < end && isAsciiWhitespace(source[cursor] ?? "")) cursor += 1;
  const closing = source[cursor] === "/";
  if (closing) {
    cursor += 1;
    while (cursor < end && isAsciiWhitespace(source[cursor] ?? "")) cursor += 1;
  }
  const nameStart = cursor;
  while (cursor < end && isTagNameCharacter(source[cursor] ?? "")) cursor += 1;
  return {
    closing,
    end,
    name: source.slice(nameStart, cursor).toLowerCase(),
  };
};

/**
 * Reduce a bounded HTML fragment to inert text with a linear scanner.
 * Script/style contents and comments are discarded; entities decode once.
 */
export const htmlFragmentToText = (source: string): string => {
  let lt = source.indexOf("<");
  if (lt === -1) return decodeHtmlEntitiesOnce(source);
  const parts: string[] = [];
  let cursor = 0;
  let blockedName: "script" | "style" | undefined;
  let blockedDepth = 0;
  while (lt !== -1) {
    if (!blockedName && lt > cursor) {
      parts.push(source.slice(cursor, lt));
    }
    if (source.startsWith("<!--", lt)) {
      const commentEnd = source.indexOf("-->", lt + 4);
      if (commentEnd < 0) {
        cursor = source.length;
        break;
      }
      cursor = commentEnd + 3;
      lt = source.indexOf("<", cursor);
      continue;
    }
    const tag = readTag(source, lt);
    if (!tag) {
      if (!blockedName) parts.push(source.slice(lt));
      cursor = source.length;
      break;
    }
    cursor = tag.end + 1;
    if (blockedName) {
      if (tag.name === blockedName) {
        if (tag.closing) blockedDepth -= 1;
        else blockedDepth += 1;
        if (blockedDepth === 0) blockedName = undefined;
      }
    } else if (
      !tag.closing &&
      (tag.name === "script" || tag.name === "style")
    ) {
      blockedName = tag.name;
      blockedDepth = 1;
    } else if (!tag.closing && tag.name === "br") {
      parts.push("\n");
    }
    lt = source.indexOf("<", cursor);
  }
  if (!blockedName && cursor < source.length) {
    parts.push(source.slice(cursor));
  }
  return decodeHtmlEntitiesOnce(parts.join(""));
};
