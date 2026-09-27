/**
 * Edge-case workbook for the xlsx converter equivalence check (fn-198):
 * every Markdown escape trigger, whitespace and line breaks, entities,
 * pipes, numbers, dates, booleans, errors, merges, hyperlinks, rich-text
 * runs, a single-cell sheet, an offset range, an empty sheet, and a second
 * row that looks like a table divider. Built on the fly; nothing binary is
 * committed.
 */

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import * as XLSX from "xlsx";

const RICH_MARKER = "RICH_TEXT_MARKER";

export function buildEdgeCaseWorkbook(): Uint8Array {
  const workbook = XLSX.utils.book_new();

  const rows: unknown[][] = [
    ["Kind", "Value", "Other"],
    [":---", "second row looks like a divider", ""],
    ["negative", -5, -0.25],
    ["list", "1. item", "12. twelve"],
    ["heading", "# head", "###### six"],
    ["plus", "+ plus", "+nospace"],
    ["equals", "== eq", "="],
    ["quote", "> quote", ">"],
    ["fence", "~~~fence", "a ~~~ b"],
    ["pipes", "a|b||c", "|lead"],
    ["markers", "under_score *star* [br]acket", "back\\slash `tick`"],
    ["spaces", "  leading and   inner  spaces  ", "\ttab\tseparated"],
    ["lines", "multi\nline\n\n  indented\n-dash", "trailing\n"],
    ["nbsp", "nbsp end ", " "],
    ["entities", "&<>'\" & amp", "&amp;"],
    ["control", "bell\u0007char", "cr\r\nlf"],
    ["empty", "", null],
    ["numbers", 0, 1234567.891],
    ["boolean", true, false],
    ["date", new Date(Date.UTC(2025, 0, 15)), ""],
    ["error", { t: "e", v: 0x2a }, ""],
    ["link", "external", "internal"],
    ["rich", RICH_MARKER, "plain"],
    ["merged across", "", ""],
    ["merged down", "x", ""],
    ["", "y", ""],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
  const errorCell = sheet.A21 as XLSX.CellObject | undefined;
  if (errorCell) {
    errorCell.t = "e";
    errorCell.v = 0x2a;
    errorCell.w = "#N/A";
  }
  sheet.B22 = {
    t: "s",
    v: "external",
    l: { Target: "https://example.com/a_b?x=1" },
  };
  sheet.C22 = { t: "s", v: "internal", l: { Target: "#Offset!B3" } };
  sheet["!merges"] = [
    XLSX.utils.decode_range("B24:C24"),
    XLSX.utils.decode_range("A25:A26"),
  ];
  XLSX.utils.book_append_sheet(workbook, sheet, "Edge cases");

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["only cell"]]),
    "Single"
  );
  const offset: XLSX.WorkSheet = {};
  XLSX.utils.sheet_add_aoa(
    offset,
    [
      ["b3", "c3"],
      ["b4", -1],
    ],
    {
      origin: "B3",
    }
  );
  offset["!ref"] = "B3:C4";
  XLSX.utils.book_append_sheet(workbook, offset, "Offset");
  XLSX.utils.book_append_sheet(workbook, {}, "Empty");

  const written = XLSX.write(workbook, {
    type: "array",
    bookType: "xlsx",
    bookSST: true,
  }) as ArrayBuffer;
  const files = unzipSync(new Uint8Array(written));
  const sst = strFromU8(files["xl/sharedStrings.xml"] ?? new Uint8Array());
  // Rich text: runs with formatting, a run starting with "-", a line break.
  files["xl/sharedStrings.xml"] = strToU8(
    sst.replace(
      `<si><t>${RICH_MARKER}</t></si>`,
      `<si><r><rPr><b/></rPr><t>Bold</t></r><r><t xml:space="preserve"> -tail_part</t></r><r><rPr><i/></rPr><t xml:space="preserve">
# next line</t></r></si>`
    )
  );
  return zipSync(files);
}
