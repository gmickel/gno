#!/usr/bin/env bun

/**
 * Generate a pivot-report-shaped Excel workbook on the fly (fn-198).
 *
 * Mirrors the structure of the workbook that 2.8.1 and 2.8.2 could not
 * index (read from its zip parts, no contents): one data sheet of 23
 * columns x 40,439 rows (about 930k cells, ~37 MB of sheet XML) backed by a
 * shared-strings table of ~29k unique strings referenced ~770k times, three
 * smaller sheets (A1:W6, A3:AM427, A3:AK152), and two pivot caches whose
 * record parts are ~16 MB and ~15 MB of XML with a ~1 MB cache definition.
 * A few cells carry a backtick (a typo for an apostrophe).
 *
 * Nothing is committed: tests import `buildLargeWorkbook` at a small scale.
 *
 * Run: bun scripts/generate-large-workbook.ts <out.xlsx> [--scale 1]
 *   --scale shrinks or grows the data sheet rows, the unique strings and
 *   the pivot caches together; 1 is the reported workbook.
 */

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import * as XLSX from "xlsx";

export interface LargeWorkbookOptions {
  /** Size multiplier; 1 matches the reported production workbook. */
  scale?: number;
  /** Data rows between cells carrying a backtick; 0 disables them. */
  backtickEvery?: number;
}

const DATA_ROWS = 40_439;
const DATA_COLUMNS = 23;
/** Of the 23 data columns, these hold numbers; the rest shared strings. */
const NUMERIC_COLUMNS = new Set([15, 16, 17, 18]);
const UNIQUE_STRINGS = 29_174;
const PIVOT_RECORDS = [296_000, 265_000] as const;
const PIVOT_SHARED_ITEMS = 38_000;
const DEFAULT_BACKTICK_EVERY = 5000;

/** Small report sheets as [name, origin, rows, columns]. */
const REPORT_SHEETS = [
  ["Summary", "A1", 6, 23],
  ["Pivot by region", "A3", 425, 39],
  ["Pivot by product", "A3", 150, 37],
] as const;

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

/** A pool of distinct business-looking strings. */
const stringPool = (size: number): string[] =>
  Array.from({ length: size }, (_, index) => {
    const region = REGIONS[index % REGIONS.length];
    const product = PRODUCTS[index % PRODUCTS.length];
    return `${region} ${product} account ${index.toString(36).toUpperCase()}`;
  });

const dataSheet = (
  rows: number,
  pool: string[],
  random: () => number,
  backtickEvery: number
): XLSX.WorkSheet => {
  const header = Array.from(
    { length: DATA_COLUMNS },
    (_, col) => `Field ${col + 1}`
  );
  const data: (string | number)[][] = [header];
  for (let row = 1; row <= rows; row += 1) {
    const values: (string | number)[] = [];
    for (let col = 0; col < DATA_COLUMNS; col += 1) {
      if (NUMERIC_COLUMNS.has(col)) {
        values.push(Math.round(random() * 1_000_000) / 100);
      } else if (backtickEvery > 0 && col === 22 && row % backtickEvery === 0) {
        values.push(`customer didn\`t confirm ${row}`);
      } else {
        // Skewed reuse, as in real category-like columns.
        const pick = Math.floor(random() ** 2 * pool.length);
        values.push(pool[pick] ?? "");
      }
    }
    data.push(values);
  }
  return XLSX.utils.aoa_to_sheet(data);
};

const reportSheet = (
  origin: string,
  rows: number,
  columns: number,
  random: () => number
): XLSX.WorkSheet => {
  const data: (string | number)[][] = [];
  for (let row = 0; row < rows; row += 1) {
    data.push(
      Array.from({ length: columns }, (_, col) =>
        col === 0
          ? `${REGIONS[row % REGIONS.length]} ${row}`
          : Math.round(random() * 100_000) / 100
      )
    );
  }
  const sheet: XLSX.WorkSheet = {};
  XLSX.utils.sheet_add_aoa(sheet, data, { origin });
  // Report sheets start below a title area, as in the reported workbook.
  const start = XLSX.utils.decode_cell(origin);
  sheet["!ref"] = XLSX.utils.encode_range({
    s: start,
    e: { r: start.r + rows - 1, c: start.c + columns - 1 },
  });
  return sheet;
};

