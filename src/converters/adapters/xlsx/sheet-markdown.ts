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
type TurndownConstructorType = new (options: {
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
const plainLineContent = (raw: string): string => {
  // The HTML parser turns the escaped NUL (&#x0000;) into U+FFFD.
  const line = raw
    .replaceAll("\u0000", "\uFFFD")
    .replace(/[ \r\n\t]+/g, " ")
    .replace(/^ | $/g, "");
  return line ? escapeMarkdown(line) : "";
};

const plainCellContent = (text: string): string => {
  if (!text.includes("\n")) {
    return plainLineContent(text);
  }
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    lines.push(plainLineContent(raw));
  }
  return lines.join(LINE_BREAK);
};

let markupTurndown: Turndown | null = null;
let markupTurndownPromise: Promise<Turndown> | null = null;
const markupCache = new Map<string, string>();

/**
 * Cell HTML with markup (rich-text runs, a hyperlink), converted by turndown
 * with markitdown's rules. Dynamically imports turndown + GFM plugin only when
 * rich-text or hyperlink markup is actually encountered.
 */
const markupCellContent = async (html: string): Promise<string> => {
  const cached = markupCache.get(html);
  if (cached !== undefined) return cached;
  if (!markupTurndown) {
    markupTurndownPromise ??= createMarkitdownTurndown();
    markupTurndown = await markupTurndownPromise;
  }
  const content = markupTurndown.turndown(`<p>${html}</p>`);
  markupCache.set(html, content);
  return content;
};

/** markitdown-ts `CustomTurnDown` configuration (vendored dist). */
async function createMarkitdownTurndown(): Promise<Turndown> {
  const [turndownMod, gfmMod] = await Promise.all([
    // @ts-expect-error -- turndown ships no types
    import("turndown"),
    // @ts-expect-error -- @joplin/turndown-plugin-gfm ships no types
    import("@joplin/turndown-plugin-gfm"),
  ]);
  const TurndownConstructor = (turndownMod.default ??
    turndownMod) as TurndownConstructorType;
  const turndownPluginGfm = (gfmMod.default ?? gfmMod) as { gfm: unknown };
  const service = new TurndownConstructor({ headingStyle: "atx" });
  service.use(turndownPluginGfm.gfm);
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
const cellContent = (
  cell: CellObject | undefined
): string | Promise<string> => {
  if (!cell || cell.v == null) return "";
  if (cell.t === "n" && !Number.isFinite(cell.v as number)) {
    // SheetJS swaps in an error cell, which has no `h` and no hyperlink.
    const text = nonFiniteText(cell.v as number);
    return text ? plainCellContent(text) : "";
  }
  const target = cell.l?.Target;
  const hasExternalLink = Boolean(target && target.charAt(0) !== "#");
  if (cell.h) {
    const html = cell.h;
    if (hasExternalLink) {
      return markupCellContent(`<a href="${escapeHtml(target!)}">${html}</a>`);
    }
    const text = typeof cell.v === "string" ? cell.v : "";
    return escapeHtml(text) === html
      ? plainCellContent(text)
      : markupCellContent(html);
  }
  const text =
    cell.w ||
    (XLSX.utils.format_cell(cell), cell.w as string | undefined) ||
    "";
  if (!text) return "";
  if (hasExternalLink) {
    return markupCellContent(
      `<a href="${escapeHtml(target!)}">${escapeHtml(text)}</a>`
    );
  }
  // Plain cell with no cell.h and no external link: skip escapeHtml completely.
  return plainCellContent(text);
};

interface MergeSpan {
  rowspan: number;
  colspan: number;
}

interface MergeLookupIndex {
  minRow: number;
  maxRow: number;
  byRow: Map<number, Map<number, MergeSpan | "covered">>;
}

/**
 * Merge lookup as `make_html_row` resolves it: the first merge (in sheet
 * order) containing a cell decides; its top-left cell carries the span and
 * the other covered cells are skipped. Keyed numerically by row -> col with
 * a row-range bailout to avoid per-cell `${row}:${col}` string allocations.
 */
const buildMergeLookup = (merges: XLSX.Range[]): MergeLookupIndex | null => {
  if (merges.length === 0) return null;
  const byRow = new Map<number, Map<number, MergeSpan | "covered">>();
  let minRow = Number.POSITIVE_INFINITY;
  let maxRow = Number.NEGATIVE_INFINITY;
  for (let index = merges.length - 1; index >= 0; index -= 1) {
    const merge = merges[index];
    if (!merge) continue;
    if (merge.s.r < minRow) minRow = merge.s.r;
    if (merge.e.r > maxRow) maxRow = merge.e.r;
    for (let row = merge.s.r; row <= merge.e.r; row += 1) {
      let rowMap = byRow.get(row);
      if (!rowMap) {
        rowMap = new Map();
        byRow.set(row, rowMap);
      }
      for (let col = merge.s.c; col <= merge.e.c; col += 1) {
        rowMap.set(
          col,
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
  return byRow.size > 0 ? { minRow, maxRow, byRow } : null;
};

const readCell = (
  sheet: WorkSheet,
  dense: CellObject[][] | undefined,
  row: number,
  col: number
): CellObject | undefined => {
  if (dense) return dense[row]?.[col];
  return sheet[XLSX.utils.encode_cell({ r: row, c: col })] as
    | CellObject
    | undefined;
};

/**
 * Markdown for one worksheet with a `!ref`, trimmed as markitdown trims it.
 * Output matches `turndown(sheet_to_html(sheet))` for the same sheet.
 */
export async function sheetToMarkdown(sheet: WorkSheet): Promise<string> {
  // Memoized markup is per sheet: the file processor reuses one worker across
  // files, so a process-wide cache would retain every earlier workbook.
  markupCache.clear();
  const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1");
  const merges = buildMergeLookup(sheet["!merges"] ?? []);
  const dense = (sheet as { "!data"?: CellObject[][] })["!data"];
  const rows: string[] = [];
  let columnCount = 0;
  let onlyCell: string | null = null;
  let firstRowCells = 0;
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    const rowMerges =
      merges && row >= merges.minRow && row <= merges.maxRow
        ? merges.byRow.get(row)
        : undefined;
    const cells: string[] = [];
    let cellCount = 0;
    for (let col = range.s.c; col <= range.e.c; col += 1) {
      const merge = rowMerges?.get(col);
      if (merge === "covered") continue;
      const rawContent = cellContent(readCell(sheet, dense, row, col));
      const content =
        typeof rawContent === "string" ? rawContent : await rawContent;
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
