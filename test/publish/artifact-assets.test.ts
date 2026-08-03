import { describe, expect, test } from "bun:test";
// No Bun path utils — join/basename helpers only exist on node:path.
import { join } from "node:path";

import {
  BUNDLED_RASTER_ASSETS_CAPABILITY,
  MAX_PUBLISH_UPLOAD_BYTES,
  MAX_REQUIRED_CAPABILITY_LENGTH,
  PUBLISH_ASSET_LIFECYCLE_TERMINALS,
  PUBLISH_ASSET_VISIBILITY,
  measureSerializedUploadBytes,
  sha256BytesHex,
  sniffRasterMediaType,
  validatePublishAssetContract,
} from "../../src/publish/artifact-assets";
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
