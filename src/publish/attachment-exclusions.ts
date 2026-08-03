/** CommonMark literal ranges excluded from publish attachment discovery. */

import { type ExcludedRange, getExcludedRanges } from "../ingestion/strip";

const lineAllowsIndentedCodeStart = (line: string): boolean =>
  line.trim().length === 0 ||
  /^ {0,3}#{1,6}(?:[ \t]|$)/u.test(line) ||
  /^ {0,3}(?:`{3,}|~{3,})/u.test(line) ||
  /^ {0,3}(?:=+|-+)[ \t]*$/u.test(line) ||
  /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/u.test(line);

const stripContainerPrefixes = (line: string): string => {
  let content = line;
  while (true) {
    const quote = /^ {0,3}>[ \t]?/u.exec(content)?.[0];
    if (quote) {
      content = content.slice(quote.length);
      continue;
    }
    const list = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]/u.exec(content)?.[0];
    if (list) {
      content = content.slice(list.length);
      continue;
    }
    return content;
  }
};

const collectIndentedCodeRanges = (markdown: string): ExcludedRange[] => {
  const ranges: ExcludedRange[] = [];
  let blockStart: number | null = null;
  let offset = 0;
  let previousLineAllowsStart = true;

  while (offset <= markdown.length) {
    const nextNewline = markdown.indexOf("\n", offset);
    const lineEnd = nextNewline === -1 ? markdown.length : nextNewline;
    const rawLine = markdown.slice(offset, lineEnd);
    const physicalLine = rawLine.endsWith("\r")
      ? rawLine.slice(0, -1)
      : rawLine;
    const line = stripContainerPrefixes(physicalLine);
    const lineBlank = line.trim().length === 0;
    const lineIndented = /^(?: {4}|\t)/u.test(line);

    if (blockStart !== null && !(lineIndented || lineBlank)) {
      ranges.push({ start: blockStart, end: offset, kind: "fenced_code" });
      blockStart = null;
    } else if (blockStart === null && lineIndented && previousLineAllowsStart) {
      blockStart = offset;
    }

    previousLineAllowsStart = lineAllowsIndentedCodeStart(line);
    if (nextNewline === -1) break;
    offset = nextNewline + 1;
  }

  if (blockStart !== null) {
    ranges.push({
      start: blockStart,
      end: markdown.length,
      kind: "fenced_code",
    });
  }
  return ranges;
};

const RAW_HTML_CONTENT_TAGS = "script|pre|style|textarea";
const HTML_BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";

const collectRawHtmlBlockRanges = (markdown: string): ExcludedRange[] => {
  const ranges: ExcludedRange[] = [];
  const rawContentStart = new RegExp(
    `^ {0,3}<(${RAW_HTML_CONTENT_TAGS})(?:[\\s>]|$)`,
    "iu"
  );
  const blockStart = new RegExp(
    `^ {0,3}</?(?:${HTML_BLOCK_TAGS})(?:[\\s/>]|$)`,
    "iu"
  );
  const genericBlockStart =
    /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t][^<>]*)?\/?>[ \t]*$/u;
  let offset = 0;
  let previousLineBlank = true;

  while (offset < markdown.length) {
    const lineEndIndex = markdown.indexOf("\n", offset);
    const lineEnd = lineEndIndex === -1 ? markdown.length : lineEndIndex + 1;
    const line = markdown.slice(offset, lineEnd).replace(/\r?\n$/u, "");
    const literalBlock = [
      { endMarker: "?>", start: /^ {0,3}<\?/u },
      { endMarker: ">", start: /^ {0,3}<![A-Z]/u },
      { endMarker: "]]>", start: /^ {0,3}<!\[CDATA\[/u },
    ].find((candidate) => candidate.start.test(line));
    if (literalBlock) {
      const close = markdown.indexOf(literalBlock.endMarker, offset);
      const end =
        close === -1 ? markdown.length : close + literalBlock.endMarker.length;
      ranges.push({ start: offset, end, kind: "html_comment" });
      offset = end;
      previousLineBlank = true;
      continue;
    }
    const rawMatch = rawContentStart.exec(line);
    if (rawMatch) {
      const tag = rawMatch[1] ?? "";
      const closingTag = new RegExp(`</${tag}[ \\t]*>`, "giu");
      closingTag.lastIndex = offset + rawMatch[0].length;
      const close = closingTag.exec(markdown);
      const end = close ? close.index + close[0].length : markdown.length;
      ranges.push({ start: offset, end, kind: "html_comment" });
      offset = end;
      previousLineBlank = true;
      continue;
    }
    if (
      blockStart.test(line) ||
      (previousLineBlank && genericBlockStart.test(line))
    ) {
      let end = lineEnd;
      while (end < markdown.length) {
        const nextEndIndex = markdown.indexOf("\n", end);
        const nextEnd =
          nextEndIndex === -1 ? markdown.length : nextEndIndex + 1;
        const nextLine = markdown.slice(end, nextEnd).replace(/\r?\n$/u, "");
        if (nextLine.trim().length === 0) break;
        end = nextEnd;
      }
      ranges.push({ start: offset, end, kind: "html_comment" });
      offset = end;
      previousLineBlank = true;
      continue;
    }
    previousLineBlank = line.trim().length === 0;
    offset = lineEnd;
  }

  return ranges;
};

export const collectAttachmentExcludedRanges = (
  markdown: string
): ExcludedRange[] =>
  [
    ...getExcludedRanges(markdown),
    ...collectIndentedCodeRanges(markdown),
    ...collectRawHtmlBlockRanges(markdown),
  ].sort((left, right) => left.start - right.start);
