/**
 * Hermetic tests for publish attachment discovery and raster validation.
 */
import { describe, expect, test } from "bun:test";

import { MAX_RASTER_DIMENSION_PX } from "../../src/publish/artifact-assets";
import { discoverImageOccurrences } from "../../src/publish/attachment-discover";
import {
  validateRasterBytesStructural,
  validateRasterDecodable,
} from "../../src/publish/attachment-raster";
import {
  AVIF_1X1,
  bmffBox,
  buildAvif,
  concatBytes,
  GIF_1X1,
  JPEG_1X1,
  PNG_1X1,
  WEBP_1X1,
  writeU32BE,
} from "./helpers/attachment-fixtures";

const pngWithInvalidCompressedData = (): Uint8Array => {
  const bytes = new Uint8Array(PNG_1X1);
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length =
      (((bytes[offset] ?? 0) << 24) |
        ((bytes[offset + 1] ?? 0) << 16) |
        ((bytes[offset + 2] ?? 0) << 8) |
        (bytes[offset + 3] ?? 0)) >>>
      0;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === "IDAT") {
      const dataStart = offset + 8;
      bytes[dataStart] = 0;
      let crc = 0xffffffff;
      for (const value of bytes.subarray(offset + 4, dataStart + length)) {
        crc ^= value;
        for (let bit = 0; bit < 8; bit += 1) {
          crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
      }
      bytes.set(writeU32BE((crc ^ 0xffffffff) >>> 0), dataStart + length);
      return bytes;
    }
    offset += 12 + length;
  }
  throw new Error("PNG fixture has no IDAT chunk");
};

