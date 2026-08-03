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
  let output = "";
  let cursor = 0;
  while (cursor < value.length) {
    if (value[cursor] !== "&") {
      output += value[cursor];
      cursor += 1;
      continue;
    }
    const entityEnd = Math.min(value.length, cursor + MAX_ENTITY_CHARS + 2);
    const semicolon = value.slice(cursor + 1, entityEnd).indexOf(";");
    const absoluteSemicolon = semicolon < 0 ? -1 : cursor + semicolon + 1;
    if (
      absoluteSemicolon < 0 ||
      absoluteSemicolon - cursor - 1 <= 0 ||
      absoluteSemicolon - cursor - 1 > MAX_ENTITY_CHARS
    ) {
      output += "&";
      cursor += 1;
      continue;
    }
    const entity = value.slice(cursor + 1, absoluteSemicolon);
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
    if (decoded === undefined) {
      output += value.slice(cursor, absoluteSemicolon + 1);
    } else {
      output += decoded;
    }
    cursor = absoluteSemicolon + 1;
  }
  return output;
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
  let output = "";
  let cursor = 0;
  let blockedName: "script" | "style" | undefined;
  let blockedDepth = 0;
  while (cursor < source.length) {
    if (source[cursor] !== "<") {
      if (!blockedName) output += source[cursor];
      cursor += 1;
      continue;
    }
    if (source.startsWith("<!--", cursor)) {
      const commentEnd = source.indexOf("-->", cursor + 4);
      if (commentEnd < 0) break;
      cursor = commentEnd + 3;
      continue;
    }
    const tag = readTag(source, cursor);
    if (!tag) {
      if (!blockedName) output += source.slice(cursor);
      break;
    }
    cursor = tag.end + 1;
    if (blockedName) {
      if (tag.name === blockedName) {
        if (tag.closing) blockedDepth -= 1;
        else blockedDepth += 1;
        if (blockedDepth === 0) blockedName = undefined;
      }
      continue;
    }
    if (!tag.closing && (tag.name === "script" || tag.name === "style")) {
      blockedName = tag.name;
      blockedDepth = 1;
      continue;
    }
    if (!tag.closing && tag.name === "br") output += "\n";
  }
  return decodeHtmlEntitiesOnce(output);
};