const RELS_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const pivotCacheDefinition = (records: number, sharedItems: number): string => {
  const items = Array.from(
    { length: sharedItems },
    (_, index) => `<s v="Customer ${index} ${PRODUCTS[index % 6]}"/>`
  ).join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="${RELS_NS}" r:id="rId1" refreshOnLoad="1" recordCount="${records}">` +
    `<cacheSource type="worksheet"><worksheetSource ref="A1:W${records + 1}" sheet="Data"/></cacheSource>` +
    `<cacheFields count="4">` +
    `<cacheField name="Customer" numFmtId="0"><sharedItems count="${sharedItems}">${items}</sharedItems></cacheField>` +
    `<cacheField name="Region" numFmtId="0"><sharedItems count="${REGIONS.length}">${REGIONS.map((r) => `<s v="${r}"/>`).join("")}</sharedItems></cacheField>` +
    `<cacheField name="Quantity" numFmtId="0"><sharedItems containsNumber="1"/></cacheField>` +
    `<cacheField name="Revenue" numFmtId="0"><sharedItems containsNumber="1"/></cacheField>` +
    `</cacheFields></pivotCacheDefinition>`
  );
};

const pivotCacheRecords = (
  records: number,
  sharedItems: number,
  random: () => number
): string => {
  const parts: string[] = [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<pivotCacheRecords xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${records}">`,
  ];
  for (let record = 0; record < records; record += 1) {
    parts.push(
      `<r><x v="${Math.floor(random() * sharedItems)}"/><x v="${record % REGIONS.length}"/>` +
        `<n v="${Math.floor(random() * 500) + 1}"/><n v="${Math.round(random() * 1_000_000) / 100}"/></r>`
    );
  }
  parts.push("</pivotCacheRecords>");
  return parts.join("");
};

/** Add pivot caches (definition + records) to a SheetJS-written zip. */
const addPivotCaches = (
  files: Record<string, Uint8Array>,
  recordCounts: readonly number[],
  sharedItems: number,
  random: () => number
): void => {
  let workbook = strFromU8(files["xl/workbook.xml"] ?? new Uint8Array());
  let workbookRels = strFromU8(
    files["xl/_rels/workbook.xml.rels"] ?? new Uint8Array()
  );
  let contentTypes = strFromU8(
    files["[Content_Types].xml"] ?? new Uint8Array()
  );
  const cacheRefs: string[] = [];
  recordCounts.forEach((records, offset) => {
    const index = offset + 1;
    const relId = `rIdPivot${index}`;
    files[`xl/pivotCache/pivotCacheDefinition${index}.xml`] = strToU8(
      pivotCacheDefinition(records, sharedItems)
    );
    files[`xl/pivotCache/pivotCacheRecords${index}.xml`] = strToU8(
      pivotCacheRecords(records, sharedItems, random)
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
  files["xl/workbook.xml"] = strToU8(workbook);
  files["xl/_rels/workbook.xml.rels"] = strToU8(workbookRels);
  files["[Content_Types].xml"] = strToU8(contentTypes);
};

/** Build the workbook bytes; `scale` shrinks or grows the large parts. */
export const buildLargeWorkbook = (
  options: LargeWorkbookOptions = {}
): Uint8Array => {
  const scale = options.scale ?? 1;
  const backtickEvery = options.backtickEvery ?? DEFAULT_BACKTICK_EVERY;
  const random = createRandom(198);
  const rows = Math.max(1, Math.round(DATA_ROWS * scale));
  const pool = stringPool(Math.max(10, Math.round(UNIQUE_STRINGS * scale)));

  const workbook = XLSX.utils.book_new();
  for (const [name, origin, sheetRows, columns] of REPORT_SHEETS) {
    XLSX.utils.book_append_sheet(
      workbook,
      reportSheet(origin, sheetRows, columns, random),
      name
    );
  }
  XLSX.utils.book_append_sheet(
    workbook,
    dataSheet(rows, pool, random, Math.min(backtickEvery, rows)),
    "Data"
  );
  const written = XLSX.write(workbook, {
    type: "array",
    bookType: "xlsx",
    bookSST: true,
    compression: false,
  }) as ArrayBuffer;
  const files = unzipSync(new Uint8Array(written));
  addPivotCaches(
    files,
    PIVOT_RECORDS.map((records) => Math.max(1, Math.round(records * scale))),
    Math.max(10, Math.round(PIVOT_SHARED_ITEMS * scale)),
    random
  );
  return zipSync(files, { level: 6 });
};

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const out = args.find((arg) => !arg.startsWith("--"));
  const scaleIndex = args.indexOf("--scale");
  const scale = scaleIndex === -1 ? 1 : Number(args[scaleIndex + 1]);
  if (!out || !Number.isFinite(scale) || scale <= 0) {
    console.error(
      "usage: bun scripts/generate-large-workbook.ts <out.xlsx> [--scale 1]"
    );
    process.exit(1);
  }
  const bytes = buildLargeWorkbook({ scale });
  await Bun.write(out, bytes);
  const parts = unzipSync(bytes);
  for (const [name, data] of Object.entries(parts)) {
    if (data.length > 256 * 1024) {
      console.log(`${name}\t${(data.length / 1_048_576).toFixed(1)} MB`);
    }
  }
  const sst = strFromU8(parts["xl/sharedStrings.xml"] ?? new Uint8Array());
  console.log(
    `sharedStrings ${sst.match(/count="\d+" uniqueCount="\d+"/)?.[0] ?? ""}`
  );
  console.log(`${out}\t${(bytes.length / 1_048_576).toFixed(1)} MB zipped`);
}
