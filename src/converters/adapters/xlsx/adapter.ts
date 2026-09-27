/**
 * Excel (.xlsx) converter: SheetJS workbook -> Markdown tables, linear in
 * cells (fn-198).
 *
 * Produces the Markdown markitdown-ts produced for workbooks (one `## sheet`
 * section and GFM table per sheet with a range) but renders each table
 * directly from the sheet data instead of through HTML, jsdom and turndown,
 * whose cost grew with columns x rows^2 and about 20 KB per cell. Pivot
 * cache parts are not user content and SheetJS does not read them, as
 * before.
 *
 * @module src/converters/adapters/xlsx/adapter
 */

import * as XLSX from "xlsx";

import type { Converter, ConvertInput, ConvertResult } from "../../types";

import { corruptError, permissionError, tooLargeError } from "../../errors";
import { ADAPTER_VERSIONS } from "../../versions";
import { isPasswordProtectedXlsx } from "../shared/ooxml-protection";
import { sheetToMarkdown } from "./sheet-markdown";

const CONVERTER_ID = "adapter/xlsx" as const;
const CONVERTER_VERSION = ADAPTER_VERSIONS.xlsx;
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PASSWORD_ERROR_REGEX = /password(?:-protected)?|no password given/i;
/** Output under this length from a larger file is flagged as lossy. */
const SHORT_OUTPUT_CHARS = 10;
const SHORT_OUTPUT_MIN_BYTES = 1000;

/**
 * Markdown for a parsed workbook: one section per sheet with a range,
 * normalized as markitdown-ts normalizes every result (line endings, outer
 * whitespace, at most one blank line).
 */
export function workbookToMarkdown(workbook: XLSX.WorkBook): string {
  let markdown = "";
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (sheet?.["!ref"]) {
      markdown += `## ${name}\n${sheetToMarkdown(sheet)}\n\n`;
    }
  }
  return markdown
    .replace(/\r\n|\r|\n/g, "\n")
    .trim()
    .replace(/\n{3,}/g, "\n\n");
}

export const xlsxAdapter: Converter = {
  id: CONVERTER_ID,
  version: CONVERTER_VERSION,

  canHandle(mime: string, ext: string): boolean {
    return ext === ".xlsx" || mime === XLSX_MIME;
  },

  convert(input: ConvertInput): Promise<ConvertResult> {
    return Promise.resolve(convertWorkbook(input));
  },
};

function convertWorkbook(input: ConvertInput): ConvertResult {
  if (input.bytes.length > input.limits.maxBytes) {
    return { ok: false, error: tooLargeError(input, CONVERTER_ID) };
  }
  if (isPasswordProtectedXlsx(input.bytes)) {
    return {
      ok: false,
      error: permissionError(
        input,
        CONVERTER_ID,
        "File is password-protected",
        undefined,
        { protection: "xlsx" }
      ),
    };
  }

  let workbook: XLSX.WorkBook;
  try {
    // Dense sheets store rows as arrays: smaller than one object per cell.
    workbook = XLSX.read(input.bytes, { type: "buffer", dense: true });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      error: PASSWORD_ERROR_REGEX.test(message)
        ? permissionError(
            input,
            CONVERTER_ID,
            "File is password-protected",
            cause,
            { protection: "xlsx" }
          )
        : corruptError(
            input,
            CONVERTER_ID,
            "Could not read the .xlsx workbook",
            cause
          ),
    };
  }

  const markdown = workbookToMarkdown(workbook);
  if (!markdown) {
    return {
      ok: false,
      error: corruptError(input, CONVERTER_ID, "Empty conversion result"),
    };
  }
  const lossy =
    markdown.length < SHORT_OUTPUT_CHARS &&
    input.bytes.length > SHORT_OUTPUT_MIN_BYTES;
  return {
    ok: true,
    value: {
      markdown,
      title: workbook.Props?.Title || "Untitled",
      meta: {
        converterId: CONVERTER_ID,
        converterVersion: CONVERTER_VERSION,
        sourceMime: input.mime,
        warnings: lossy
          ? [{ code: "LOSSY", message: "Suspiciously short output" }]
          : undefined,
      },
    },
  };
}
