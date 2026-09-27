#!/usr/bin/env bun

/**
 * Generate a large pivot-table-shaped Excel workbook on the fly (fn-198).
 *
 * The workbook mirrors the shape that made 2.8.2 indexing run away: several
 * large worksheets backed by a shared-strings table, plus two pivot caches
 * whose record parts are many megabytes of XML. A handful of cells carry a
 * backtick (a typo for an apostrophe), which is enough to make converted
 * table text look like it may contain Markdown code.
 *
 * Nothing is committed: the default scale builds a multi-MB file in a few
 * seconds, and tests import `buildLargeWorkbook` at a small scale.
 *
 * Run: bun scripts/generate-large-workbook.ts <out.xlsx> [--scale 1]
 *   [--rows 300] [--metric-columns 88]
 *   --scale 1 is roughly 4 sheets x ~10 MB sheet XML (wide, formula-heavy
 *   rows: most sheet XML is formula text that never reaches converted
 *   output) and pivot records of ~17 MB and ~15 MB. Fractions shrink every
 *   part. Row count drives the vendored converter's own cost, so raise
 *   `--rows` with care (it is O(columns x rows^2) in turndown's GFM plugin).
 */

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import * as XLSX from "xlsx";

export interface LargeWorkbookOptions {
  /** Size multiplier; 1 matches the reported production workbook. */
  scale?: number;
  /** Worksheet count (default 4). */
  sheets?: number;
  /** Rows between cells carrying a backtick; 0 disables them. */
  backtickEvery?: number;
  /** Data rows per sheet at scale 1 (default 300). */
  rowsPerSheet?: number;
  /** Extra numeric metric columns after the 12 base columns (default 88). */
  metricColumns?: number;
}

const FULL_ROWS_PER_SHEET = 300;
const DEFAULT_METRIC_COLUMNS = 88;
const BASE_COLUMNS = 12;
const FULL_UNIQUE_STRINGS = 24_000;
const FULL_PIVOT_RECORDS = [330_000, 290_000] as const;
const DEFAULT_BACKTICK_EVERY = 250;

/** Deterministic PRNG (mulberry32) so the fixture is reproducible. */
const createRandom = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const REGIONS = ["North", "South", "East", "West", "Central"];
const PRODUCTS = ["Widget", "Gadget", "Sprocket", "Flange", "Gizmo", "Bolt"];

const buildRows = (
  rows: number,
  uniqueStrings: number,
  random: () => number,
  sheetIndex: number,
  backtickEvery: number,
  metricColumns: number
): (string | number)[][] => {
  const metricHeaders = Array.from(
    { length: metricColumns },
    (_, index) => `Metric ${index + 1}`
  );
  const data: (string | number)[][] = [
    [
      "Date",
      "Region",
      "Product",
      "Customer",
      "Account",
      "Channel",
      "Quantity",
      "Unit price",
      "Revenue",
      "Cost",
      "Margin",
      "Note",
      ...metricHeaders,
    ],
  ];
  for (let row = 1; row <= rows; row += 1) {
    const quantity = Math.floor(random() * 500) + 1;
    const price = Math.round(random() * 10_000) / 100;
    const revenue = Math.round(quantity * price * 100) / 100;
    const cost = Math.round(revenue * (0.4 + random() * 0.4) * 100) / 100;
    const customer = Math.floor(random() * uniqueStrings);
    const note =
      backtickEvery > 0 && row % backtickEvery === 0
        ? `customer didn\`t confirm ${customer}`
        : `Order ref ${sheetIndex}-${customer % 997}`;
    data.push([
      `2025-${String((row % 12) + 1).padStart(2, "0")}-${String((row % 28) + 1).padStart(2, "0")}`,
      REGIONS[row % REGIONS.length] ?? "North",
      PRODUCTS[Math.floor(random() * PRODUCTS.length)] ?? "Widget",
      `Customer ${customer}`,
      `ACC-${customer.toString(36).toUpperCase()}`,
      row % 3 === 0 ? "Online" : "Retail",
      quantity,
      price,
      revenue,
      cost,
      Math.round((revenue - cost) * 100) / 100,
      note,
      ...metricHeaders.map(() => Math.round(random() * 1_000_000) / 100),
    ]);
  }
  return data;
};

