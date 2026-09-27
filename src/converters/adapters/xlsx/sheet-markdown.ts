/**
 * Worksheet to Markdown table, linear in cells (fn-198).
 *
 * Reproduces the Markdown the markitdown-ts chain produces for a worksheet
 * (SheetJS `sheet_to_html` -> jsdom -> turndown + Joplin GFM tables) without
 * building a DOM. That chain is O(columns x rows^2) and uses about 20 KB per
 * cell: the GFM plugin's column-alignment scan re-reads `table.rows.length`
 * through a jsdom proxy for every row of every column. Here each cell is
 * rendered once from the sheet data:
 *
 * - cell text is chosen as `sheet_to_html` does (`h`, or escaped `w`),
 * - plain text goes through turndown's whitespace collapsing and Markdown
 *   escaping, per line (a line break starts a new text node),
 * - cells whose HTML carries markup (rich-text runs, hyperlinks) are
 *   converted by turndown itself with the same rules, one cell at a time,
 * - rows, the empty heading row, `---` borders (SheetJS never sets an
 *   alignment), merges (`colspan` padding, covered cells skipped) and the
 *   single-cell-table case follow the GFM plugin.
 *
 * @module src/converters/adapters/xlsx/sheet-markdown
 */

import type { CellObject, WorkSheet } from "xlsx";

// @ts-expect-error -- @joplin/turndown-plugin-gfm ships no types
import turndownPluginGfm from "@joplin/turndown-plugin-gfm";
// @ts-expect-error -- turndown ships no types
import TurndownService from "turndown";
import * as XLSX from "xlsx";

/** The part of turndown's API this module uses. */
interface Turndown {
  turndown(html: string): string;
  use(plugin: unknown): Turndown;
  addRule(
    key: string,
    rule: {
      filter: string[];
      replacement: (
        content: string,
        node: { getAttribute(name: string): string | null; title: string }
      ) => string;
    }
  ): Turndown;
}
const TurndownConstructor = TurndownService as new (options: {
  headingStyle: "atx";
}) => Turndown;

