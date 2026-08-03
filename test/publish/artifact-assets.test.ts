import { describe, expect, test } from "bun:test";
// No Bun path utils — join/basename helpers only exist on node:path.
import { join } from "node:path";

import {
  BUNDLED_RASTER_ASSETS_CAPABILITY,
  MAX_PUBLISH_UPLOAD_BYTES,
  MAX_RASTER_DIMENSION_PX,
  MAX_REQUIRED_CAPABILITY_LENGTH,
  MAX_SOURCE_REF_LENGTH,
  PUBLISH_ASSET_LIFECYCLE_TERMINALS,
  PUBLISH_ASSET_VISIBILITY,
  measureSerializedUploadBytes,
  sha256BytesHex,
  sniffRasterMediaType,
  validatePublishAssetContract,
} from "../../src/publish/artifact-assets";
import {
  encryptedCiphertextCharLengthAllowed,
  MAX_ENCRYPTED_CIPHERTEXT_BASE64_LENGTH,
} from "../../src/publish/artifact-validation";
import {
  assertInvalid,
  assertValid,
  loadSchema,
} from "../spec/schemas/validator";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");
const DIGEST_MANIFEST = "fixture-digests.json";

interface CorpusEntry {
  classification?: string;
  code?: string;
  expect: "accept" | "reject";
  file: string;
  id: string;
  kind: "artifact" | "oversize-meta";
}

interface Corpus {
  capability: string;
  fixtures: CorpusEntry[];
  maxUploadBytes: number;
}

interface FixtureDigests {
  algorithm: string;
  files: Record<string, string>;
}

const loadJson = async (name: string): Promise<unknown> =>
  Bun.file(join(FIXTURES_DIR, name)).json();

const decodeBase64 = (data: string): Uint8Array =>
  Uint8Array.from(atob(data), (char) => char.charCodeAt(0));

const artifactWithPng = (
  bytes: Uint8Array,
  dimensions: { height: number; width: number }
): Record<string, unknown> => {
  const id = sha256BytesHex(bytes);
  return {
    assets: [
      {
        byteLength: bytes.byteLength,
        data: bytes.toBase64(),
        encoding: "base64",
        height: dimensions.height,
        id,
        mediaType: "image/png",
        references: [{ noteSlug: "atlas", sourceRef: "attachments/dot.png" }],
        sha256: id,
        width: dimensions.width,
      },
    ],
    requiredCapabilities: [BUNDLED_RASTER_ASSETS_CAPABILITY],
    spaces: [
      {
        notes: [
          {
            markdown: `![dot](gno-asset:${id})`,
            slug: "atlas",
          },
        ],
      },
    ],
    version: 1,
  };
};