const pivotCacheDefinition = (index: number, records: number): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
  `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1" ` +
  `refreshOnLoad="1" recordCount="${records}">` +
  `<cacheSource type="worksheet"><worksheetSource ref="A1:L${records + 1}" sheet="Sheet${index}"/></cacheSource>` +
  `<cacheFields count="4">` +
  `<cacheField name="Region" numFmtId="0"><sharedItems count="${REGIONS.length}">${REGIONS.map((r) => `<s v="${r}"/>`).join("")}</sharedItems></cacheField>` +
  `<cacheField name="Product" numFmtId="0"><sharedItems count="${PRODUCTS.length}">${PRODUCTS.map((p) => `<s v="${p}"/>`).join("")}</sharedItems></cacheField>` +
  `<cacheField name="Quantity" numFmtId="0"><sharedItems containsNumber="1"/></cacheField>` +
  `<cacheField name="Revenue" numFmtId="0"><sharedItems containsNumber="1"/></cacheField>` +
  `</cacheFields></pivotCacheDefinition>`;

const pivotCacheRecords = (records: number, random: () => number): string => {
  const parts: string[] = [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<pivotCacheRecords xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${records}">`,
  ];
  for (let record = 0; record < records; record += 1) {
    parts.push(
      `<r><x v="${record % REGIONS.length}"/><x v="${Math.floor(random() * PRODUCTS.length)}"/>` +
        `<n v="${Math.floor(random() * 500) + 1}"/><n v="${Math.round(random() * 1_000_000) / 100}"/></r>`
    );
  }
  parts.push("</pivotCacheRecords>");
  return parts.join("");
};

