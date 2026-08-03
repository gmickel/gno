/**
 * Hermetic tests for publish attachment discovery and raster validation.
 */
import { describe, expect, test } from "bun:test";

import { MAX_RASTER_DIMENSION_PX } from "../../src/publish/artifact-assets";
import { discoverImageOccurrences } from "../../src/publish/attachment-discover";
import { validateRasterBytes } from "../../src/publish/attachment-raster";
import {
  AVIF_1X1,
  buildAvif,
  concatBytes,
  GIF_1X1,
  JPEG_1X1,
  PNG_1X1,
  WEBP_1X1,
  writeU32BE,
} from "./helpers/attachment-fixtures";

describe("attachment discover parser", () => {
  test("parses angle-bracket, nested parens, escapes, titles, Unicode, Obsidian aliases", () => {
    const markdown = [
      '![plain](dot.png "title")',
      "![spaces](<Pasted image 1.png>)",
      "![nested](dir/(parens)/café.png)",
      "![esc](path\\ with\\ space.png)",
      "![titled](a.png 'single')",
      "![paren-title](b.png (caption))",
      "![[Pasted image 1.png|hero]]",
      "![[café (1).png#frag|alias]]",
    ].join("\n");

    const found = discoverImageOccurrences(markdown);
    expect(found.map((f) => f.sourceRef)).toEqual([
      "dot.png",
      "Pasted image 1.png",
      "dir/(parens)/café.png",
      "path with space.png",
      "a.png",
      "b.png",
      "Pasted image 1.png",
      "café (1).png",
    ]);
    expect(found[0]?.alt).toBe("plain");
    expect(found[6]?.alt).toBe("hero");
    expect(found[7]?.alt).toBe("alias");
    expect(found[6]?.kind).toBe("obsidian");
  });

  test("skips frontmatter and code ranges; leaves non-image text discoverable only", () => {
    const markdown = [
      "---",
      "cover: '![[secret.png]]'",
      "---",
      "",
      "hello",
      "```",
      "![[code.png]]",
      "```",
      "`![[inline.png]]`",
      "![ok](real.png)",
    ].join("\n");
    const found = discoverImageOccurrences(markdown);
    expect(found).toHaveLength(1);
    expect(found[0]?.sourceRef).toBe("real.png");
  });
});

describe("attachment raster validation", () => {
  test("accepts PNG/JPEG/GIF/WebP/AVIF signatures and dimensions", () => {
    expect(validateRasterBytes(PNG_1X1)).toMatchObject({
      ok: true,
      mediaType: "image/png",
      width: 1,
      height: 1,
    });
    expect(validateRasterBytes(JPEG_1X1)).toMatchObject({
      ok: true,
      mediaType: "image/jpeg",
      width: 1,
      height: 1,
    });
    expect(validateRasterBytes(GIF_1X1)).toMatchObject({
      ok: true,
      mediaType: "image/gif",
      width: 1,
      height: 1,
    });
    expect(validateRasterBytes(WEBP_1X1)).toMatchObject({
      ok: true,
      mediaType: "image/webp",
      width: 1,
      height: 1,
    });
    expect(validateRasterBytes(AVIF_1X1)).toMatchObject({
      ok: true,
      mediaType: "image/avif",
      width: 1,
      height: 1,
    });
  });

  test("rejects SVG, truncated headers, and dimension limit violations", () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"/>'
    );
    expect(validateRasterBytes(svg).ok).toBe(false);

    expect(validateRasterBytes(PNG_1X1.subarray(0, 8)).ok).toBe(false);
    expect(validateRasterBytes(AVIF_1X1.subarray(0, 12)).ok).toBe(false);
    expect(validateRasterBytes(new Uint8Array([0xff, 0xd8, 0xff])).ok).toBe(
      false
    );

    const bomb = new Uint8Array(PNG_1X1);
    // IHDR width/height at offsets 16/20 — set above MAX_RASTER_DIMENSION_PX
    const over = MAX_RASTER_DIMENSION_PX + 1;
    bomb[16] = (over >>> 24) & 0xff;
    bomb[17] = (over >>> 16) & 0xff;
    bomb[18] = (over >>> 8) & 0xff;
    bomb[19] = over & 0xff;
    bomb[20] = bomb[16];
    bomb[21] = bomb[17];
    bomb[22] = bomb[18];
    bomb[23] = bomb[19];
    const bombed = validateRasterBytes(bomb);
    expect(bombed.ok).toBe(false);
    if (!bombed.ok) expect(bombed.code).toBe("ASSET_DIMENSION_INVALID");

    const zeroGif = new Uint8Array(GIF_1X1);
    zeroGif[6] = 0;
    zeroGif[7] = 0;
    const zeroed = validateRasterBytes(zeroGif);
    expect(zeroed.ok).toBe(false);
    if (!zeroed.ok) expect(zeroed.code).toBe("ASSET_DIMENSION_INVALID");
  });

  test("rejects header-only and truncated containers for every raster type", () => {
    const fabricatedPngPrefix = new Uint8Array(24);
    fabricatedPngPrefix.set(PNG_1X1.subarray(0, 24));
    expect(validateRasterBytes(fabricatedPngPrefix)).toMatchObject({
      ok: false,
      code: "ASSET_CORRUPT",
    });

    for (const complete of [PNG_1X1, JPEG_1X1, GIF_1X1, WEBP_1X1, AVIF_1X1]) {
      const truncated = complete.subarray(0, complete.length - 1);
      expect(validateRasterBytes(truncated).ok).toBe(false);
    }

    const vp8xHeaderOnly = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(validateRasterBytes(vp8xHeaderOnly).ok).toBe(false);
  });

  test("AVIF parser descends meta FullBox nesting and rejects malformed boxes", () => {
    const wide = buildAvif(32, 16);
    expect(validateRasterBytes(wide)).toMatchObject({
      ok: true,
      width: 32,
      height: 16,
    });

    // Truncate inside meta so ispe is incomplete
    const truncated = wide.subarray(0, wide.length - 4);
    expect(validateRasterBytes(truncated).ok).toBe(false);

    // Declared size smaller than header
    const badSize = concatBytes(
      writeU32BE(4),
      new TextEncoder().encode("ftyp"),
      new TextEncoder().encode("avif")
    );
    expect(validateRasterBytes(badSize).ok).toBe(false);
  });
});
