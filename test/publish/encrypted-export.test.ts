/**
 * Encrypted publish export: asset-free compatibility, asset-bearing decrypt,
 * tamper rejection, and outer ciphertext-only guarantees.
 */
import { describe, expect, test } from "bun:test";

import {
  BUNDLED_RASTER_ASSETS_CAPABILITY,
  buildEncryptedPublishArtifact,
  measureArtifactUploadBytes,
  serializePublishArtifact,
  validatePublishAssetContract,
} from "../../src/publish/artifact";
import { encodeBytesToBase64 } from "../../src/publish/artifact-asset-codec";
import {
  buildEncryptedArtifactPayload,
  decryptEncryptedArtifactPayload,
  type EncryptedReaderSpaceData,
} from "../../src/publish/encrypted-export";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const PNG_1X1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  ),
  (c) => c.charCodeAt(0)
);

const PNG_SHA256 =
  "c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77";

const PNG_ASSET = {
  byteLength: PNG_1X1.byteLength,
  data: encodeBytesToBase64(PNG_1X1),
  encoding: "base64" as const,
  height: 1,
  id: PNG_SHA256,
  mediaType: "image/png",
  references: [{ noteSlug: "atlas", sourceRef: "dot.png" }],
  sha256: PNG_SHA256,
  width: 1,
};

const PASSPHRASE = "correct horse battery staple";

async function expectDecryptRejects(
  passphrase: string,
  payload: Parameters<typeof decryptEncryptedArtifactPayload>[1]
): Promise<void> {
  try {
    await decryptEncryptedArtifactPayload(passphrase, payload);
    expect.unreachable("expected decrypt to reject");
  } catch {
    // expected integrity / passphrase failure
  }
}

function expectContractClassification(
  artifact: unknown,
  classification: "asset-free" | "encrypted-client-payload"
): void {
  const contract = validatePublishAssetContract(artifact);
  expect(contract.ok).toBe(true);
  if (!contract.ok) {
    throw new Error(`expected contract ok, got ${contract.diagnostic.code}`);
  }
  expect(contract.classification).toBe(classification);
}

describe("encrypted-export asset payload", () => {
  test("asset-free v2 remains ciphertext-only and decrypts without assets", async () => {
    const markdown = "# Plain\n\nNo images here.\n";
    const built = await buildEncryptedArtifactPayload({
      exportedAt: "2026-08-03T12:00:00.000Z",
      notes: [
        {
          markdown,
          slug: "plain",
          summary: "Plain note.",
          title: "Plain",
        },
      ],
      passphrase: PASSPHRASE,
      routeSlug: "plain",
      sourceType: "note",
      summary: "Plain note.",
      title: "Plain",
    });

    const artifact = buildEncryptedPublishArtifact({
      encryptedPayload: built.encryptedPayload,
      routeSlug: "plain",
      secretToken: built.secretToken,
      sourceType: "note",
    });

    const outer = JSON.stringify(artifact);
    expect(artifact.version).toBe(2);
    expect(artifact).not.toHaveProperty("assets");
    expect(artifact.requiredCapabilities).toBeUndefined();
    expect(outer).not.toContain("gno-asset:");
    expect(outer).not.toContain(markdown);
    expect(outer).not.toContain("image/png");
    expect(outer).not.toContain(PNG_ASSET.data);
    expectContractClassification(artifact, "asset-free");

    const decrypted =
      await decryptEncryptedArtifactPayload<EncryptedReaderSpaceData>(
        PASSPHRASE,
        built.encryptedPayload
      );
    expect(decrypted.assets).toBeUndefined();
    expect(decrypted.requiredCapabilities).toBeUndefined();
    expect(decrypted.assetManifest).toEqual([]);
    expect(decrypted.noteCards[0]?.blocks[0]).toMatchObject({
      type: "markdown",
      markdown: markdown.trim(),
    });

    const schema = await loadSchema("publish-artifact");
    expect(assertValid(artifact, schema)).toBe(true);
  });

  test("asset-bearing payload encrypts assets inside plaintext only", async () => {
    const sentinel = `gno-asset:${PNG_SHA256}`;
    const markdown = `# Atlas\n\n![dot](${sentinel})\n`;
    const built = await buildEncryptedArtifactPayload({
      assets: [PNG_ASSET],
      exportedAt: "2026-08-03T12:00:00.000Z",
      notes: [
        {
          markdown,
          slug: "atlas",
          summary: "Atlas note.",
          title: "Atlas",
        },
      ],
      passphrase: PASSPHRASE,
      routeSlug: "atlas",
      sourceType: "note",
      summary: "Atlas note.",
      title: "Atlas",
    });

    const artifact = buildEncryptedPublishArtifact({
      encryptedPayload: built.encryptedPayload,
      requiredCapabilities: [BUNDLED_RASTER_ASSETS_CAPABILITY],
      routeSlug: "atlas",
      secretToken: built.secretToken,
      sourceType: "note",
    });

    const outer = JSON.stringify(artifact);
    expect(artifact.version).toBe(2);
    expect(artifact).not.toHaveProperty("assets");
    expect(artifact.requiredCapabilities).toEqual([
      BUNDLED_RASTER_ASSETS_CAPABILITY,
    ]);
    expect(outer).not.toContain("gno-asset:");
    expect(outer).not.toContain(PNG_ASSET.data);
    expect(outer).not.toContain("dot.png");
    expect(outer).not.toContain(markdown);
    expectContractClassification(artifact, "encrypted-client-payload");
    expect(measureArtifactUploadBytes(artifact)).toBe(
      new TextEncoder().encode(serializePublishArtifact(artifact)).byteLength
    );

    const decrypted =
      await decryptEncryptedArtifactPayload<EncryptedReaderSpaceData>(
        PASSPHRASE,
        built.encryptedPayload
      );
    expect(decrypted.requiredCapabilities).toEqual([
      BUNDLED_RASTER_ASSETS_CAPABILITY,
    ]);
    expect(decrypted.assets).toEqual([PNG_ASSET]);
    expect(decrypted.assetManifest).toEqual([]);
    const block = decrypted.noteCards[0]?.blocks[0];
    expect(block?.type).toBe("markdown");
    if (block?.type === "markdown") {
      expect(block.markdown).toContain(sentinel);
    }

    const schema = await loadSchema("publish-artifact");
    expect(assertValid(artifact, schema)).toBe(true);
  });

  test("wrong passphrase and tampered ciphertext reject decrypt", async () => {
    const built = await buildEncryptedArtifactPayload({
      assets: [PNG_ASSET],
      exportedAt: "2026-08-03T12:00:00.000Z",
      notes: [
        {
          markdown: `![dot](gno-asset:${PNG_SHA256})`,
          slug: "atlas",
          summary: "Atlas",
          title: "Atlas",
        },
      ],
      passphrase: PASSPHRASE,
      routeSlug: "atlas",
      sourceType: "note",
      summary: "Atlas",
      title: "Atlas",
    });

    await expectDecryptRejects("wrong passphrase", built.encryptedPayload);

    const firstCiphertextCharacter = built.encryptedPayload.ciphertext[0];
    const tampered = {
      ...built.encryptedPayload,
      ciphertext: `${firstCiphertextCharacter === "A" ? "B" : "A"}${built.encryptedPayload.ciphertext.slice(1)}`,
    };
    await expectDecryptRejects(PASSPHRASE, tampered);
  });
});