const RELS_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Add two pivot caches (definition + records) to a SheetJS-written zip. */
const addPivotCaches = (
  files: Record<string, Uint8Array>,
  recordCounts: readonly number[],
  random: () => number
): void => {
  const workbookPath = "xl/workbook.xml";
  const workbookRelsPath = "xl/_rels/workbook.xml.rels";
  const contentTypesPath = "[Content_Types].xml";
  let workbook = strFromU8(files[workbookPath] ?? new Uint8Array());
  let workbookRels = strFromU8(files[workbookRelsPath] ?? new Uint8Array());
  let contentTypes = strFromU8(files[contentTypesPath] ?? new Uint8Array());

  const cacheRefs: string[] = [];
  recordCounts.forEach((records, offset) => {
    const index = offset + 1;
    const relId = `rIdPivot${index}`;
    files[`xl/pivotCache/pivotCacheDefinition${index}.xml`] = strToU8(
      pivotCacheDefinition(index, records)
    );
    files[`xl/pivotCache/pivotCacheRecords${index}.xml`] = strToU8(
      pivotCacheRecords(records, random)
    );
    files[`xl/pivotCache/_rels/pivotCacheDefinition${index}.xml.rels`] =
      strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="${RELS_NS}/pivotCacheRecords" Target="pivotCacheRecords${index}.xml"/>` +
          `</Relationships>`
      );
    workbookRels = workbookRels.replace(
      "</Relationships>",
      `<Relationship Id="${relId}" Type="${RELS_NS}/pivotCacheDefinition" Target="pivotCache/pivotCacheDefinition${index}.xml"/></Relationships>`
    );
    contentTypes = contentTypes.replace(
      "</Types>",
      `<Override PartName="/xl/pivotCache/pivotCacheDefinition${index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml"/>` +
        `<Override PartName="/xl/pivotCache/pivotCacheRecords${index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml"/></Types>`
    );
    cacheRefs.push(`<pivotCache cacheId="${index}" r:id="${relId}"/>`);
  });

  workbook = workbook.replace(
    "</sheets>",
    `</sheets><pivotCaches>${cacheRefs.join("")}</pivotCaches>`
  );
  files[workbookPath] = strToU8(workbook);
  files[workbookRelsPath] = strToU8(workbookRels);
  files[contentTypesPath] = strToU8(contentTypes);
};

/**
 * Real pivot source sheets are formula- and format-heavy: most of the sheet
 * XML is `<f>` text and style references that never reach converted output.
 */
const addMetricFormulas = (
  worksheet: XLSX.WorkSheet,
  rows: number,
  metricColumns: number
): void => {
  for (let row = 1; row <= rows; row += 1) {
    const excelRow = row + 1;
    for (let metric = 0; metric < metricColumns; metric += 1) {
      const cell = worksheet[
        XLSX.utils.encode_cell({ r: row, c: BASE_COLUMNS + metric })
      ] as XLSX.CellObject | undefined;
      if (!cell) continue;
      cell.f =
        `SUMIFS(Sheet1!$I:$I,Sheet1!$B:$B,$B${excelRow},Sheet1!$C:$C,$C${excelRow})` +
        `*(1+${metric}/100)-IFERROR($J${excelRow}/$G${excelRow},0)` +
        `+IFERROR(INDEX(Sheet1!$K:$K,MATCH($D${excelRow}&$E${excelRow},Sheet1!$D:$D&Sheet1!$E:$E,0)),0)` +
        `*IF($F${excelRow}="Online",VLOOKUP($C${excelRow},Sheet1!$C:$L,10,FALSE),1)`;
      cell.z = "#,##0.00";
    }
  }
};

/** Build the workbook bytes; `scale` shrinks or grows every part. */
export const buildLargeWorkbook = (
  options: LargeWorkbookOptions = {}
): Uint8Array => {
  const scale = options.scale ?? 1;
  const sheetCount = options.sheets ?? 4;
  const backtickEvery = options.backtickEvery ?? DEFAULT_BACKTICK_EVERY;
  const random = createRandom(198);
  const rows = Math.max(
    1,
    Math.round((options.rowsPerSheet ?? FULL_ROWS_PER_SHEET) * scale)
  );
  const metricColumns = options.metricColumns ?? DEFAULT_METRIC_COLUMNS;
  const uniqueStrings = Math.max(10, Math.round(FULL_UNIQUE_STRINGS * scale));

  const workbook = XLSX.utils.book_new();
  for (let sheet = 1; sheet <= sheetCount; sheet += 1) {
    const worksheet = XLSX.utils.aoa_to_sheet(
      buildRows(
        rows,
        uniqueStrings,
        random,
        sheet,
        Math.min(backtickEvery, rows),
        metricColumns
      )
    );
    addMetricFormulas(worksheet, rows, metricColumns);
    XLSX.utils.book_append_sheet(workbook, worksheet, `Sheet${sheet}`);
  }
  const written = XLSX.write(workbook, {
    type: "array",
    bookType: "xlsx",
    bookSST: true,
    compression: false,
  }) as ArrayBuffer;
  const files = unzipSync(new Uint8Array(written));
  addPivotCaches(
    files,
    FULL_PIVOT_RECORDS.map((records) =>
      Math.max(1, Math.round(records * scale))
    ),
    random
  );
  return zipSync(files, { level: 6 });
};

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const out = args.find((arg) => !arg.startsWith("--"));
  const scaleIndex = args.indexOf("--scale");
  const scale = scaleIndex === -1 ? 1 : Number(args[scaleIndex + 1]);
  const rowsIndex = args.indexOf("--rows");
  const rowsPerSheet =
    rowsIndex === -1 ? undefined : Number(args[rowsIndex + 1]);
  const colsIndex = args.indexOf("--metric-columns");
  const metricColumns =
    colsIndex === -1 ? undefined : Number(args[colsIndex + 1]);
  if (!out || !Number.isFinite(scale) || scale <= 0) {
    console.error(
      "usage: bun scripts/generate-large-workbook.ts <out.xlsx> [--scale 1] [--rows N] [--metric-columns N]"
    );
    process.exit(1);
  }
  const bytes = buildLargeWorkbook({ scale, rowsPerSheet, metricColumns });
  await Bun.write(out, bytes);
  const parts = unzipSync(bytes);
  for (const [name, data] of Object.entries(parts)) {
    if (data.length > 256 * 1024) {
      console.log(`${name}\t${(data.length / 1_048_576).toFixed(1)} MB`);
    }
  }
  console.log(`${out}\t${(bytes.length / 1_048_576).toFixed(1)} MB zipped`);
}