describe("attachment discover parser", () => {
  test("parses angle-bracket, nested parens, escapes, titles, Unicode, Obsidian aliases", () => {
    const markdown = [
      '![plain](dot.png "title")',
      "![spaces](<Pasted image 1.png>)",
      "![nested](dir/(parens)/café.png)",
      "![esc](path\\[with\\].png)",
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
      "path[with].png",
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

  test("skips CommonMark tilde-fenced images without traversal diagnostics", () => {
    const markdown = [
      "intro",
      "~~~md",
      "![secret](../escape/dot.png)",
      "![[../escape/wikilink.png]]",
      "~~~",
      "![ok](real.png)",
    ].join("\n");
    const found = discoverImageOccurrences(markdown);
    expect(found).toHaveLength(1);
    expect(found[0]?.sourceRef).toBe("real.png");
  });

  test("ignores escaped image markers while preserving even-backslash images", () => {
    const markdown = [
      "\\![literal](../private.png)",
      "\\![[literal-private.png]]",
      "\\\\![active](real.png)",
    ].join("\n");
    const found = discoverImageOccurrences(markdown);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      alt: "active",
      kind: "markdown",
      sourceRef: "real.png",
    });
  });

  test("skips Obsidian-looking text in inline link resources only", () => {
    const markdown = [
      '[docs](https://example.com/![[../destination.png]] "![[../title.png]]")',
      "<https://example.com/![[../autolink.png]]>",
      "https://example.com/![[../literal-autolink.png]]",
      "[![[visible.png]]](https://example.com)",
    ].join("\n");

    expect(
      discoverImageOccurrences(markdown).map((item) => item.sourceRef)
    ).toEqual(["visible.png"]);
  });

  test("skips standalone indented code without hiding paragraph continuations", () => {
    const markdown = [
      "    ![code](../private.png)",
      "",
      "paragraph",
      "    ![active](real.png)",
    ].join("\n");
    const found = discoverImageOccurrences(markdown);
    expect(found).toHaveLength(1);
    expect(found[0]?.sourceRef).toBe("real.png");
  });

  test("skips indented code after headings and closed fences", () => {
    const markdown = [
      "# Heading",
      "    ![heading-code](../private.png)",
      "",
      "```md",
      "text",
      "```",
      "    ![fence-code](../private-too.png)",
      "",
      "![active](real.png)",
    ].join("\n");
    expect(
      discoverImageOccurrences(markdown).map((item) => item.sourceRef)
    ).toEqual(["real.png"]);
  });

  test("resolves full, collapsed, and shortcut reference-style images", () => {
    const markdown = [
      "![hero][asset]",
      "![asset][]",
      "![asset]",
      "",
      '[asset]: <images/hero.png> "Hero"',
    ].join("\n");
    expect(
      discoverImageOccurrences(markdown).map((item) => item.sourceRef)
    ).toEqual(["images/hero.png", "images/hero.png", "images/hero.png"]);
  });

  test("resolves reference definitions with continuation-line destinations", () => {
    const markdown = [
      "![hero][asset]",
      "",
      "[asset]:",
      "  images/hero.png",
    ].join("\n");
    expect(discoverImageOccurrences(markdown)).toMatchObject([
      { sourceRef: "images/hero.png" },
    ]);
  });

  test("resolves escaped brackets in reference labels", () => {
    const markdown = "![hero][a\\]b]\n\n[a\\]b]: images/hero.png\n";
    expect(discoverImageOccurrences(markdown)).toMatchObject([
      { sourceRef: "images/hero.png" },
    ]);
  });

  test("skips image-looking content in reference-definition titles", () => {
    const markdown = [
      '[ref]: /url "![same-line](../private.png)"',
      "[continued]: /url",
      '  "![continued-title](../private-too.png)"',
      "",
      "![active](real.png)",
    ].join("\n");
    expect(
      discoverImageOccurrences(markdown).map((item) => item.sourceRef)
    ).toEqual(["real.png"]);
  });

  test("resolves container definitions without letting definitions interrupt paragraphs", () => {
    const markdown = [
      "> [quoted]: quoted.png",
      "![quote][quoted]",
      "",
      "- [listed]: listed.png",
      "![list][listed]",
      "",
      "paragraph",
      "[literal]: ../private.png",
      "",
      "![literal][literal]",
    ].join("\n");
    expect(
      discoverImageOccurrences(markdown).map((item) => item.sourceRef)
    ).toEqual(["quoted.png", "listed.png"]);
  });

  test("skips image-looking Markdown inside raw HTML blocks", () => {
    const markdown = [
      "<script>",
      "![script](../private.png)",
      "</script>",
      "",
      "<pre>",
      "![pre](../private-too.png)",
      "</pre>",
      "",
      "<div>",
      "![div](../private-three.png)",
      "</div>",
      "",
      "<?php",
      "![instruction](../private-four.png)",
      "?>",
      "",
      "<!DOCTYPE html",
      "![declaration](../private-five.png)",
      ">",
      "",
      "<![CDATA[",
      "![cdata](../private-six.png)",
      "]]>",
      "",
      "<custom-element>",
      "![custom](../private-seven.png)",
      "",
      "![active](real.png)",
    ].join("\n");
    expect(
      discoverImageOccurrences(markdown).map((item) => item.sourceRef)
    ).toEqual(["real.png"]);
  });

  test("skips indented code after every thematic-break marker", () => {
    const markdown = [
      "***",
      "    ![asterisk](../private.png)",
      "",
      "_ _ _",
      "    ![underscore](../private-too.png)",
      "",
      "![active](real.png)",
    ].join("\n");
    expect(
      discoverImageOccurrences(markdown).map((item) => item.sourceRef)
    ).toEqual(["real.png"]);
  });

  test("skips multi-backtick spans and container-indented code", () => {
    const markdown = [
      "`` ` ![span](../private.png) ` ``",
      "",
      ">     ![quote](../private-too.png)",
      "",
      "-     ![list](../private-three.png)",
      "",
      "![active](real.png)",
    ].join("\n");
    expect(
      discoverImageOccurrences(markdown).map((item) => item.sourceRef)
    ).toEqual(["real.png"]);
  });

  test("does not cross blank lines while parsing inline image resources", () => {
    const markdown = [
      "![literal](",
      "",
      "../private.png)",
      "![active](real.png)",
    ].join("\n");
    expect(
      discoverImageOccurrences(markdown).map((item) => item.sourceRef)
    ).toEqual(["real.png"]);
  });

  test("does not cross blank lines inside image labels", () => {
    const markdown = [
      "![literal",
      "",
      "](../private.png)",
      "![active](real.png)",
    ].join("\n");
    expect(
      discoverImageOccurrences(markdown).map((item) => item.sourceRef)
    ).toEqual(["real.png"]);
  });

  test("permits nonblank multiline titles and preserves non-punctuation backslashes", () => {
    const markdown = [
      '![multiline](gno-asset: "first',
      'second")',
      "![backslash](foo\\q.png)",
      "![entity](photo&copy;.png)",
    ].join("\n");
    expect(discoverImageOccurrences(markdown)).toMatchObject([
      { sourceRef: "gno-asset:" },
      { sourceRef: "foo\\q.png" },
      { sourceRef: "photo©.png" },
    ]);
  });
});

describe("attachment raster validation", () => {
  test("accepts PNG/JPEG/GIF/WebP/AVIF signatures and dimensions", () => {
    expect(validateRasterBytesStructural(PNG_1X1)).toMatchObject({
      ok: true,
      mediaType: "image/png",
      width: 1,
      height: 1,
    });
    expect(validateRasterBytesStructural(JPEG_1X1)).toMatchObject({
      ok: true,
      mediaType: "image/jpeg",
      width: 1,
      height: 1,
    });
    expect(validateRasterBytesStructural(GIF_1X1)).toMatchObject({
      ok: true,
      mediaType: "image/gif",
      width: 1,
      height: 1,
    });
    expect(validateRasterBytesStructural(WEBP_1X1)).toMatchObject({
      ok: true,
      mediaType: "image/webp",
      width: 1,
      height: 1,
    });
    expect(validateRasterBytesStructural(AVIF_1X1)).toMatchObject({
      ok: true,
      mediaType: "image/avif",
      width: 1,
      height: 1,
    });
  });

  test("finds JPEG dimensions after more than 64 KiB of metadata", () => {
    const appPayload = new Uint8Array(65_533);
    const appSegment = concatBytes(
      Uint8Array.of(0xff, 0xe2, 0xff, 0xff),
      appPayload
    );
    const withLargeMetadata = concatBytes(
      JPEG_1X1.subarray(0, 2),
      appSegment,
      appSegment,
      JPEG_1X1.subarray(2)
    );

    expect(withLargeMetadata.byteLength).toBeGreaterThan(65_536);
    expect(validateRasterBytesStructural(withLargeMetadata)).toMatchObject({
      ok: true,
      mediaType: "image/jpeg",
      width: 1,
      height: 1,
    });
  });

  test("accepts JPEG marker fill bytes before frame metadata", () => {
    const withMarkerFill = concatBytes(
      JPEG_1X1.subarray(0, 2),
      Uint8Array.of(0xff),
      JPEG_1X1.subarray(2)
    );

    expect(validateRasterBytesStructural(withMarkerFill)).toMatchObject({
      ok: true,
      mediaType: "image/jpeg",
      width: 1,
      height: 1,
    });
  });

  test("finds AVIF dimensions after more than 64 KiB of metadata", () => {
    const original = buildAvif(32, 16);
    const ftypSize = 20;
    const withLargeMetadata = concatBytes(
      original.subarray(0, ftypSize),
      bmffBox("free", new Uint8Array(70_000)),
      original.subarray(ftypSize)
    );

    expect(withLargeMetadata.byteLength).toBeGreaterThan(65_536);
    expect(validateRasterBytesStructural(withLargeMetadata)).toMatchObject({
      ok: true,
      mediaType: "image/avif",
      width: 32,
      height: 16,
    });
  });

  test("rejects SVG, truncated headers, and dimension limit violations", () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"/>'
    );
    expect(validateRasterBytesStructural(svg).ok).toBe(false);

    expect(validateRasterBytesStructural(PNG_1X1.subarray(0, 8)).ok).toBe(
      false
    );
    expect(validateRasterBytesStructural(AVIF_1X1.subarray(0, 12)).ok).toBe(
      false
    );
    expect(
      validateRasterBytesStructural(new Uint8Array([0xff, 0xd8, 0xff])).ok
    ).toBe(false);

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
    const bombed = validateRasterBytesStructural(bomb);
    expect(bombed.ok).toBe(false);
    if (!bombed.ok) expect(bombed.code).toBe("ASSET_DIMENSION_INVALID");

    const zeroGif = new Uint8Array(GIF_1X1);
    zeroGif[6] = 0;
    zeroGif[7] = 0;
    const zeroed = validateRasterBytesStructural(zeroGif);
    expect(zeroed.ok).toBe(false);
    if (!zeroed.ok) expect(zeroed.code).toBe("ASSET_DIMENSION_INVALID");
  });

  test("rejects header-only and truncated containers for every raster type", () => {
    const fabricatedPngPrefix = new Uint8Array(24);
    fabricatedPngPrefix.set(PNG_1X1.subarray(0, 24));
    expect(validateRasterBytesStructural(fabricatedPngPrefix)).toMatchObject({
      ok: false,
      code: "ASSET_CORRUPT",
    });

    for (const complete of [PNG_1X1, JPEG_1X1, GIF_1X1, WEBP_1X1, AVIF_1X1]) {
      const truncated = complete.subarray(0, complete.length - 1);
      expect(validateRasterBytesStructural(truncated).ok).toBe(false);
    }

    const vp8xHeaderOnly = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(validateRasterBytesStructural(vp8xHeaderOnly).ok).toBe(false);

    const vp8FrameHeaderOnly = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x20, 0x0a, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x9d,
      0x01, 0x2a, 0x01, 0x00, 0x01, 0x00,
    ]);
    expect(validateRasterBytesStructural(vp8FrameHeaderOnly)).toMatchObject({
      ok: false,
      code: "ASSET_CORRUPT",
    });

    const gifWithInvalidFirstLzwCode = Uint8Array.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
      0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x2c, 0x00, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x01, 0x07, 0x00, 0x3b,
    ]);
    expect(
      validateRasterBytesStructural(gifWithInvalidFirstLzwCode)
    ).toMatchObject({ ok: false, code: "ASSET_CORRUPT" });

    const vp8xWithEmptyAnimationFrame = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x2e, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x41, 0x4e, 0x4d, 0x46, 0x10, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(
      validateRasterBytesStructural(vp8xWithEmptyAnimationFrame)
    ).toMatchObject({
      ok: false,
      code: "ASSET_CORRUPT",
    });
  });

  test("AVIF parser descends meta FullBox nesting and rejects malformed boxes", () => {
    const wide = buildAvif(32, 16);
    expect(validateRasterBytesStructural(wide)).toMatchObject({
      ok: true,
      width: 32,
      height: 16,
    });

    // Truncate inside meta so ispe is incomplete
    const truncated = wide.subarray(0, wide.length - 4);
    expect(validateRasterBytesStructural(truncated).ok).toBe(false);

    // Declared size smaller than header
    const badSize = concatBytes(
      writeU32BE(4),
      new TextEncoder().encode("ftyp"),
      new TextEncoder().encode("avif")
    );
    expect(validateRasterBytesStructural(badSize).ok).toBe(false);
  });

  test("producer decodability rejects invalid compressed pixels and accepts real rasters", async () => {
    const invalidPng = pngWithInvalidCompressedData();
    expect(validateRasterBytesStructural(invalidPng)).toMatchObject({
      ok: false,
      code: "ASSET_CORRUPT",
    });
    const invalidPngResult = await validateRasterDecodable(invalidPng);
    expect(invalidPngResult).toMatchObject({
      ok: false,
      code: "ASSET_CORRUPT",
    });

    const fabricated = buildAvif(1, 1);
    expect(fabricated.byteLength).toBe(77);
    expect(validateRasterBytesStructural(fabricated).ok).toBe(true);
    const fabricatedDecodable = await validateRasterDecodable(fabricated);
    expect(fabricatedDecodable.ok).toBe(false);
    if (!fabricatedDecodable.ok) {
      expect(fabricatedDecodable.code).toBe("ASSET_CORRUPT");
      expect(fabricatedDecodable.message).toContain("image-decodable");
    }

    for (const [bytes, mediaType] of [
      [PNG_1X1, "image/png"],
      [JPEG_1X1, "image/jpeg"],
      [GIF_1X1, "image/gif"],
      [WEBP_1X1, "image/webp"],
      [AVIF_1X1, "image/avif"],
    ] as const) {
      expect(await validateRasterDecodable(bytes)).toMatchObject({
        ok: true,
        mediaType,
        width: 1,
        height: 1,
      });
    }
  });
});
