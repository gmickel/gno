/**
 * Integration tests for publish export attachment bundling.
 */
import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises — structural ops; no Bun equivalent
import { mkdtemp, rm, writeFile } from "node:fs/promises";
// node:os tmpdir — no Bun equivalent
import { tmpdir } from "node:os";
// node:path join — no Bun path utils
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type { DocumentRow, StorePort, TagRow } from "../../src/store/types";

import {
  BUNDLED_RASTER_ASSETS_CAPABILITY,
  measureArtifactUploadBytes,
  measureSerializedUploadBytes,
  serializePublishArtifact,
  validatePublishAssetContract,
} from "../../src/publish/artifact-assets";
import { exportPublishArtifact } from "../../src/publish/export-service";
import { ok } from "../../src/store/types";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const PNG_1X1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  ),
  (c) => c.charCodeAt(0)
);

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (!root) continue;
    await rm(root, { recursive: true, force: true });
  }
});

const buildDocument = (
  overrides: Partial<DocumentRow> & Pick<DocumentRow, "id" | "relPath">
): DocumentRow => ({
  active: true,
  collection: "atlas",
  converterId: "markdown",
  converterVersion: "1",
  createdAt: "2026-08-03T10:00:00.000Z",
  docid: `#${overrides.id.toString().padStart(8, "0")}`,
  ingestVersion: 1,
  languageHint: "en",
  lastErrorAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  mirrorHash: overrides.id.toString().repeat(64).slice(0, 64),
  sourceExt: ".md",
  sourceHash: (overrides.id + 2).toString().repeat(64).slice(0, 64),
  sourceMime: "text/markdown",
  sourceMtime: "2026-08-03T10:00:00.000Z",
  sourceSize: 100,
  title: null,
  updatedAt: "2026-08-03T10:00:00.000Z",
  uri: `gno://atlas/${overrides.relPath}`,
  ...overrides,
});