describe("publish artifact asset contract", () => {
  test("freezes visibility, lifecycle, and capability vocabulary", () => {
    expect(BUNDLED_RASTER_ASSETS_CAPABILITY).toBe("bundled-raster-assets@1");
    expect(MAX_PUBLISH_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
    expect(PUBLISH_ASSET_VISIBILITY.public.delivery).toBe(
      "immutable-public-url"
    );
    expect(PUBLISH_ASSET_VISIBILITY["secret-link"].forbids).toContain(
      "presigned-url-as-sole-authorization"
    );
    expect(PUBLISH_ASSET_VISIBILITY.encrypted.assetPlacement).toBe(
      "encrypted-client-payload"
    );
    expect(PUBLISH_ASSET_LIFECYCLE_TERMINALS).toEqual([
      "committed",
      "rolled_back",
      "deleted",
      "orphan_cleaned",
      "idempotent_noop",
    ]);
  });

  test("sniffs supported raster signatures and rejects SVG", () => {
    const png = decodeBase64(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    );
    expect(sniffRasterMediaType(png)).toBe("image/png");
    expect(
      sniffRasterMediaType(
        Uint8Array.from('<svg xmlns="http://www.w3.org/2000/svg"/>', (c) =>
          c.charCodeAt(0)
        )
      )
    ).toBeNull();
  });

  test("sniffs AVIF brands only inside the complete declared ftyp box", () => {
    const encoder = new TextEncoder();
    const u32 = (value: number): Uint8Array =>
      Uint8Array.of(
        (value >>> 24) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff
      );
    const concat = (...parts: Uint8Array[]): Uint8Array => {
      const output = new Uint8Array(
        parts.reduce((total, part) => total + part.length, 0)
      );
      let offset = 0;
      for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
      }
      return output;
    };
    const nonAvifFtyp = concat(
      u32(20),
      encoder.encode("ftypmif1"),
      u32(0),
      encoder.encode("mif1")
    );
    const unrelatedAvifBox = concat(u32(12), encoder.encode("freeavif"));
    expect(
      sniffRasterMediaType(concat(nonAvifFtyp, unrelatedAvifBox))
    ).toBeNull();

    const compatibleBrands = concat(
      ...Array.from({ length: 16 }, () => encoder.encode("mif1")),
      encoder.encode("avif")
    );
    const longFtyp = concat(
      u32(16 + compatibleBrands.length),
      encoder.encode("ftypmif1"),
      u32(0),
      compatibleBrands
    );
    expect(longFtyp.length).toBeGreaterThan(64);
    expect(sniffRasterMediaType(longFtyp)).toBe("image/avif");
  });

  test("never TypeErrors on hostile assets entries; returns diagnostics", async () => {
    const base = (await loadJson("legacy-asset-free-v1.json")) as Record<
      string,
      unknown
    >;
    const hostileAssets = [
      null,
      1,
      "x",
      [null],
      [1],
      ["nope"],
      [[]],
      [{}],
      [{ id: 1 }],
      [{ extra: true }],
      [
        {
          byteLength: 1,
          data: "QQ==",
          encoding: "base64",
          height: 1,
          id: "aa".repeat(32),
          mediaType: "image/png",
          references: [null],
          sha256: "aa".repeat(32),
          width: 1,
        },
      ],
      [
        {
          byteLength: 1,
          data: "QQ==",
          encoding: "base64",
          height: 1,
          id: "aa".repeat(32),
          mediaType: "image/png",
          references: [{ noteSlug: "atlas", sourceRef: "a.png", extra: 1 }],
          sha256: "aa".repeat(32),
          width: 1,
        },
      ],
    ];

    for (const assets of hostileAssets) {
      const artifact = {
        ...base,
        assets,
        requiredCapabilities: [BUNDLED_RASTER_ASSETS_CAPABILITY],
      };
      let result: ReturnType<typeof validatePublishAssetContract> | undefined;
      expect(() => {
        result = validatePublishAssetContract(artifact);
      }).not.toThrow();
      expect(result?.ok).toBe(false);
      if (result && !result.ok) {
        expect(typeof result.diagnostic.code).toBe("string");
        expect(result.diagnostic.message.length).toBeGreaterThan(0);
      }
    }
  });

  test("derives bounded dimensions from raster bytes instead of trusting descriptors", () => {
    const png = decodeBase64(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    );
    const mismatched = validatePublishAssetContract(
      artifactWithPng(png, {
        height: MAX_RASTER_DIMENSION_PX,
        width: MAX_RASTER_DIMENSION_PX,
      })
    );
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) {
      expect(mismatched.diagnostic.code).toBe("ASSET_DIMENSION_INVALID");
      expect(mismatched.diagnostic.message).toContain(
        `declared ${MAX_RASTER_DIMENSION_PX}x${MAX_RASTER_DIMENSION_PX} but bytes are 1x1`
      );
    }

    const oversizedBytes = new Uint8Array(png);
    const oversizedWidth = MAX_RASTER_DIMENSION_PX + 1;
    oversizedBytes[16] = (oversizedWidth >>> 24) & 0xff;
    oversizedBytes[17] = (oversizedWidth >>> 16) & 0xff;
    oversizedBytes[18] = (oversizedWidth >>> 8) & 0xff;
    oversizedBytes[19] = oversizedWidth & 0xff;
    const oversized = validatePublishAssetContract(
      artifactWithPng(oversizedBytes, { height: 1, width: 1 })
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.diagnostic.code).toBe("ASSET_DIMENSION_INVALID");
      expect(oversized.diagnostic.message).toContain(
        `exceed ${MAX_RASTER_DIMENSION_PX}px limit`
      );
    }
  });

  test("rejects malformed suffixes on otherwise valid sentinel prefixes", async () => {
    const artifact = (await loadJson("valid-small-raster-v1.json")) as Record<
      string,
      unknown
    >;
    const spaces = artifact.spaces as Array<{
      notes: Array<{ markdown: string }>;
    }>;
    spaces[0]!.notes[0]!.markdown = spaces[0]!.notes[0]!.markdown.replace(
      ")",
      "%00)"
    );

    const result = validatePublishAssetContract(artifact);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.code).toBe("ASSET_SENTINEL_INVALID");
    }
  });

  test("rejects bare gno-asset: destinations as ASSET_SENTINEL_INVALID", async () => {
    const artifact = (await loadJson("valid-small-raster-v1.json")) as Record<
      string,
      unknown
    >;
    const spaces = artifact.spaces as Array<{
      notes: Array<{ markdown: string }>;
    }>;
    spaces[0]!.notes[0]!.markdown = "![x](gno-asset:)\n";
    // Drop assets so the failure is the bare sentinel, not missing bytes.
    delete artifact.assets;
    delete artifact.requiredCapabilities;

    const result = validatePublishAssetContract(artifact);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.code).toBe("ASSET_SENTINEL_INVALID");
      expect(result.diagnostic.message).toContain("gno-asset:");
    }
  });

  test("validates sentinels used by reference-style images", async () => {
    const artifact = (await loadJson("valid-small-raster-v1.json")) as Record<
      string,
      unknown
    >;
    const spaces = artifact.spaces as Array<{
      notes: Array<{ markdown: string }>;
    }>;
    const original = spaces[0]!.notes[0]!.markdown;
    const destination = /gno-asset:[a-f0-9]{64}/u.exec(original)?.[0];
    expect(destination).toBeDefined();
    spaces[0]!.notes[0]!.markdown = `![dot][asset]\n\n[asset]: ${destination}\n`;
    expect(validatePublishAssetContract(artifact).ok).toBe(true);

    spaces[0]!.notes[0]!.markdown = "![dot][asset]\n\n[asset]: gno-asset:\n";
    const invalid = validatePublishAssetContract(artifact);
    expect(invalid).toMatchObject({
      ok: false,
      diagnostic: { code: "ASSET_SENTINEL_INVALID" },
    });

    spaces[0]!.notes[0]!.markdown = "![dot][asset]\n\n[asset]:\n  gno-asset:\n";
    expect(validatePublishAssetContract(artifact)).toMatchObject({
      ok: false,
      diagnostic: { code: "ASSET_SENTINEL_INVALID" },
    });

    spaces[0]!.notes[0]!.markdown = "![dot][a\\]b]\n\n[a\\]b]: gno-asset:\n";
    expect(validatePublishAssetContract(artifact)).toMatchObject({
      ok: false,
      diagnostic: { code: "ASSET_SENTINEL_INVALID" },
    });

    spaces[0]!.notes[0]!.markdown = "> [asset]: gno-asset:\n\n![dot][asset]\n";
    expect(validatePublishAssetContract(artifact)).toMatchObject({
      ok: false,
      diagnostic: { code: "ASSET_SENTINEL_INVALID" },
    });
  });

  test("does not treat arbitrary artifact thematic breaks as frontmatter", async () => {
    const artifact = (await loadJson("legacy-asset-free-v1.json")) as Record<
      string,
      unknown
    >;
    const spaces = artifact.spaces as Array<{
      notes: Array<{ markdown: string }>;
    }>;
    spaces[0]!.notes[0]!.markdown = "---\n[a]: gno-asset:\n---\n\n![x][a]\n";
    expect(validatePublishAssetContract(artifact)).toMatchObject({
      ok: false,
      diagnostic: { code: "ASSET_SENTINEL_INVALID" },
    });
  });

  test("decodes Markdown character references before sentinel validation", async () => {
    const artifact = (await loadJson("legacy-asset-free-v1.json")) as Record<
      string,
      unknown
    >;
    const spaces = artifact.spaces as Array<{
      notes: Array<{ markdown: string }>;
    }>;
    for (const destination of [
      "gno&#45;asset:",
      "gno-asset&#58;",
      "gno-asset&colon;",
    ]) {
      spaces[0]!.notes[0]!.markdown = `![x](${destination})`;
      expect(validatePublishAssetContract(artifact)).toMatchObject({
        ok: false,
        diagnostic: { code: "ASSET_SENTINEL_INVALID" },
      });
    }
    spaces[0]!.notes[0]!.markdown = "![x](gno&amp;#45;asset:)";
    expect(validatePublishAssetContract(artifact).ok).toBe(true);

    spaces[0]!.notes[0]!.markdown = '![x](gno-asset: "first\nsecond")';
    expect(validatePublishAssetContract(artifact)).toMatchObject({
      ok: false,
      diagnostic: { code: "ASSET_SENTINEL_INVALID" },
    });
  });

  test("ignores gno-asset text outside renderable image destinations", async () => {
    const artifact = (await loadJson("valid-small-raster-v1.json")) as Record<
      string,
      unknown
    >;
    const spaces = artifact.spaces as Array<{
      notes: Array<{ markdown: string }>;
    }>;
    spaces[0]!.notes[0]!.markdown += [
      "",
      "Literal gno-asset: mention.",
      "[link](gno-asset:)",
      "`![inline](gno-asset:)`",
      "```text",
      "![fenced](gno-asset:)",
      "```",
      "\\![escaped](gno-asset:)",
      "![external](https://example.test/gno-asset:bad)",
      "<!-- ![commented](gno-asset:) -->",
    ].join("\n");

    expect(validatePublishAssetContract(artifact).ok).toBe(true);
  });

  test("retains sentinel ownership across duplicate artifact note slugs", async () => {
    const artifact = (await loadJson("valid-small-raster-v1.json")) as Record<
      string,
      unknown
    >;
    const spaces = artifact.spaces as Array<{
      notes: Array<{ markdown: string; slug: string }>;
    }>;
    spaces[0]!.notes.push({ markdown: "No image here", slug: "atlas" });

    expect(validatePublishAssetContract(artifact)).toMatchObject({
      ok: true,
      classification: "bundled-raster-v1",
    });
  });

  test("enforces sourceRef 1..1024 before traversal normalization", async () => {
    const artifact = (await loadJson("valid-small-raster-v1.json")) as Record<
      string,
      unknown
    >;
    const assets = artifact.assets as Array<{
      references: Array<{ noteSlug: string; sourceRef: string }>;
    }>;
    const accepted = `${"a".repeat(MAX_SOURCE_REF_LENGTH - 4)}.png`;
    expect(accepted.length).toBe(MAX_SOURCE_REF_LENGTH);
    assets[0]!.references[0]!.sourceRef = accepted;
    expect(validatePublishAssetContract(artifact).ok).toBe(true);

    assets[0]!.references[0]!.sourceRef = `${accepted}x`;
    expect(assets[0]!.references[0]!.sourceRef.length).toBe(
      MAX_SOURCE_REF_LENGTH + 1
    );
    const rejected = validatePublishAssetContract(artifact);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.diagnostic.code).toBe("ASSET_CORRUPT");
      expect(rejected.diagnostic.message).toContain(
        `1..${MAX_SOURCE_REF_LENGTH} characters`
      );
    }

    const unicodeAccepted = `${"a".repeat(MAX_SOURCE_REF_LENGTH - 1)}😀`;
    assets[0]!.references[0]!.sourceRef = unicodeAccepted;
    expect(Array.from(unicodeAccepted)).toHaveLength(MAX_SOURCE_REF_LENGTH);
    expect(validatePublishAssetContract(artifact).ok).toBe(true);
  });

  test("aligns encrypted ciphertext char budget to the 100 MiB envelope", async () => {
    const staleCeiling = 67_108_864;
    expect(MAX_ENCRYPTED_CIPHERTEXT_BASE64_LENGTH).toBe(
      MAX_PUBLISH_UPLOAD_BYTES
    );
    expect(MAX_ENCRYPTED_CIPHERTEXT_BASE64_LENGTH).toBeGreaterThan(
      staleCeiling
    );
    // Formerly rejected length is now within the ciphertext field budget.
    expect(encryptedCiphertextCharLengthAllowed(staleCeiling + 1)).toBe(true);
    expect(encryptedCiphertextCharLengthAllowed(MAX_PUBLISH_UPLOAD_BYTES)).toBe(
      true
    );
    expect(
      encryptedCiphertextCharLengthAllowed(MAX_PUBLISH_UPLOAD_BYTES + 1)
    ).toBe(false);
    // Exact final serialized measurement remains the authoritative oversize gate.
    const artifact = await loadJson("valid-encrypted-v2.json");
    const oversize = validatePublishAssetContract(artifact, {
      serializedUploadBytes: MAX_PUBLISH_UPLOAD_BYTES + 1,
    });
    expect(oversize.ok).toBe(false);
    if (!oversize.ok) {
      expect(oversize.diagnostic.code).toBe("ENVELOPE_OVERSIZE");
    }
  });

  test("rejects descriptors that have references but no sentinel owner", async () => {
    const artifact = (await loadJson("valid-small-raster-v1.json")) as Record<
      string,
      unknown
    >;
    const spaces = artifact.spaces as Array<{
      notes: Array<{ markdown: string }>;
    }>;
    spaces[0]!.notes[0]!.markdown = "No image here";

    const result = validatePublishAssetContract(artifact);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.code).toBe("ASSET_MISSING");
      expect(result.diagnostic.message).toContain(
        "no matching gno-asset sentinel"
      );
    }
  });

  test("rejects duplicate, empty, and overlong requiredCapabilities deterministically", async () => {
    const base = (await loadJson("legacy-asset-free-v1.json")) as Record<
      string,
      unknown
    >;

    const duplicate = validatePublishAssetContract({
      ...base,
      requiredCapabilities: [
        BUNDLED_RASTER_ASSETS_CAPABILITY,
        BUNDLED_RASTER_ASSETS_CAPABILITY,
      ],
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.diagnostic.code).toBe("CAPABILITY_UNSUPPORTED");
      expect(duplicate.diagnostic.message).toBe(
        `requiredCapabilities duplicates capability "${BUNDLED_RASTER_ASSETS_CAPABILITY}"`
      );
    }

    const empty = validatePublishAssetContract({
      ...base,
      requiredCapabilities: [""],
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.diagnostic.code).toBe("CAPABILITY_UNSUPPORTED");
      expect(empty.diagnostic.message).toBe(
        `requiredCapabilities entries must be non-empty strings of at most ${MAX_REQUIRED_CAPABILITY_LENGTH} characters`
      );
    }

    const overlong = validatePublishAssetContract({
      ...base,
      requiredCapabilities: ["x".repeat(MAX_REQUIRED_CAPABILITY_LENGTH + 1)],
    });
    expect(overlong.ok).toBe(false);
    if (!overlong.ok) {
      expect(overlong.diagnostic.code).toBe("CAPABILITY_UNSUPPORTED");
      expect(overlong.diagnostic.message).toBe(
        `requiredCapabilities entries must be non-empty strings of at most ${MAX_REQUIRED_CAPABILITY_LENGTH} characters`
      );
    }
  });

  test("validates the shared cross-repo fixture corpus", async () => {
    const schema = await loadSchema("publish-artifact");
    const corpus = (await loadJson("corpus.json")) as Corpus;
    expect(corpus.capability).toBe(BUNDLED_RASTER_ASSETS_CAPABILITY);
    expect(corpus.maxUploadBytes).toBe(MAX_PUBLISH_UPLOAD_BYTES);

    for (const entry of corpus.fixtures) {
      if (entry.kind === "oversize-meta") {
        const meta = (await loadJson(entry.file)) as {
          artifact: unknown;
          forcedSerializedBytes: number;
        };
        const result = validatePublishAssetContract(meta.artifact, {
          serializedUploadBytes: meta.forcedSerializedBytes,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.diagnostic.code === entry.code).toBe(true);
        }
        continue;
      }

      const artifact = await loadJson(entry.file);
      const result = validatePublishAssetContract(artifact);

      if (entry.expect === "accept") {
        expect(result.ok, entry.id).toBe(true);
        if (result.ok && entry.classification) {
          expect(result.classification === entry.classification).toBe(true);
        }
        if (
          entry.id === "legacy-asset-free-v1" ||
          entry.id === "valid-small-raster-v1"
        ) {
          expect(assertValid(artifact, schema)).toBe(true);
        }
        if (entry.id === "valid-encrypted-v2") {
          expect(assertValid(artifact, schema)).toBe(true);
          if (result.ok) {
            expect(result.classification).toBe("encrypted-client-payload");
          }
        }
      } else {
        expect(result.ok, entry.id).toBe(false);
        if (!result.ok) {
          expect(result.diagnostic.code === entry.code).toBe(true);
        }
        if (entry.id === "unsupported-svg") {
          expect(assertInvalid(artifact, schema)).toBe(true);
        }
      }
    }
  });

  test("verifies local fixture inventory and bytes against fixture-digests.json", async () => {
    const corpus = (await loadJson("corpus.json")) as Corpus;
    const manifest = (await loadJson(DIGEST_MANIFEST)) as FixtureDigests;
    expect(manifest.algorithm).toBe("sha256");
    const expectedNames = [
      "corpus.json",
      ...corpus.fixtures.map((entry) => entry.file),
    ].sort();
    expect(Object.keys(manifest.files).sort()).toEqual(expectedNames);
    expect(Object.hasOwn(manifest.files, DIGEST_MANIFEST)).toBe(false);

    for (const name of expectedNames) {
      const bytes = new Uint8Array(
        await Bun.file(join(FIXTURES_DIR, name)).arrayBuffer()
      );
      expect(sha256BytesHex(bytes), name).toBe(manifest.files[name]!);
    }
  });

  test("accounts exact final serialized UTF-8 bytes under the 100 MiB cap", async () => {
    const artifact = await loadJson("valid-small-raster-v1.json");
    const serialized = `${JSON.stringify(artifact)}\n`;
    const bytes = measureSerializedUploadBytes(serialized);
    expect(bytes).toBe(new TextEncoder().encode(serialized).byteLength);
    expect(bytes).toBeLessThanOrEqual(MAX_PUBLISH_UPLOAD_BYTES);
    expect(
      validatePublishAssetContract(artifact, {
        serializedUploadBytes: MAX_PUBLISH_UPLOAD_BYTES + 1,
      }).ok
    ).toBe(false);
  });
});
