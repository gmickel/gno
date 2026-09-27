/**
 * Direct xlsx converter (fn-198): same Markdown as markitdown-ts, linear in
 * cells.
 */

import { describe, expect, test } from "bun:test";

import type { ConvertInput } from "../../src/converters/types";

import { buildLargeWorkbook } from "../../scripts/generate-large-workbook";
import { markitdownAdapter } from "../../src/converters/adapters/markitdownTs/adapter";
import { xlsxAdapter } from "../../src/converters/adapters/xlsx/adapter";
import { createDefaultRegistry } from "../../src/converters/registry";
import { buildEdgeCaseWorkbook } from "../fixtures/conversion/xlsx-edge-cases";

const input = (bytes: Uint8Array): ConvertInput => ({
  sourcePath: "/fixture/book.xlsx",
  relativePath: "book.xlsx",
  collection: "fixtures",
  bytes,
  mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ext: ".xlsx",
  limits: { maxBytes: 100 * 1024 * 1024, timeoutMs: 60_000 },
});

describe("xlsx adapter (fn-198)", () => {
  test.each([
    { label: "edge cases", build: buildEdgeCaseWorkbook },
    {
      label: "pivot-report shape",
      build: () => buildLargeWorkbook({ scale: 0.005, backtickEvery: 20 }),
    },
  ])(
    "$label: Markdown and title match markitdown-ts",
    async ({ build }) => {
      const bytes = build();

      const [before, after] = await Promise.all([
        markitdownAdapter.convert(input(bytes)),
        xlsxAdapter.convert(input(bytes)),
      ]);

      if (!before.ok || !after.ok) throw new Error("conversion failed");
      expect(after.value.markdown).toBe(before.value.markdown);
      expect(after.value.title).toBe(before.value.title);
      expect(after.value.meta.converterId).toBe("adapter/xlsx");
    },
    // The markitdown-ts reference is the old quadratic path; it took 6.1 s on
    // a macOS CI runner.
    30_000
  );

  test("converts a 4,000-row, 23-column sheet in well under the old runtime", async () => {
    // markitdown-ts took 15.7 s and 5.5 GB here (columns x rows^2 in the GFM
    // plugin); the direct path is linear in cells.
    const bytes = buildLargeWorkbook({ scale: 0.1 });

    const registry = await createDefaultRegistry();
    const started = performance.now();
    const result = await registry.convert(input(bytes));
    const elapsedMs = performance.now() - started;

    expect(result.ok).toBe(true);
    expect(elapsedMs).toBeLessThan(5000);
  }, 30_000);

  test("an unreadable workbook is CORRUPT", async () => {
    const result = await xlsxAdapter.convert(
      input(new TextEncoder().encode("PK\u0003\u0004 not a zip"))
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CORRUPT");
  });
});