/** SheetJS `escapehtml` (xlsx 0.20.3), used to recognise plain cell HTML. */
const HTML_ENCODINGS: Record<string, string> = {
  '"': "&quot;",
  "'": "&apos;",
  ">": "&gt;",
  "<": "&lt;",
  "&": "&amp;",
};
const escapeHtml = (text: string): string =>
  text
    .replace(/[&<>'"]/g, (char) => HTML_ENCODINGS[char] ?? char)
    .replace(/\n/g, "<br/>")
    .replace(
      // oxlint-disable-next-line no-control-regex -- SheetJS htmlcharegex: C0 controls become numeric references
      /[\u0000-\u001f]/g,
      (char) => `&#x${`000${char.charCodeAt(0).toString(16)}`.slice(-4)};`
    );

/** turndown 7.2 `escapeMarkdown`, applied to each text node. */
const MARKDOWN_ESCAPES: Array<[RegExp, string]> = [
  [/\\/g, "\\\\"],
  [/\*/g, "\\*"],
  [/^-/g, "\\-"],
  [/^\+ /g, "\\+ "],
  [/^(=+)/g, "\\$1"],
  [/^(#{1,6}) /g, "\\$1 "],
  [/`/g, "\\`"],
  [/^~~~/g, "\\~~~"],
  [/\[/g, "\\["],
  [/\]/g, "\\]"],
  [/^>/g, "\\>"],
  [/_/g, "\\_"],
  [/^(\d+)\. /g, "$1\\. "],
];
/** Cheap pre-test: text that no escape rule can touch skips the chain. */
const MAY_NEED_ESCAPE = /[\\*`[\]_]|^[-+=#~>\d]/;

const escapeMarkdown = (text: string): string =>
  MAY_NEED_ESCAPE.test(text)
    ? MARKDOWN_ESCAPES.reduce(
        (value, [pattern, replacement]) => value.replace(pattern, replacement),
        text
      )
    : text;

/** turndown's `<br>` replacement with the default `br: "  "` option. */
const LINE_BREAK = "  \n";

/**
 * Plain cell text as turndown renders it inside a table cell: each line is a
 * text node whose whitespace runs collapse to one space, with the leading
 * and trailing space dropped (cells and line breaks are block boundaries),
 * escaped on its own; every line break renders, empty lines included.
 */
const plainCellContent = (text: string): string => {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    // The HTML parser turns the escaped NUL (&#x0000;) into U+FFFD.
    const line = raw
      .replaceAll("\u0000", "\uFFFD")
      .replace(/[ \r\n\t]+/g, " ")
      .replace(/^ | $/g, "");
    lines.push(line ? escapeMarkdown(line) : "");
  }
  return lines.join(LINE_BREAK);
};

let markupTurndown: Turndown | null = null;
const markupCache = new Map<string, string>();

/**
 * Cell HTML with markup (rich-text runs, a hyperlink), converted by turndown
 * with markitdown's rules. A paragraph gives the same block context as a
 * table cell.
 */
const markupCellContent = (html: string): string => {
  const cached = markupCache.get(html);
  if (cached !== undefined) return cached;
  markupTurndown ??= createMarkitdownTurndown();
  const content = markupTurndown.turndown(`<p>${html}</p>`);
  markupCache.set(html, content);
  return content;
};

/** markitdown-ts `CustomTurnDown` configuration (vendored dist). */
function createMarkitdownTurndown(): Turndown {
  const service = new TurndownConstructor({ headingStyle: "atx" });
  service.use((turndownPluginGfm as { gfm: unknown }).gfm);
  service.addRule("anchor tags", {
    filter: ["a"],
    replacement(content, node) {
      if (content === "") return "";
      const prefix = content[0] === " " ? " " : "";
      const suffix = content.at(-1) === " " ? " " : "";
      const text = content.trim().replace(/\n\n.*/g, "");
      if (text === "") return "";
      const href = node.getAttribute("href");
      let title = node.title;
      if (href) {
        try {
          const parsed = new URL(href);
          if (!["https:", "http:", "file:"].includes(parsed.protocol)) {
            return `${prefix}${text}${suffix}`;
          }
        } catch {
          if (!/^https?:|^file:/.test(href)) {
            return `${prefix}[${text}](${href} "${title}")${suffix}`;
          }
          return `${prefix}${text}${suffix}`;
        }
      }
      if (text.replace(/\\_/g, "_") === href && !title) return `<${href}>`;
      if (!title && href) title = href;
      const titlePart = title ? ` "${title}"` : "";
      return `${prefix}[${text}](${href}${titlePart})${suffix}`;
    },
  });
  return service;
}

/** Joplin GFM `cell()`: trim, `<br>` for newlines, escape pipes, pad. */
const formatCell = (content: string, first: boolean, colspan: number) => {
  let value = content
    .trim()
    .replace(/\n\r/g, "<br>")
    .replace(/\n/g, "<br>")
    .replace(/\|+/g, "\\|");
  while (value.length < 3) value += " ";
  for (let extra = 1; extra < colspan; extra += 1) value += " |    ";
  return `${first ? "| " : " "}${value} |`;
};

/** SheetJS error text for non-finite numbers (`make_html_row`). */
const nonFiniteText = (value: number): string =>
  Number.isNaN(value) ? "#NUM!" : "#DIV/0!";

/**
 * Cell Markdown content (before `formatCell`), from the HTML `make_html_row`
 * (xlsx 0.20.3) writes for it: `h` if present, else the escaped formatted
 * text, wrapped in a link for an external hyperlink. HTML that is exactly
 * the escaped text is rendered from the text; any other HTML goes through
 * turndown.
 */
const cellContent = (cell: CellObject | undefined): string => {
  if (!cell || cell.v == null) return "";
  let text: string;
  let html: string;
  if (cell.t === "n" && !Number.isFinite(cell.v as number)) {
    // SheetJS swaps in an error cell, which has no `h` and no hyperlink.
    text = nonFiniteText(cell.v as number);
    return text ? plainCellContent(text) : "";
  }
  if (cell.h) {
    html = cell.h;
    text = typeof cell.v === "string" ? cell.v : "";
  } else {
    text =
      cell.w ||
      (XLSX.utils.format_cell(cell), cell.w as string | undefined) ||
      "";
    html = escapeHtml(text);
  }
  if (!html) return "";
  const target = cell.l?.Target;
  if (target && target.charAt(0) !== "#") {
    return markupCellContent(`<a href="${escapeHtml(target)}">${html}</a>`);
  }
  return escapeHtml(text) === html
    ? plainCellContent(text)
    : markupCellContent(html);
};

interface MergeSpan {
  rowspan: number;
  colspan: number;
}

/**
 * Merge lookup as `make_html_row` resolves it: the first merge (in sheet
 * order) containing a cell decides; its top-left cell carries the span and
 * the other covered cells are skipped.
 */
const mergeLookup = (
  merges: XLSX.Range[]
): ((row: number, col: number) => MergeSpan | "covered" | undefined) => {
  if (merges.length === 0) return () => undefined;
  const byCell = new Map<string, MergeSpan | "covered">();
  for (let index = merges.length - 1; index >= 0; index -= 1) {
    const merge = merges[index];
    if (!merge) continue;
    for (let row = merge.s.r; row <= merge.e.r; row += 1) {
      for (let col = merge.s.c; col <= merge.e.c; col += 1) {
        byCell.set(
          `${row}:${col}`,
          row === merge.s.r && col === merge.s.c
            ? {
                rowspan: merge.e.r - merge.s.r + 1,
                colspan: merge.e.c - merge.s.c + 1,
              }
            : "covered"
        );
      }
    }
  }
  return (row, col) => byCell.get(`${row}:${col}`);
};

const readCell = (
  sheet: WorkSheet,
  row: number,
  col: number
): CellObject | undefined => {
  const dense = (sheet as { "!data"?: CellObject[][] })["!data"];
  if (dense) return dense[row]?.[col];
  return sheet[XLSX.utils.encode_cell({ r: row, c: col })] as
    | CellObject
    | undefined;
};

/**
 * Markdown for one worksheet with a `!ref`, trimmed as markitdown trims it.
 * Output matches `turndown(sheet_to_html(sheet))` for the same sheet.
 */
export function sheetToMarkdown(sheet: WorkSheet): string {
  const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1");
  const mergeAt = mergeLookup(sheet["!merges"] ?? []);
  const rows: string[] = [];
  let columnCount = 0;
  let onlyCell: string | null = null;
  let firstRowCells = 0;
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    const cells: string[] = [];
    let cellCount = 0;
    for (let col = range.s.c; col <= range.e.c; col += 1) {
      const merge = mergeAt(row, col);
      if (merge === "covered") continue;
      const content = cellContent(readCell(sheet, row, col));
      cells.push(formatCell(content, cellCount === 0, merge?.colspan ?? 1));
      cellCount += 1;
      onlyCell = content;
    }
    columnCount = Math.max(columnCount, cellCount);
    if (row === range.s.r) firstRowCells = cellCount;
    // A row whose cells are all covered by merges renders as an empty line,
    // which the GFM plugin collapses away.
    if (cells.length > 0) rows.push(cells.join(""));
  }

  // A one-row table with at most one cell is left as plain content.
  if (range.e.r === range.s.r && firstRowCells <= 1) {
    return (onlyCell ?? "").trim();
  }

  const secondLine = rows[1] ?? "";
  const header =
    columnCount && !/\| :?---/.test(secondLine)
      ? `|${"     |".repeat(columnCount)}\n|${" --- |".repeat(columnCount)}\n`
      : "";
  return `${header}${rows.join("\n")}`.trim();
}