describe("exportPublishArtifact attachment bundling", () => {
  test("bundles local rasters into v1 artifacts with assetSummary", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-export-attach-"));
    roots.push(root);
    await writeFile(join(root, "dot.png"), PNG_1X1);

    const published = buildDocument({
      id: 1,
      relPath: "home.md",
      title: "Home",
    });
    const markdown =
      "# Home\n\n![[dot.png]]\n![ext](https://cdn.example/x.png)\n";
    const content = new Map([[published.mirrorHash!, markdown]]);
    const tags = new Map<number, TagRow[]>([[published.id, []]]);
    const store = {
      getDocument: async () => ok(null),
      getDocumentByDocid: async () => ok(null),
      getDocumentByUri: async () => ok(null),
      getContent: async () => ok(null),
      getTagsForDoc: async () => ok([]),
      appendEgressAuditReceiptWithRetention: async () =>
        ok("inserted" as const),
      enforceEgressAuditRetention: async () =>
        ok({ deleted: 0, remainingReceipts: 1, remainingBytes: 128 }),
      getContentBatch: async () => ok(content),
      getTagsBatch: async () => ok(tags),
      listDocuments: async () => ok([published]),
    } as unknown as StorePort;
    const collections: Collection[] = [
      {
        exclude: [],
        include: [],
        name: "atlas",
        path: root,
        pattern: "**/*",
      },
    ];

    const { artifact, assetSummary, warnings } = await exportPublishArtifact({
      collections,
      options: { routeSlug: "atlas", visibility: "public" },
      store,
      target: "atlas",
    });

    expect(artifact.version).toBe(1);
    if (artifact.version !== 1) throw new Error("expected v1");
    expect(artifact.requiredCapabilities).toEqual([
      BUNDLED_RASTER_ASSETS_CAPABILITY,
    ]);
    expect(artifact.assets?.length).toBe(1);
    expect(artifact.spaces[0]?.notes[0]?.markdown).toContain("gno-asset:");
    expect(artifact.spaces[0]?.notes[0]?.markdown).toContain(
      "https://cdn.example/x.png"
    );
    expect(assetSummary.assetCount).toBe(1);
    expect(assetSummary.externalCount).toBe(1);
    expect(assetSummary.referenceCount).toBe(1);
    expect(assetSummary.rawBytes).toBe(PNG_1X1.byteLength);
    expect(assetSummary.dedupSavedBytes).toBe(0);
    expect(typeof assetSummary.encodedBytes).toBe("number");
    expect(assetSummary.encodedBytes).toBeGreaterThan(0);
    expect(assetSummary.finalUploadBytes).toBe(
      measureArtifactUploadBytes(artifact)
    );
    expect(assetSummary.finalUploadBytes).toBe(
      measureSerializedUploadBytes(serializePublishArtifact(artifact))
    );
    expect(assetSummary.finalUploadBytes).toBeGreaterThan(
      measureSerializedUploadBytes(JSON.stringify(artifact))
    );
    expect(Array.isArray(assetSummary.diagnostics)).toBe(true);
    expect(warnings.some((w) => w.kind === "image-embed-dropped")).toBe(false);
    expect(validatePublishAssetContract(artifact).ok).toBe(true);
    const schema = await loadSchema("publish-artifact");
    expect(assertValid(artifact, schema)).toBe(true);
  });

  test("preserves legacy asset-free behavior when no local images exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-export-free-"));
    roots.push(root);

    const published = buildDocument({
      id: 2,
      relPath: "plain.md",
      title: "Plain",
    });
    const markdown = "# Plain\n\nNo images here.\n";
    const content = new Map([[published.mirrorHash!, markdown]]);
    const tags = new Map<number, TagRow[]>([[published.id, []]]);
    const store = {
      getDocument: async () => ok(null),
      getDocumentByDocid: async () => ok(null),
      getDocumentByUri: async () => ok(null),
      getContent: async () => ok(null),
      getTagsForDoc: async () => ok([]),
      appendEgressAuditReceiptWithRetention: async () =>
        ok("inserted" as const),
      enforceEgressAuditRetention: async () =>
        ok({ deleted: 0, remainingReceipts: 1, remainingBytes: 128 }),
      getContentBatch: async () => ok(content),
      getTagsBatch: async () => ok(tags),
      listDocuments: async () => ok([published]),
    } as unknown as StorePort;

    const { artifact, assetSummary } = await exportPublishArtifact({
      collections: [
        {
          exclude: [],
          include: [],
          name: "atlas",
          path: root,
          pattern: "**/*",
        },
      ],
      options: { routeSlug: "plain", visibility: "public" },
      store,
      target: "atlas",
    });

    expect(artifact.version).toBe(1);
    if (artifact.version !== 1) throw new Error("expected v1");
    expect(artifact.assets).toBeUndefined();
    expect(artifact.requiredCapabilities).toBeUndefined();
    expect(assetSummary).toEqual({
      assetCount: 0,
      dedupSavedBytes: 0,
      diagnostics: [],
      encodedBytes: 0,
      externalCount: 0,
      finalUploadBytes: measureArtifactUploadBytes(artifact),
      rawBytes: 0,
      referenceCount: 0,
    });
    expect(validatePublishAssetContract(artifact).ok).toBe(true);
    const schema = await loadSchema("publish-artifact");
    expect(assertValid(artifact, schema)).toBe(true);
  });

  test("bundles rasters into encrypted v2 plaintext with truthful assetSummary", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-export-enc-"));
    roots.push(root);
    await writeFile(join(root, "dot.png"), PNG_1X1);

    const published = buildDocument({
      id: 3,
      relPath: "home.md",
      title: "Home",
    });
    const markdown =
      "# Home\n\n![[dot.png]]\n![ext](https://cdn.example/x.png)\n";
    const content = new Map([[published.mirrorHash!, markdown]]);
    const tags = new Map<number, TagRow[]>([[published.id, []]]);
    const store = {
      getDocument: async () => ok(null),
      getDocumentByDocid: async () => ok(null),
      getDocumentByUri: async () => ok(null),
      getContent: async () => ok(null),
      getTagsForDoc: async () => ok([]),
      appendEgressAuditReceiptWithRetention: async () =>
        ok("inserted" as const),
      enforceEgressAuditRetention: async () =>
        ok({ deleted: 0, remainingReceipts: 1, remainingBytes: 128 }),
      getContentBatch: async () => ok(content),
      getTagsBatch: async () => ok(tags),
      listDocuments: async () => ok([published]),
    } as unknown as StorePort;

    const { artifact, assetSummary } = await exportPublishArtifact({
      collections: [
        {
          exclude: [],
          include: [],
          name: "atlas",
          path: root,
          pattern: "**/*",
        },
      ],
      options: {
        encryptionPassphrase: "correct horse battery staple",
        routeSlug: "locked-home",
        visibility: "encrypted",
      },
      store,
      target: "atlas",
    });

    expect(artifact.version).toBe(2);
    if (artifact.version !== 2) throw new Error("expected v2");
    expect(artifact).not.toHaveProperty("assets");
    expect(artifact.requiredCapabilities).toEqual([
      BUNDLED_RASTER_ASSETS_CAPABILITY,
    ]);
    const outer = JSON.stringify(artifact);
    expect(outer).not.toContain("gno-asset:");
    expect(outer).not.toContain("dot.png");
    expect(outer).not.toContain("image/png");
    expect(assetSummary.assetCount).toBe(1);
    expect(assetSummary.externalCount).toBe(1);
    expect(assetSummary.referenceCount).toBe(1);
    expect(assetSummary.rawBytes).toBe(PNG_1X1.byteLength);
    expect(assetSummary.encodedBytes).toBeGreaterThan(0);
    expect(assetSummary.finalUploadBytes).toBe(
      measureArtifactUploadBytes(artifact)
    );
    const contract = validatePublishAssetContract(artifact);
    expect(contract.ok).toBe(true);
    if (!contract.ok) {
      throw new Error(`expected contract ok, got ${contract.diagnostic.code}`);
    }
    expect(contract.classification).toBe("encrypted-client-payload");
    const schema = await loadSchema("publish-artifact");
    expect(assertValid(artifact, schema)).toBe(true);
  });
});
